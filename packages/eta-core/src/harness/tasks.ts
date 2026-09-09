/**
 * Task prompt vocabulary: rendering the live task list into the system prompt
 * and the KV-safe serialization used when persisting it. The task types
 * themselves (Task, TaskStatus, TaskList, StoredTask) are first-class session
 * vocabulary (session/types.ts).
 */

import type { Task, TaskList, TaskStatus } from "./session/types.ts";

export type { Task, TaskList, TaskStatus } from "./session/types.ts";

export function serializeTaskList(tasks: Task[]): string {
	return JSON.stringify({ tasks, updatedAt: new Date().toISOString() } satisfies TaskList);
}

export function parseTaskList(raw: string): TaskList {
	const parsed = JSON.parse(raw) as TaskList;
	if (!Array.isArray(parsed.tasks)) throw new Error("eta.tasks: tasks must be an array");
	for (const t of parsed.tasks) {
		if (!t.id || !t.content || !["pending", "in_progress", "completed", "cancelled"].includes(t.status)) {
			throw new Error(`eta.tasks: invalid task ${JSON.stringify(t)}`);
		}
	}
	return parsed;
}

export function renderCurrentTasks(list: TaskList): string {
	const marks: Record<TaskStatus, string> = {
		pending: "[ ]",
		in_progress: "[~]",
		completed: "[x]",
		cancelled: "[-]",
	};
	const body = list.tasks.map((t) => `${marks[t.status]} ${t.id}: ${t.content}`).join("\n");
	return `<current_tasks>\n${body}\n</current_tasks>`;
}
