/**
 * Built-in tools for the tasks/state batteries (C4/C6). Each returns plain
 * text for the model plus structured details for the UI. The reminder hooks
 * keep the nudge transient: injected via transform_context, never committed.
 */

import { Type, type TSchema } from "typebox";
import type { Context } from "../harness/context.ts";
import type { AgentHarnessTool, AgentHarnessToolInvocation } from "../harness/types.ts";
import { TODO_REVIEW_PROMPT, TODO_UPDATE_SUCCESS } from "../prompts/index.ts";
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
export function createTaskTools(store: TaskStore, onChange?: () => void): BatteryTool[] {
	const notify = () => onChange?.();
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
				notify();
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
				notify();
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

export function createStateTools(kv: StateKV): BatteryTool[] {
	return [
		{
			name: "update_state",
			label: "update_state",
			description: "Store a string under a session KV key. Pass value null to delete it.",
			parameters: Type.Object({ key: Type.String(), value: Type.Union([Type.String(), Type.Null()]) }),
			async execute(_id, { key, value }) {
				await kv.set(key, value);
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
