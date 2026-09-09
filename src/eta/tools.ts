/**
 * Built-in tools for the tasks/state batteries (C4/C6). Each returns plain
 * text for the model plus structured details for the UI. The reminder hooks
 * keep the nudge transient: injected via transform_context, never committed.
 */

import { Type, type TSchema } from "typebox";
import type { Context } from "../harness/context.ts";
import type { AgentHarnessTool, AgentHarnessToolInvocation } from "../harness/types.ts";
import { TODO_REVIEW_PROMPT, TODO_UPDATE_SUCCESS } from "../prompts/index.ts";
import type { DevEmit } from "./dev-events.ts";
import { createCadenceState, drainReminderForContext, evaluateToolResult, onTurnStart, type CadenceState } from "./cadence.ts";
import type { TaskStore } from "./task-store.ts";
import { renderCurrentTasks, type TaskStatus } from "./tasks.ts";

/** Tool shape the harness accepts, with params loosened for the batteries. */
export interface BatteryTool {
	name: string;
	label: string;
	description: string;
	parameters: TSchema;
	execute(
		toolCallId: string,
		params: Record<string, any>,
		onUpdate: unknown,
		toolContext: object | undefined,
		invocation: AgentHarnessToolInvocation,
		context: Context,
	): Promise<{ content: { type: "text"; text: string }[]; details: unknown }>;
}

export type { AgentHarnessTool };

const withId = <T>(id: string, extra: T) => ({ content: [{ type: "text" as const, text: id }], details: extra });

export const TASK_TOOL_NAMES: ReadonlySet<string> = new Set(["TaskCreate", "TaskList", "TaskGet", "TaskUpdate"]);

/** TaskCreate / TaskList / TaskGet / TaskUpdate over a TaskStore. */
export function createTaskTools(store: TaskStore, onChange?: () => void, dev?: DevEmit): BatteryTool[] {
	const notify = (action?: string, data?: Record<string, unknown>) => {
		onChange?.();
		if (action !== undefined) dev?.("todo", action, data);
	};
	return [
		{
			name: "TaskCreate",
			label: "TaskCreate",
			description: "Add a task to your plan. deps are ids this task waits on.",
			parameters: Type.Object({
				content: Type.String({ description: "What the step is, one line" }),
				deps: Type.Optional(Type.Array(Type.String(), { description: "Task ids this waits on" })),
				priority: Type.Optional(Type.Union([Type.Literal("high"), Type.Literal("medium"), Type.Literal("low")])),
			}),
			async execute(_id, params) {
				const { task, warnings } = store.create(params.content, { deps: params.deps, priority: params.priority });
				notify("add", { taskId: task.id });
				return withId(`Created ${task.id}. ${TODO_UPDATE_SUCCESS}${warnings.length > 0 ? `\nwarnings: ${warnings.join("; ")}` : ""}`, { task, warnings });
			},
		},
		{
			name: "TaskList",
			label: "TaskList",
			description: "Show the current task list.",
			parameters: Type.Object({}),
			async execute() {
				const rendered = renderCurrentTasks({ tasks: store.list(), updatedAt: new Date().toISOString() });
				return withId(rendered, { tasks: store.list() });
			},
		},
		{
			name: "TaskGet",
			label: "TaskGet",
			description: "Show one task with its dependency edges.",
			parameters: Type.Object({ id: Type.String() }),
			async execute(_id, { id }) {
				const task = store.get(id);
				if (task === undefined) return withId(`No task ${id}.`, { task: undefined });
				return withId(JSON.stringify(task), { task });
			},
		},
		{
			name: "TaskUpdate",
			label: "TaskUpdate",
			description: "Change a task: status (pending|in_progress|completed|cancelled), content, deps, priority.",
			parameters: Type.Object({
				id: Type.String(),
				status: Type.Optional(Type.Union([Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("completed"), Type.Literal("cancelled")])),
				content: Type.Optional(Type.String()),
				deps: Type.Optional(Type.Array(Type.String())),
				priority: Type.Optional(Type.Union([Type.Literal("high"), Type.Literal("medium"), Type.Literal("low")])),
			}),
			async execute(_id, { id, ...patch }) {
				const result = store.update(id, patch);
				if (result === undefined) return withId(`No task ${id}.`, { task: undefined });
				notify("update", { taskId: id, status: result.task.status });
				return withId(`Updated ${id}. ${TODO_UPDATE_SUCCESS}${result.warnings.length > 0 ? `\nwarnings: ${result.warnings.join("; ")}` : ""}`, {
					task: result.task,
					warnings: result.warnings,
				});
			},
		},
	];
}

/** Minimal KV backend for the state tools (session Value/List in production). */
export interface StateKV {
	get(key: string): Promise<string | undefined>;
	/** null deletes the key. */
	set(key: string, value: string | null): Promise<void>;
	keys(): Promise<string[]>;
}

export function createStateTools(kv: StateKV, dev?: DevEmit): BatteryTool[] {
	return [
		{
			name: "update_state",
			label: "update_state",
			description: "Store a string under a session KV key. Pass value null to delete it.",
			parameters: Type.Object({ key: Type.String(), value: Type.Union([Type.String(), Type.Null()]) }),
			async execute(_id, { key, value }) {
				await kv.set(key, value);
				dev?.("state", value === null ? "delete" : "set", { key });
				return withId(value === null ? `Deleted ${key}.` : `Stored ${key}.`, { key });
			},
		},
		{
			name: "check_state",
			label: "check_state",
			description: "Read one session KV key.",
			parameters: Type.Object({ key: Type.String() }),
			async execute(_id, { key }) {
				const value = await kv.get(key);
				return withId(value === undefined ? `${key} is not set.` : value, { key, value });
			},
		},
		{
			name: "list_state",
			label: "list_state",
			description: "List session KV keys.",
			parameters: Type.Object({}),
			async execute() {
				const keys = await kv.keys();
				return withId(keys.length === 0 ? "No state keys." : keys.join("\n"), { keys });
			},
		},
	];
}

export interface ReminderHooks {
	state: CadenceState;
	onTurnStart(): void;
	afterTool(event: { toolName: string }): undefined;
	transformContext(event: { messages: unknown[] }): { messages: unknown[] } | undefined;
}

/** Transient <system-reminder> nudges: after_tool feeds cadence, transform_context injects. */
export function createReminderHooks(store: TaskStore, reminderInterval = 5): ReminderHooks {
	const state = createCadenceState();
	const config = { reminderInterval, taskToolNames: TASK_TOOL_NAMES };
	return {
		state,
		onTurnStart: () => onTurnStart(state),
		afterTool: (event) => {
			evaluateToolResult(state, event.toolName, store.list().length > 0, config);
			return undefined;
		},
		transformContext: (event) => {
			if (!drainReminderForContext(state)) return undefined;
			return {
				messages: [
					...event.messages,
					{ role: "user", content: `<system-reminder>\n${TODO_REVIEW_PROMPT}\n</system-reminder>`, timestamp: Date.now() },
				],
			};
		},
	};
}

export type { TaskStatus };

import { parseEvery, type LoopScheduler } from "./loops.ts";
import type { SubagentManager } from "./subagent.ts";

let scheduleSequence = 0;

/** LoopCreate / LoopList / LoopStop: the model's surface over the C2 scheduler. */
export function createLoopTools(scheduler: LoopScheduler): BatteryTool[] {
	return [
		{
			name: "LoopCreate",
			label: "LoopCreate",
			description:
				"Schedule recurring notes to yourself: every ('45s'/'5m'/'2h'), or a 6-field cron (sec min hour dom mon dow, UTC). onEvent fires once per matching bus event. expiresIn caps lifetime ('2d').",
			parameters: Type.Object({
				id: Type.String({ description: "Stable name for this loop" }),
				note: Type.String({ description: "What to do each time it fires" }),
				every: Type.Optional(Type.String()),
				cron: Type.Optional(Type.String()),
				onEvent: Type.Optional(Type.String({ description: "Event type that fires this loop" })),
				maxRuns: Type.Optional(Type.Number()),
				expiresIn: Type.Optional(Type.String()),
			}),
			async execute(_id, { id, note, every, cron, onEvent, maxRuns, expiresIn }) {
				if (every === undefined && cron === undefined && onEvent === undefined)
					return withId("LoopCreate needs every, cron, or onEvent.", { error: true });
				const spec = {
					def: { id, note, ...(every !== undefined ? { every } : {}), ...(cron !== undefined ? { cron } : {}), ...(maxRuns !== undefined ? { maxRuns } : {}) },
					...(onEvent !== undefined ? { on: { type: onEvent } } : {}),
					...(expiresIn !== undefined ? { expiresAt: new Date(Date.now() + parseEvery(expiresIn)).toISOString() } : {}),
					runCount: 0,
					createdAt: Date.now(),
					paused: false,
				};
				scheduler.upsert(spec);
				return withId(`Loop ${id} scheduled.`, { spec });
			},
		},
		{
			name: "LoopList",
			label: "LoopList",
			description: "List scheduled loops with run counts and state.",
			parameters: Type.Object({}),
			async execute() {
				const rows = scheduler.list().map((spec) => `${spec.def.id}: ${spec.def.note} [${spec.paused ? "paused" : spec.def.cron ?? spec.def.every ?? "event"} x${spec.runCount}]`);
				return withId(rows.length === 0 ? "No loops." : rows.join("\n"), { count: rows.length });
			},
		},
		{
			name: "LoopStop",
			label: "LoopStop",
			description: "Remove a scheduled loop by id.",
			parameters: Type.Object({ id: Type.String() }),
			async execute(_id, { id }) {
				return withId(scheduler.remove(id) ? `Loop ${id} removed.` : `No loop ${id}.`, { removed: scheduler.list().length });
			},
		},
	];
}

/** One-shot Schedule tool: reuses C2 formats, fires exactly once. */
export function createScheduleTool(scheduler: LoopScheduler): BatteryTool[] {
	return [
		{
			name: "Schedule",
			label: "Schedule",
			description: "Remind yourself once: after every ('30m'), or at a 6-field cron time (next match fires once).",
			parameters: Type.Object({
				note: Type.String(),
				every: Type.Optional(Type.String()),
				cron: Type.Optional(Type.String()),
			}),
			async execute(_id, { note, every, cron }) {
				if (every === undefined && cron === undefined) return withId("Schedule needs every or cron.", { error: true });
				const id = `sched-${(++scheduleSequence).toString(36)}-${Date.now().toString(36)}`;
				const spec = {
					def: { id, note, ...(every !== undefined ? { every } : {}), ...(cron !== undefined ? { cron } : {}), maxRuns: 1 },
					runCount: 0,
					createdAt: Date.now(),
					paused: false,
				};
				scheduler.upsert(spec);
				return withId(`Scheduled ${id}.`, { spec });
			},
		},
	];
}

/** Agent / get_subagent_result / steer_subagent over the C7 manager. */
export function createSubagentTools(manager: SubagentManager, ownerId?: string): BatteryTool[] {
	return [
		{
			name: "Agent",
			label: "Agent",
			description: "Spawn a subagent on a task. background=true returns immediately; otherwise it runs to completion first.",
			parameters: Type.Object({
				task: Type.String(),
				model: Type.Optional(Type.String()),
				background: Type.Optional(Type.Boolean()),
				maxTurns: Type.Optional(Type.Number()),
			}),
			async execute(_id, { task, model, background, maxTurns }) {
				const spec = { prompt: task, ...(model !== undefined ? { model } : {}), ...(maxTurns !== undefined ? { maxTurns } : {}) };
				const record = background === true ? manager.spawn(spec, ownerId) : manager.spawnAndWait(spec, ownerId);
				return withId(`${record.id} ${record.status} (in ${record.totalUsage.input}/out ${record.totalUsage.output})`, { record: { id: record.id, status: record.status } });
			},
		},
		{
			name: "get_subagent_result",
			label: "get_subagent_result",
			description: "Fetch a subagent's status and rolled-up usage.",
			parameters: Type.Object({ id: Type.String() }),
			async execute(_id, { id }) {
				const record = manager.get(id);
				if (record === undefined) return withId(`No agent ${id}.`, { error: true });
				return withId(`${record.id} ${record.status} (in ${record.totalUsage.input}/out ${record.totalUsage.output})`, {
					id: record.id,
					status: record.status,
					usage: record.totalUsage,
				});
			},
		},
		{
			name: "steer_subagent",
			label: "steer_subagent",
			description: "Queue a steering note for a running subagent.",
			parameters: Type.Object({ id: Type.String(), note: Type.String() }),
			async execute(_id, { id, note }) {
				return withId(manager.steer(id, ownerId, note) ? `Steered ${id}.` : `Can't steer ${id} (unknown, done, or not yours).`, { id, note });
			},
		},
	];
}
