/** TaskCreate / TaskList / TaskGet / TaskUpdate over the session task store (C4). */

import { Type } from "typebox";
import type { Context } from "../context.ts";
import type { AgentHarnessTool } from "../types.ts";
import { TASK_UPDATE_SUCCESS } from "../../prompts/index.ts";
import type { EtaEmit } from "../events.ts";
import type { TaskStore } from "../task-store.ts";
import { renderCurrentTasks, type TaskStatus } from "../tasks.ts";
import { withId } from "./shared.ts";

export type { TaskStatus };

export const TASK_TOOL_NAMES: ReadonlySet<string> = new Set(["TaskCreate", "TaskList", "TaskGet", "TaskUpdate"]);

/** TaskCreate / TaskList / TaskGet / TaskUpdate over a TaskStore. */
export function createTaskTools(store: TaskStore, observe?: EtaEmit): AgentHarnessTool<object | undefined, any, any>[] {
	const notify = (action?: string, data?: Record<string, unknown>) => {
		if (action !== undefined) observe?.("task", action, data);
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
			async execute(_id, params: { content: string; deps?: string[]; priority?: "high" | "medium" | "low" }) {
				const { task, warnings } = store.create(params.content, { deps: params.deps, priority: params.priority });
				notify("add", { taskId: task.id });
				return withId(
					`Created ${task.id}. ${TASK_UPDATE_SUCCESS}${warnings.length > 0 ? `\nwarnings: ${warnings.join("; ")}` : ""}`,
					{ task, warnings },
				);
			},
		},
		{
			name: "TaskList",
			label: "TaskList",
			description: "Show the current task list.",
			parameters: Type.Object({}),
			async execute() {
				const rendered = renderCurrentTasks(store.list());
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
				status: Type.Optional(
					Type.Union([
						Type.Literal("pending"),
						Type.Literal("in_progress"),
						Type.Literal("completed"),
						Type.Literal("cancelled"),
					]),
				),
				content: Type.Optional(Type.String()),
				deps: Type.Optional(Type.Array(Type.String())),
				priority: Type.Optional(Type.Union([Type.Literal("high"), Type.Literal("medium"), Type.Literal("low")])),
			}),
			async execute(_id, { id, ...patch }) {
				const result = store.update(id, patch);
				if (result === undefined) return withId(`No task ${id}.`, { task: undefined });
				notify("update", { taskId: id, status: result.task.status });
				return withId(
					`Updated ${id}. ${TASK_UPDATE_SUCCESS}${result.warnings.length > 0 ? `\nwarnings: ${result.warnings.join("; ")}` : ""}`,
					{
						task: result.task,
						warnings: result.warnings,
					},
				);
			},
		},
	];
}
