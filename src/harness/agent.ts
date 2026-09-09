/**
 * The integrated agent: one harness, one event stream, one entry log. EtaAgent
 * owns every battery (goal, loops, ask, tasks, state, btw, subagents) as
 * internal state, wires the run-end drivers, composes the system prompt from
 * live state, and publishes battery observations as `eta` events on the main
 * HarnessEvent bus. There is no second bus, no bridge, no plugin surface.
 */

import type { Api, Model, Models } from "@earendil-works/pi-ai";
import type { AgentMessage } from "../types.ts";
import { BACKGROUND_CONTEXT, type Context } from "./context.ts";
import { AgentHarness, type AgentLane } from "./agent-harness.ts";
import { loopFollowUp } from "../prompts/index.ts";
import { loopState, loopStateInventoryPrefix, taskState, type Value } from "./session/values.ts";
import type { PendingEntry, StoredTask, TaskStatus } from "./session/types.ts";
import { applyGoalEntries } from "./goal.ts";
import type { AgentHarnessTool } from "./types.ts";
import type { Session } from "./session/types.ts";
import type { EtaEmit } from "./events.ts";
import { composeEtaSystemPrompt, etaPromptBlockChars, etaPromptSectionsDetailed, type EtaPromptSection } from "./composer.ts";
import { AskRegistry, createAskUserTool, type HeadlessAsk } from "./ask.ts";
import { BtwManager } from "./btw.ts";
import { answerEntry, askEntry, btwEntry, goalEntry, type GoalPayload } from "./entries.ts";
import { GoalManager } from "./goal.ts";
import { LoopScheduler, type LoopSpec } from "./loops.ts";
import { emptyResponseGuard, goalDriver, loopDriver, startLoopHeartbeat } from "./drivers.ts";
import { SubagentManager, type SubagentBus, type SubagentBusEvent, type SubagentRunner } from "./subagent.ts";
import { TaskStore } from "./task-store.ts";
import {
	createLoopTools,
	createReminderHooks,
	createScheduleTool,
	createStateTools,
	createSubagentTools,
	createTaskTools,
	type StateKV,
} from "./tools/index.ts";

export interface EtaAgentOptions {
	session: Session;
	models: Models;
	model: Model<Api>;
	laneName?: string;
	baseSystemPrompt?: string;
	/** Persona cards baked into the stable prompt block (renderPersonaBlock output). */
	persona?: { names: string[]; text: string };
	/** Extra tools the caller owns (merged with the battery tools). */
	tools?: readonly AgentHarnessTool<object | undefined>[];
	/** Independent goal judge; true = achieved. */
	evaluateGoal?: (objective: string) => Promise<boolean>;
	askTimeoutMs?: number;
	/** No interactive UI: ask_user degrades to this text protocol; null = no answer. */
	askHeadless?: HeadlessAsk;
	/** Where loop registry values persist; default: custom entry `eta_loop_state`. */
	persistLoop?: (spec: LoopSpec) => void;
	kv?: StateKV;
	subagentRunner?: SubagentRunner;
	poolSize?: number;
	/** Loop heartbeat interval in ms; 0 disables. Default 30s. */
	heartbeatMs?: number;
	/** Stable <memory> block source (e.g. MemoryCache.load); re-injected every generation. */
	memorySource?: () => string | Promise<string>;
}

const memoryKv = (): StateKV => {
	const map = new Map<string, string>();
	return {
		get: async (key) => map.get(key),
		set: async (key, value) => {
			if (value === null) map.delete(key);
			else map.set(key, value);
		},
		keys: async () => [...map.keys()],
	};
};

const goalPayloadFor = (change: { goal: { objective: string; status: string }; from: string }): GoalPayload => {
	switch (change.goal.status) {
		case "achieved":
			return { kind: "achieved", objective: change.goal.objective };
		case "paused":
			return { kind: "pause" };
		default:
			return change.from === "none" || change.from === "achieved"
				? { kind: "set", objective: change.goal.objective }
				: { kind: "resume" };
	}
};

export class EtaAgent {
	readonly harness: AgentHarness;
	readonly lane: AgentLane;
	readonly goal: GoalManager;
	readonly tasks: TaskStore;
	readonly loops: LoopScheduler;
	readonly ask: AskRegistry;
	readonly btw: BtwManager;
	readonly subagents: SubagentManager;
	/** The KV surface the state tools operate on; the Context panel lists it. */
	readonly stateKv: StateKV;
		/** All tools the harness runs: battery surface plus caller extras. */
	readonly agentTools: AgentHarnessTool<object | undefined>[];
	/** Persona card names baked into the stable prompt block; empty when none. */
	personas: string[] = [];
	/** Prompt block sizes from the last generation; undefined until the first one. */
	private lastPromptBlocksValue: { stableChars: number; adaptiveChars: number; sections: EtaPromptSection[] } | undefined = undefined;

	get lastPromptBlocks(): { stableChars: number; adaptiveChars: number; sections: EtaPromptSection[] } | undefined {
		return this.lastPromptBlocksValue;
	}

	reportPromptBlocks(blocks: { stableChars: number; adaptiveChars: number; sections: EtaPromptSection[] }): void {
		this.lastPromptBlocksValue = blocks;
	}

	/** Output tokens/sec over a sliding 2s window of observed output (usage events or streaming text). */
	private outSamples: { out: number; at: number }[] = [];
	private tokensPerSecValue = 0;

	get tokensPerSec(): number {
		return this.tokensPerSecValue;
	}

	trackUsage(totalsOut: number): void {
		this.observeOut(totalsOut);
	}

	/** Feed a monotonically growing output-token estimate; the sliding window absorbs jumps. */
	observeOut(totalsOut: number): void {
		const now = Date.now();
		const samples = this.outSamples;
		if (samples.length === 0 || totalsOut < samples[samples.length - 1]!.out) {
			samples.length = 0;
			samples.push({ out: totalsOut, at: now });
			return;
		}
		if (totalsOut === samples[samples.length - 1]!.out) return;
		samples.push({ out: totalsOut, at: now });
		while (samples.length > 2 && now - samples[0]!.at > 2_000) samples.shift();
		const first = samples[0]!;
		const last = samples[samples.length - 1]!;
		const seconds = (last.at - first.at) / 1_000;
		if (seconds >= 0.5) this.tokensPerSecValue = (last.out - first.out) / seconds;
	}
	/** Size of the last <memory> block for the water level panel; undefined when no source. */
	readonly memoryInfo: (() => Promise<{ chars: number }>) | undefined;
	private readonly stopHeartbeat: (() => void) | undefined;

	private constructor(
		harness: AgentHarness,
		lane: AgentLane,
		kv: StateKV,
		goal: GoalManager,
		tasks: TaskStore,
		loops: LoopScheduler,
		ask: AskRegistry,
		btw: BtwManager,
		subagents: SubagentManager,
		agentTools: AgentHarnessTool<object | undefined>[],
		memoryInfo: (() => Promise<{ chars: number }>) | undefined,
		stopHeartbeat: (() => void) | undefined,
	) {
		this.harness = harness;
		this.lane = lane;
		this.stateKv = kv;
		this.goal = goal;
		this.tasks = tasks;
		this.loops = loops;
		this.ask = ask;
		this.btw = btw;
		this.subagents = subagents;
		this.agentTools = agentTools;
		this.memoryInfo = memoryInfo;
		this.stopHeartbeat = stopHeartbeat;
	}

	get events() {
		return this.harness.events;
	}

	/** UI write path: mutate a task (the store persists) and mirror a todo observation. */
	setTask(id: string, patch: { status?: TaskStatus; content?: string; deps?: string[]; priority?: "high" | "medium" | "low" }): { task: StoredTask; warnings: string[] } | undefined {
		const result = this.tasks.update(id, patch);
		if (result !== undefined) {
			void this.lane.publish([{ type: "eta", category: "task", action: "update", data: { taskId: id, status: result.task.status } }], BACKGROUND_CONTEXT).catch(() => undefined);
		}
		return result;
	}

	static async create(options: EtaAgentOptions, context: Context): Promise<EtaAgent> {
		let laneRef: AgentLane | undefined;
		let agentRef: EtaAgent | undefined;
		const emit: EtaEmit = (category, action, data) => {
			void laneRef?.publish([{ type: "eta", category, action, data: data ?? {} }], BACKGROUND_CONTEXT).catch(() => undefined);
		};
		const writeEntry = (entry: PendingEntry) => {
			void laneRef?.append(entry, BACKGROUND_CONTEXT).catch(() => undefined);
		};
		const persist = <T>(address: Value<T>, value: T) => {
			void options.session
				.setValue(address, value, BACKGROUND_CONTEXT)
				.catch(() => emit("state", "persist_failed", { key: address.key }));
		};
		const persistLoop =
			options.persistLoop ??
			((spec: LoopSpec) => {
				persist(loopState(spec.def.id), spec);
			});

		const kv = options.kv ?? memoryKv();
		const goal = new GoalManager();
		goal.observe = emit;
		goal.onChange = (change) => writeEntry(goalEntry(goalPayloadFor(change)));
		const tasks = new TaskStore(() => persist(taskState, tasks.list()));
		const loops = new LoopScheduler({
			followUpFor: (spec) => loopFollowUp(spec.def.id, spec.def.note),
			persist: persistLoop,
			observe: emit,
		});
		const ask = new AskRegistry({
			observe: emit,
			onAnswer: (payload) => writeEntry(answerEntry(payload)),
			...(options.askHeadless === undefined ? {} : { headless: options.askHeadless }),
		});
		const btw = new BtwManager(
			(entries) => ({
				messages: (entries as { message?: AgentMessage }[]).flatMap((entry) => (entry.message === undefined ? [] : [entry.message])),
			}),
			(note) => writeEntry(btwEntry({ note })),
			emit,
		);
		const subagentBus: SubagentBus = { emit: (type: SubagentBusEvent, payload) => emit("lifecycle", type, payload) };
		const subagents = new SubagentManager(
			subagentBus,
			options.subagentRunner ?? (() => Promise.resolve({ input: 0, output: 0 })),
			options.poolSize,
		);

		const agentTools: AgentHarnessTool<object | undefined>[] = [
			...createTaskTools(tasks, emit),
			...createStateTools(kv, emit),
			...createLoopTools(loops),
			...createScheduleTool(loops),
			...createSubagentTools(subagents),
			createAskUserTool({
				registry: ask,
				onAsk: (payload) => writeEntry(askEntry(payload)),
				...(options.askTimeoutMs === undefined ? {} : { timeoutMs: options.askTimeoutMs }),
			}),
		];

		const systemPrompt =
			options.baseSystemPrompt === undefined
				? undefined
				: async () => {
						const memory = await options.memorySource?.();
						const state = {
							...(goal.current === undefined
								? {}
								: { goal: { objective: goal.current.objective, status: goal.current.status } }),
							tasks: tasks.list(),
							...(options.persona === undefined || options.persona.text.length === 0 ? {} : { persona: options.persona.text }),
							...(memory === undefined || memory.length === 0 ? {} : { memory }),
						};
						const blocks = etaPromptBlockChars(options.baseSystemPrompt ?? "", state);
						const detail = { ...blocks, sections: etaPromptSectionsDetailed(options.baseSystemPrompt ?? "", state) };
						agentRef?.reportPromptBlocks(detail);
						emit("prompt", "blocks", { ...blocks });
						return composeEtaSystemPrompt(options.baseSystemPrompt ?? "", state);
					};

		const { harness } = await AgentHarness.create(
			{
				session: options.session,
				models: options.models,
				model: options.model,
				...(systemPrompt === undefined ? {} : { systemPrompt }),
				activeToolNames: [...new Set(agentTools.map((tool) => tool.name))],
				tools: [...agentTools, ...(options.tools ?? [])],
			},
			context,
		);
		const lane = await harness.lane(options.laneName ?? "main", context);
		laneRef = lane;
		loops.attach();

		harness.events.on("usage", (event) => agentRef?.trackUsage((event as { totals?: { output?: number } }).totals?.output ?? 0));
		harness.events.on("run_start", () => {
			if (agentRef !== undefined) {
				agentRef.outSamples.length = 0;
				agentRef.tokensPerSecValue = 0;
			}
		});
		harness.hooks.on("before_run_end", goalDriver({ goal, evaluate: options.evaluateGoal ?? (() => Promise.resolve(false)) }), { id: "eta.goal" });
		harness.hooks.on("before_run_end", loopDriver(loops), { id: "eta.loop" });
		harness.hooks.on("before_run_end", emptyResponseGuard(), { id: "eta.empty" });

		const reminder = createReminderHooks(tasks);
		harness.hooks.on("after_tool", (event) => reminder.afterTool({ toolName: event.toolName }), { id: "eta.reminder" });
		harness.hooks.on("transform_context", (event) => reminder.transformContext(event), { id: "eta.reminder" });
		const stopHeartbeat = options.heartbeatMs === 0 ? undefined : startLoopHeartbeat(loops, options.heartbeatMs ?? 30_000);
		const agent = new EtaAgent(
			harness,
			lane,
			kv,
			goal,
			tasks,
			loops,
			ask,
			btw,
			subagents,
			agentTools,
			options.memorySource === undefined
				? undefined
				: async () => ({ chars: (await options.memorySource!()).length }),
			stopHeartbeat,
		);
		agentRef = agent;
		agent.personas = options.persona?.names ?? [];
		return agent;
	}

	/** Rebuild battery state from the replayed session log and values. */
	async restore(context: Context): Promise<void> {
		const entries = await this.lane.findEntries(undefined, context);
		const isBattery = (type: string) => type === "goal" || type === "ask" || type === "answer" || type === "btw";
		const changes: { type: string; payload: unknown }[] = entries
			.filter((e): e is Extract<typeof e, { payload: unknown }> => isBattery(e.type))
			.sort((a, b) => a.seq - b.seq)
			.map((e) => ({ type: e.type, payload: e.payload }));
		for (const pending of await this.lane.pendingEntries(context)) {
			if (isBattery(pending.type)) changes.push({ type: pending.type, payload: pending.payload });
		}
		const replayGoal = this.goal.onChange;
		this.goal.onChange = undefined;
		try {
			applyGoalEntries(this.goal, changes);
		} finally {
			this.goal.onChange = replayGoal;
		}
		this.ask.replay(changes);
		this.btw.replay(changes);
		const storedTasks = await this.lane.scanValues(taskState, context);
		if (storedTasks[0] !== undefined) this.tasks.restore(storedTasks[0].value);
		for (const stored of await this.lane.scanValues(loopStateInventoryPrefix(), context)) {
			this.loops.upsert(stored.value);
		}
	}

	async close(context: Context): Promise<void> {
		this.stopHeartbeat?.();
		await this.harness.close(context);
	}
}
