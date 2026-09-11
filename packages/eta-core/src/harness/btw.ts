/**
 * btw side-channel (C8). A thread runs beside the main conversation:
 * contextual threads seed from the main session minus every visible
 * `eta.btw` message (so side chatter never compounds), tangent threads start
 * empty. Answered exchanges replay back as plain user/assistant pairs — one
 * transcript model, no second one. Persistence rides `eta.btw` CustomEntries;
 * handoff into the main run uses the same followUp driver as goals and loops.
 *
 * A question is `pending` from the moment it is asked until the side request
 * resolves. The side request is a standalone model call — no lane, no run — so
 * it answers while the main agent is busy, and a failure clears the pending
 * question instead of storing a fake answer that would replay forever.
 */

import type { Api, AssistantMessage, Model, Models, Usage } from "@earendil-works/pi-ai";
import type { AgentMessage, ThinkingLevel } from "../types.ts";
import type { Context as LaneContext } from "./context.ts";
import type { EtaEmit } from "./events.ts";
import type { BtwPayload } from "./session/types.ts";
import { btwHandoff, btwSystemPrompt } from "../prompts/index.ts";
import { completeSimpleWithRetries, createSummaryRequestOptions } from "./compaction/compaction.ts";
import { convertToLlm } from "./messages.ts";

export type BtwSaveState = "not-saved" | "queued" | "saved";

export interface BtwExchange {
	question: string;
	answer: string;
	at: number;
}

/** A question sent to the side model that has not been answered yet. */
export interface BtwPending {
	question: string;
	at: number;
}

export interface BtwThread {
	id: string;
	kind: "contextual" | "tangent";
	exchanges: BtwExchange[];
	saveState: BtwSaveState;
	/** Set while the side request is in flight; the panel shows it as "waiting". */
	pending?: BtwPending;
	/** Why the last side request did not answer; cleared by the next question. */
	error?: string;
	model?: string;
	thinking?: string;
	/** Bumped whenever an override forces the child session to be rebuilt. */
	assemblyVersion: number;
}

type BuildContext = (entries: unknown[], leafId: string | null) => { messages: AgentMessage[] };

/** One side request, as the thread describes it. */
export interface BtwSideRequest {
	threadId: string;
	kind: BtwThread["kind"];
	question: string;
	/** Seed plus answered pairs, in order — the whole side conversation. */
	messages: AgentMessage[];
	model?: string;
	thinking?: string;
}

/** How a thread gets answered: one standalone model request, no lane, no run. */
export type BtwSideAsk = (request: BtwSideRequest) => Promise<string>;

export interface BtwSideAskDeps {
	models: Models;
	/** The session's current model; a thread with no override inherits it. */
	currentModel: () => Promise<Model<Api> | undefined>;
	context: LaneContext;
}

/**
 * The stock side ask: one `completeSimple` over the thread's own messages, on
 * the same provider registry the lane uses. Standalone on purpose — a side
 * answer costs no lane slot and no run, so it lands while the main agent is
 * mid-turn, which is the whole point of the channel. Text-level failure becomes
 * a rejected promise so the thread records `error`, not a fake answer.
 */
export function btwSideAsk(deps: BtwSideAskDeps): BtwSideAsk {
	return async (request) => {
		const model = await resolveSideModel(deps, request.model);
		const reasoning = sideReasoning(request.thinking);
		const askMessage: AgentMessage = {
			role: "user",
			content: [{ type: "text", text: request.question }],
			timestamp: Date.now(),
		} as AgentMessage;
		const response = await completeSimpleWithRetries(
			deps.models,
			model,
			{
				systemPrompt: btwSystemPrompt(request.kind),
				messages: convertToLlm([...request.messages, askMessage]),
			},
			createSummaryRequestOptions(
				{ maxTokens: SIDE_MAX_TOKENS, ...(reasoning === undefined ? {} : { reasoning }) },
				deps.context,
			),
			undefined,
			undefined,
			deps.context,
		);
		const text = textOf(response);
		if (response.stopReason === "error" || text.length === 0) {
			throw new Error(response.errorMessage ?? "the side request returned no text");
		}
		return text;
	};
}

const SIDE_MAX_TOKENS = 2048;

function resolveSideModel(deps: BtwSideAskDeps, override: string | undefined): Promise<Model<Api>> {
	return (async () => {
		if (override !== undefined) {
			const separator = override.indexOf(":");
			const found =
				separator < 0
					? deps.models.getModels().find((model) => model.id === override)
					: deps.models.getModel(override.slice(0, separator), override.slice(separator + 1));
			if (found !== undefined) return found;
		}
		const current = await deps.currentModel();
		if (current === undefined) throw new Error("no model resolved for the side request");
		return current;
	})();
}

/** `off` means "no thinking", which the provider-level option spells by omission. */
function sideReasoning(thinking: string | undefined): Exclude<ThinkingLevel, "off"> | undefined {
	if (thinking === undefined || thinking === "off") return undefined;
	return thinking as Exclude<ThinkingLevel, "off">;
}

function textOf(message: AssistantMessage): string {
	return message.content
		.filter((part) => part.type === "text")
		.map((part) => ("text" in part ? part.text : ""))
		.join("\n")
		.trim();
}

/** Legacy CustomEntry-shaped btw notes; first-class `btw` entries carry no message. */
function isVisibleBtw(entry: unknown): boolean {
	const e = entry as { role?: string; customType?: string };
	return e?.role === "custom" && e.customType === "eta.btw";
}

const NO_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function sideUser(text: string, at: number): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: at } as AgentMessage;
}

/**
 * A replayed side answer, built as a real assistant message rather than a bare
 * string: the thread goes out through the same provider path as the main one,
 * and adapters read assistant content as blocks.
 */
function sideAssistant(text: string, at: number, model: string | undefined): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "unknown",
		provider: "unknown",
		model: model ?? "btw",
		usage: NO_USAGE,
		stopReason: "stop",
		timestamp: at,
	} as unknown as AgentMessage;
}

export class BtwManager {
	private threads = new Map<string, BtwThread>();
	private sequence = 0;
	/** Seed cache per thread; contextual threads rebuild it from entries. */
	private seeds = new Map<string, AgentMessage[]>();

	private readonly buildContext: BuildContext;
	private readonly onVisibleNote?: (note: string) => void | Promise<void>;
	private readonly observe: EtaEmit | undefined;
	private readonly sideAsk: BtwSideAsk | undefined;

	constructor(
		buildContext: BuildContext,
		onVisibleNote?: (note: string) => void | Promise<void>,
		observe?: EtaEmit,
		sideAsk?: BtwSideAsk,
	) {
		this.buildContext = buildContext;
		this.onVisibleNote = onVisibleNote;
		this.observe = observe;
		this.sideAsk = sideAsk;
	}

	create(kind: BtwThread["kind"], overrides: { model?: string; thinking?: string } = {}): BtwThread {
		const thread: BtwThread = {
			id: `btw-${++this.sequence}`,
			kind,
			exchanges: [],
			saveState: "not-saved",
			model: overrides.model,
			thinking: overrides.thinking,
			assemblyVersion: 1,
		};
		this.threads.set(thread.id, thread);
		this.observe?.("btw", "opened", { threadId: thread.id, kind: thread.kind });
		return thread;
	}

	get(id: string): BtwThread | undefined {
		return this.threads.get(id);
	}

	list(): BtwThread[] {
		return [...this.threads.values()];
	}

	/** Seed = main-session context without any visible btw message; on context
	 * failure fall back to visible entries directly (both branches from pi-btw). */
	seedFrom(threadId: string, entries: unknown[], leafId: string | null): void {
		const thread = this.threads.get(threadId);
		if (thread === undefined || thread.kind !== "contextual") return;
		try {
			this.seeds.set(
				threadId,
				this.buildContext(entries, leafId).messages.filter((m) => !isVisibleBtw(m)),
			);
		} catch {
			this.seeds.set(
				threadId,
				entries.filter(
					(e) =>
						typeof (e as { role?: unknown }).role === "string" &&
						Array.isArray((e as { content?: unknown }).content) &&
						!isVisibleBtw(e),
				) as AgentMessage[],
			);
		}
	}

	/** What the side session sends: seed + answered Q/A pairs replayed inline. */
	messagesFor(threadId: string): AgentMessage[] {
		const thread = this.threads.get(threadId);
		if (thread === undefined) return [];
		const messages: AgentMessage[] = [...(this.seeds.get(threadId) ?? [])];
		for (const ex of thread.exchanges) {
			messages.push(sideUser(ex.question, ex.at), sideAssistant(ex.answer, ex.at + 1, thread.model));
		}
		return messages;
	}

	/**
	 * Ask the side model and let the thread carry the wait: `pending` while the
	 * request runs, an answered exchange when it lands, `error` when it does not.
	 * Nothing here takes the lane, so a question can be answered mid-run.
	 */
	async ask(threadId: string, question: string): Promise<void> {
		const thread = this.threads.get(threadId);
		if (thread === undefined) return;
		const sideAsk = this.sideAsk;
		if (sideAsk === undefined) {
			this.fail(threadId, "no side model configured for this session");
			return;
		}
		const request: BtwSideRequest = {
			threadId,
			kind: thread.kind,
			question,
			messages: this.messagesFor(threadId),
			...(thread.model === undefined ? {} : { model: thread.model }),
			...(thread.thinking === undefined ? {} : { thinking: thread.thinking }),
		};
		this.begin(threadId, question);
		try {
			const answer = await sideAsk(request);
			// The thread can be cleared while its request is in flight.
			if (!this.threads.has(threadId)) return;
			this.answer(threadId, question, answer);
		} catch (error) {
			if (this.threads.has(threadId))
				this.fail(threadId, error instanceof Error ? error.message : String(error));
		}
	}

	/** Record a question as in flight; the answer arrives later via `answer`/`fail`. */
	begin(threadId: string, question: string): void {
		const thread = this.threads.get(threadId);
		if (thread === undefined) return;
		thread.pending = { question, at: Date.now() };
		thread.error = undefined;
		this.observe?.("btw", "asking", { threadId });
	}

	answer(threadId: string, question: string, answer: string): void {
		const thread = this.threads.get(threadId);
		if (thread === undefined) return;
		thread.pending = undefined;
		thread.error = undefined;
		thread.exchanges.push({ question, answer, at: Date.now() });
		this.observe?.("btw", "injected", { threadId });
	}

	/** A failed side request leaves no exchange behind — a fake answer would replay as truth. */
	fail(threadId: string, message: string): void {
		const thread = this.threads.get(threadId);
		if (thread === undefined) return;
		thread.pending = undefined;
		thread.error = message;
		this.observe?.("btw", "failed", { threadId, message });
	}

	/**
	 * Save the thread's last exchange as a visible note in the main session.
	 * While the main run is busy the note queues and flushes at run end.
	 */
	save(threadId: string, running: boolean): BtwSaveState {
		const thread = this.threads.get(threadId);
		if (thread === undefined) return "not-saved";
		if (running) {
			thread.saveState = "queued";
			return thread.saveState;
		}
		void this.flushNote(thread);
		return thread.saveState;
	}

	/** Called at run boundaries: writes notes queued while the run was busy. */
	async flushQueued(): Promise<number> {
		let flushed = 0;
		for (const thread of this.threads.values()) {
			if (thread.saveState === "queued") {
				await this.flushNote(thread);
				flushed += 1;
			}
		}
		return flushed;
	}

	private async flushNote(thread: BtwThread): Promise<void> {
		const last = thread.exchanges[thread.exchanges.length - 1];
		if (last !== undefined) await this.onVisibleNote?.(`btw ${thread.id}: ${last.question} -> ${last.answer}`);
		thread.saveState = "saved";
		this.observe?.("btw", "saved", { threadId: thread.id });
	}

	/** Drop a thread from the panel; history written to the log stays. */
	clear(threadId: string): boolean {
		const had = this.threads.delete(threadId);
		if (had) this.observe?.("btw", "cleared", { threadId });
		return had;
	}

	/** FollowUp text handed to the main run (handoff = S1 driver). */
	handoff(threadId: string): string | undefined {
		const thread = this.threads.get(threadId);
		if (thread === undefined || thread.exchanges.length === 0) return undefined;
		this.observe?.("btw", "summarized", { threadId });
		return btwHandoff(thread.id);
	}

	/** Override changes rebuild the child session but never lose the thread. */
	setOverride(threadId: string, overrides: { model?: string; thinking?: string }): void {
		const thread = this.threads.get(threadId);
		if (thread === undefined) return;
		if (overrides.model !== undefined && overrides.model !== thread.model) thread.assemblyVersion += 1;
		if (overrides.thinking !== undefined && overrides.thinking !== thread.thinking) thread.assemblyVersion += 1;
		thread.model = overrides.model ?? thread.model;
		thread.thinking = overrides.thinking ?? thread.thinking;
	}

	/** Re-register threads from a replayed `eta.btw` entry log. */
	replay(entries: { type: string; payload: unknown }[]): void {
		for (const entry of entries) {
			if (entry.type !== "btw") continue;
			const payload = entry.payload as BtwPayload & Partial<BtwThread>;
			if (typeof payload?.note !== "string") continue;
			const id = payload.id ?? `btw-replay-${++this.sequence}`;
			const existing = this.threads.get(id);
			if (existing === undefined) {
				this.threads.set(id, {
					id,
					kind: payload.kind ?? "tangent",
					exchanges: payload.exchanges ?? [],
					saveState: payload.saveState ?? "saved",
					model: payload.model,
					thinking: payload.thinking,
					assemblyVersion: payload.assemblyVersion ?? 1,
				});
			}
		}
	}
}
