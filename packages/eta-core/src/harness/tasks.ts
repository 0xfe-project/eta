/**
 * Tasks & loops as KV values (D1: no new entry types).
 * Serialization is pure; storage side is a single Value row under
 * `eta.tasks` (tasks) and `eta.loop.<id>` (loop state).
 */

export type TaskStatus = "pending" | "in_progress" | "completed" | "cancelled";

export interface Task {
	id: string;
	content: string;
	status: TaskStatus;
	priority?: "high" | "medium" | "low";
}

export interface TaskList {
	tasks: Task[];
	updatedAt: string;
}

export interface LoopDef {
	id: string;
	note: string;
	/** Interval trigger: "45s" | "5m" | "2h" | "1d". */
	every?: string;
	/** 6-field cron trigger (sec min hour dom mon dow), UTC. */
	cron?: string;
	maxRuns?: number;
}

export interface LoopState {
	defId: string;
	runCount: number;
	lastRunAt?: string;
	nextRunAt?: string;
	paused: boolean;
}

export const TASKS_KEY = "eta.tasks";
export const loopDefKey = (id: string) => `eta.loop.${id}`;
export const loopStateKey = (id: string) => `eta.loop.state.${id}`;

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

export function serializeLoopState(state: LoopState): string {
	return JSON.stringify(state);
}

export function parseLoopState(raw: string): LoopState {
	const parsed = JSON.parse(raw) as LoopState;
	if (!parsed.defId || typeof parsed.runCount !== "number") throw new Error("eta.loop: invalid state");
	return parsed;
}

/** Render the `<current_tasks>` prompt block (used with TODO_REVIEW_PROMPT). */
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
