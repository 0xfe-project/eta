/**
 * The SessionView projector: one serializable snapshot of everything a front-end
 * renders — transcript, thinking, goal, tasks, loops, side threads, usage,
 * cache rate, branch position, pending question. Attaching means: snapshot
 * first, then incremental updates driven by the main event bus. Two front-ends
 * attached to the same agent converge to the same view.
 */

import type { Usage } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT, type Context } from "./context.ts";
import type { AgentMessage } from "../types.ts";
import type { AskPayload } from "./entries.ts";
import type { EtaAgent } from "./agent.ts";
import type { GoalState } from "./goal.ts";
import type { LoopSpec } from "./loops.ts";
import type { BtwThread } from "./btw.ts";
import type { StoredTask } from "./task-store.ts";

export interface SessionViewMessage {
	entryId: string;
	seq: number;
	message: AgentMessage;
}

export interface SessionViewLoop {
	id: string;
	note: string;
	every?: string;
	cron?: string;
	runCount: number;
	paused: boolean;
	nextDueAt?: number;
}

export interface SessionViewSystemRow {
	entryId: string;
	seq: number;
	kind: "goal" | "ask" | "btw" | "compaction" | "merge";
	/** Display parameters; the client renders them (i18n lives in the frontend). */
	args: Record<string, string>;
}

export interface SessionViewSubagent {
	id: string;
	status: string;
	turns: number;
}

export interface SessionView {
	messages: SessionViewMessage[];
	systems: SessionViewSystemRow[];
	thinking: string[];
	compactionEpoch: number;
	memory: { chars: number } | undefined;
	subagents: SessionViewSubagent[];
	goal: GoalState | undefined;
	tasks: StoredTask[];
	loops: SessionViewLoop[];
	sideThread: Pick<BtwThread, "id" | "kind" | "exchanges" | "saveState">[];
	usage: Usage;
	cacheRate: number;
	branch: { tipId: string | null };
	pendingAsk: AskPayload | undefined;
	/** Deadline of the pending ask when it carries a timeout; drives the modal countdown. */
	pendingAskDeadline?: number;
	/** KV keys the state tools have set; shown and deletable in the Context panel. */
	stateKeys: string[];
	/** Persona card names baked into the stable prompt block; empty when none. */
	personas: string[];
	/** System prompt block sizes for the Context panel; undefined before the first generation. */
	prompt: { stableChars: number; adaptiveChars: number; sections: { name: string; stable: boolean; text: string }[] } | undefined;
	/** Output tokens/sec over the last usage delta; 0 until two usage events pass. */
	tokensPerSec: number;
	/** Configured model as "provider:modelId"; drives the composer model picker. */
	model: string;
}

export type ViewListener = (view: SessionView) => void;

const VIEW_EVENTS = ["entry_added", "eta", "usage", "run_end", "compaction_end", "navigation_end"] as const;

export class SessionViewProjector {
	private readonly agent: EtaAgent;

	constructor(agent: EtaAgent) {
		this.agent = agent;
	}

	async snapshot(context: Context = BACKGROUND_CONTEXT): Promise<SessionView> {
		const { lane, goal, tasks, loops, btw, ask } = this.agent;
		const entries = await lane.findEntries({ order: "oldestFirst" }, context);
		let modelLabel = "unknown";
		try {
			const execution = await lane.inspectExecution(context);
			modelLabel = `${execution.configuredModel.provider}:${execution.configuredModel.modelId}`;
		} catch {
			/* harness not inspectable yet */
		}
		const messages: SessionViewMessage[] = [];
		const systems: SessionViewSystemRow[] = [];
		const thinking: string[] = [];
		let compactionEpoch = 0;
		for (const entry of entries) {
			if (entry.type === "message") {
				messages.push({ entryId: entry.id, seq: entry.seq, message: entry.message });
				const content = (entry.message as { content?: unknown }).content;
				if (Array.isArray(content)) {
					for (const block of content as { type?: string; thinking?: string }[]) {
						if (block.type === "thinking" && typeof block.thinking === "string") thinking.push(block.thinking);
					}
				}
				continue;
			}
			if (entry.type === "compaction") {
				compactionEpoch += 1;
				systems.push({ entryId: entry.id, seq: entry.seq, kind: "compaction", args: { epoch: String(compactionEpoch), summary: entry.summary.slice(0, 120) } });
				continue;
			}
			if (entry.type === "merge") {
				systems.push({ entryId: entry.id, seq: entry.seq, kind: "merge", args: { summary: entry.summary } });
				continue;
			}
			if (entry.type === "goal") {
				const payload = entry.payload;
				systems.push({ entryId: entry.id, seq: entry.seq, kind: "goal", args: { action: payload.kind, ...(payload.objective === undefined ? {} : { objective: payload.objective }) } });
				continue;
			}
			if (entry.type === "ask") {
				systems.push({ entryId: entry.id, seq: entry.seq, kind: "ask", args: { question: entry.payload.question } });
				continue;
			}
			if (entry.type === "btw") {
				systems.push({ entryId: entry.id, seq: entry.seq, kind: "btw", args: { note: entry.payload.note } });
			}
		}
		const pending = ask.pendingAsks();
		const stats = await lane.getStats(context);
		const specView = (spec: LoopSpec): SessionViewLoop => ({
			id: spec.def.id,
			note: spec.def.note,
			...(spec.def.every === undefined ? {} : { every: spec.def.every }),
			...(spec.def.cron === undefined ? {} : { cron: spec.def.cron }),
			runCount: spec.runCount,
			paused: spec.paused,
			...(spec.nextDueAt === undefined ? {} : { nextDueAt: spec.nextDueAt }),
		});
		const stateKeys = await this.agent.stateKv.keys().catch(() => []);
		return {
			stateKeys,
			messages,
			systems,
			thinking,
			compactionEpoch,
			memory: await this.agent.memoryInfo?.(),
			subagents: this.agent.subagents.list().map((r) => ({ id: r.id, status: r.status, turns: r.turns })),
			goal: goal.current,
			tasks: tasks.list(),
			loops: loops.list().map(specView),
			sideThread: btw.list().map((thread) => ({ id: thread.id, kind: thread.kind, exchanges: thread.exchanges, saveState: thread.saveState })),
			usage: stats.usage,
			cacheRate: cacheRate(stats.usage),
			branch: { tipId: entries[entries.length - 1]?.id ?? null },
			pendingAsk: pending[0],
			...(pending[0] === undefined ? {} : { pendingAskDeadline: ask.deadline(pending[0].questionId) }),
			personas: this.agent.personas,
			prompt: this.agent.lastPromptBlocks,
			tokensPerSec: this.agent.tokensPerSec,
			model: modelLabel,
		};
	}

	/** Snapshot first, then an update on every bus event that can change the view. */
	async attach(listener: ViewListener, context: Context = BACKGROUND_CONTEXT): Promise<{ view: SessionView; detach(): void }> {
		const offs: (() => void)[] = [];
		let queued = false;
		const refresh = () => {
			if (queued) return;
			queued = true;
			void this.snapshot(context)
				.then(listener)
				.catch(() => undefined)
				.finally(() => {
					queued = false;
				});
		};
		for (const type of VIEW_EVENTS) offs.push(this.agent.harness.events.on(type, refresh));
		return { view: await this.snapshot(context), detach: () => offs.forEach((off) => off()) };
	}
}

function cacheRate(usage: Usage): number {
	const readable = usage.input + usage.cacheRead;
	return readable === 0 ? 0 : usage.cacheRead / readable;
}
