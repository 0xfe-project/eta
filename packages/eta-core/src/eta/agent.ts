/**
 * The integrated agent: one harness, one event stream, one entry log. EtaAgent
 * owns every battery (goal, loops, ask, tasks, state, btw, subagents) as
 * internal state, wires the run-end drivers, composes the system prompt from
 * live state, and publishes battery observations as `eta` events on the main
 * HarnessEvent bus. There is no second bus, no bridge, no plugin surface.
 */

import type { Api, Model, Models } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT, type Context } from "../harness/context.ts";
import { AgentHarness, type AgentLane } from "../harness/agent-harness.ts";
import type { AgentHarnessTool } from "../harness/types.ts";
import type { Session } from "../harness/session/types.ts";
import type { EtaEmit } from "../harness/eta-events.ts";
import { composeEtaSystemPrompt } from "./composer.ts";
import { AskRegistry, createAskUserTool } from "./ask.ts";
import { BtwManager } from "./btw.ts";
import { askEntry, btwEntry, goalEntry, type GoalPayload } from "./entries.ts";
import { GoalManager } from "./goal.ts";
import { LoopScheduler, type LoopSpec } from "./loops.ts";
import { emptyResponseGuard, goalDriver, loopDriver, startLoopHeartbeat } from "./run-end.ts";
import { SubagentManager, type SubagentBus, type SubagentBusEvent, type SubagentRunner } from "./subagent.ts";
import { TaskStore } from "./task-store.ts";
import {
	createLoopTools,
	createScheduleTool,
	createStateTools,
	createSubagentTools,
	createTaskTools,
	type BatteryTool,
	type StateKV,
} from "./tools.ts";

export interface EtaAgentOptions {
	session: Session;
	models: Models;
	model: Model<Api>;
	laneName?: string;
	baseSystemPrompt?: string;
	/** Extra tools the caller owns (merged with the battery tools). */
	tools?: readonly AgentHarnessTool<object | undefined>[];
	/** Independent goal judge; true = achieved. */
	evaluateGoal?: (objective: string) => Promise<boolean>;
	askTimeoutMs?: number;
	/** Where loop registry values persist; default: custom entry `eta_loop_state`. */
	persistLoop?: (spec: LoopSpec) => void;
	kv?: StateKV;
	subagentRunner?: SubagentRunner;
	poolSize?: number;
	/** Approval callback for anything the agent marks approval-worthy (fail-closed). */
	approve?: (toolName: string, args: Record<string, unknown>) => Promise<boolean>;
	/** Loop heartbeat interval in ms; 0 disables. Default 30s. */
	heartbeatMs?: number;
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
	readonly batteryTools: BatteryTool[];
	private readonly stopHeartbeat: (() => void) | undefined;

	private constructor(
		harness: AgentHarness,
		lane: AgentLane,
		goal: GoalManager,
		tasks: TaskStore,
		loops: LoopScheduler,
		ask: AskRegistry,
		btw: BtwManager,
		subagents: SubagentManager,
		batteryTools: BatteryTool[],
		stopHeartbeat: (() => void) | undefined,
	) {
		this.harness = harness;
		this.lane = lane;
		this.goal = goal;
		this.tasks = tasks;
		this.loops = loops;
		this.ask = ask;
		this.btw = btw;
		this.subagents = subagents;
		this.batteryTools = batteryTools;
		this.stopHeartbeat = stopHeartbeat;
	}

	get events() {
		return this.harness.events;
	}

	static async create(options: EtaAgentOptions, context: Context): Promise<EtaAgent> {
		let laneRef: AgentLane | undefined;
		const emit: EtaEmit = (category, action, data) => {
			void laneRef?.publish([{ type: "eta", category, action, data: data ?? {} }], BACKGROUND_CONTEXT).catch(() => undefined);
		};
		const writeEntry = (entry: { customType: string; payload: object }) => {
			void laneRef?.appendCustomEntry(entry.customType, entry.payload as never, BACKGROUND_CONTEXT).catch(() => undefined);
		};
		const persistLoop =
			options.persistLoop ?? ((spec: LoopSpec) => writeEntry({ customType: "eta_loop_state", payload: spec }));

		const goal = new GoalManager();
		goal.dev = emit;
		goal.onChange = (change) => writeEntry(goalEntry(goalPayloadFor(change)));
		const tasks = new TaskStore();
		const loops = new LoopScheduler({
			followUpFor: (spec) => `[loop ${spec.def.id}] ${spec.def.note}`,
			persist: persistLoop,
			dev: emit,
		});
		const ask = new AskRegistry({ dev: emit });
		const btw = new BtwManager(() => ({ messages: [] }), (note) => writeEntry(btwEntry({ note })), emit);
		const subagentBus: SubagentBus = { emit: (type: SubagentBusEvent, payload) => emit("lifecycle", type, payload) };
		const subagents = new SubagentManager(
			subagentBus,
			options.subagentRunner ?? (() => Promise.resolve({ input: 0, output: 0 })),
			options.poolSize,
		);

		const batteryTools: BatteryTool[] = [
			...createTaskTools(tasks, undefined, emit),
			...createStateTools(options.kv ?? memoryKv(), emit),
			...createLoopTools(loops),
			...createScheduleTool(loops),
			...createSubagentTools(subagents),
			createAskUserTool({
				registry: ask,
				onAsk: (payload) => writeEntry(askEntry(payload)),
				...(options.askTimeoutMs === undefined ? {} : { timeoutMs: options.askTimeoutMs }),
			}) as unknown as BatteryTool,
		];

		const systemPrompt =
			options.baseSystemPrompt === undefined
				? undefined
				: () =>
						composeEtaSystemPrompt(options.baseSystemPrompt ?? "", {
							...(goal.current === undefined
								? {}
								: { goal: { objective: goal.current.objective, status: goal.current.status } }),
							tasks: { tasks: tasks.list(), updatedAt: new Date().toISOString() },
						});

		const { harness } = await AgentHarness.create(
			{
				session: options.session,
				models: options.models,
				model: options.model,
				...(systemPrompt === undefined ? {} : { systemPrompt }),
				activeToolNames: [...new Set(batteryTools.map((tool) => tool.name))],
				tools: [...batteryTools, ...(options.tools ?? [])] as never,
			},
			context,
		);
		const lane = await harness.lane(options.laneName ?? "main", context);
		laneRef = lane;
		loops.attach();

		harness.hooks.on("before_run_end", goalDriver({ goal, evaluate: options.evaluateGoal ?? (() => Promise.resolve(false)) }), { id: "eta.goal" });
		harness.hooks.on("before_run_end", loopDriver(loops), { id: "eta.loop" });
		harness.hooks.on("before_run_end", emptyResponseGuard(), { id: "eta.empty" });
		if (options.approve !== undefined) {
			const approve = options.approve;
			harness.hooks.on(
				"before_tool",
				async (event: { toolName: string; args: Record<string, unknown> }) =>
					(await approve(event.toolName, event.args)) ? undefined : { block: { reason: "permission denied" } },
				{ id: "eta.approval" },
			);
		}
		const stopHeartbeat = options.heartbeatMs === 0 ? undefined : startLoopHeartbeat(loops, options.heartbeatMs ?? 30_000);
		return new EtaAgent(harness, lane, goal, tasks, loops, ask, btw, subagents, batteryTools, stopHeartbeat);
	}

	/** Unanswered asks after a restart, from the replayed entry log. */
	async restore(context: Context): Promise<void> {
		const entries = await this.lane.findEntries(undefined, context);
		this.ask.replay(
			entries
				.filter((e): e is Extract<typeof e, { type: "custom" }> => e.type === "custom" && (e.customType === "eta.ask" || e.customType === "eta.answer"))
				.map((e) => ({ customType: e.customType, payload: e.data })),
		);
	}

	async close(context: Context): Promise<void> {
		this.stopHeartbeat?.();
		await this.harness.close(context);
	}
}
