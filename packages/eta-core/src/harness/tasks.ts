/**
 * Task prompt vocabulary: rendering the live task list into the system
 * prompt. Persistence is the TaskStore's own StoredTask rows under the
 * `taskState` key — one format, one owner. The task types (Task, TaskStatus)
 * are first-class session vocabulary (session/types.ts).
 */

import type { Task, TaskStatus } from "./session/types.ts";

export type { Task, TaskStatus } from "./session/types.ts";

export function renderCurrentTasks(tasks: Task[]): string {
	const marks: Record<TaskStatus, string> = {
		pending: "[ ]",
		in_progress: "[~]",
		completed: "[x]",
		cancelled: "[-]",
	};
	const body = tasks.map((t) => `${marks[t.status]} ${t.id}: ${t.content}`).join("\n");
	return `<current_tasks>\n${body}\n</current_tasks>`;
}
