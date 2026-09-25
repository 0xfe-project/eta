/** Task vocabulary: four states plus dependency edges. */
export type TaskStatus = "pending" | "in_progress" | "completed" | "cancelled";

/** One planned step in the agent's task list. */
export interface Task {
	id: string;
	content: string;
	status: TaskStatus;
	priority?: "high" | "medium" | "low";
}

/** Task with dependency edges; persisted whole under the session tasks value. */
export interface StoredTask extends Task {
	/** Ids this task waits on; reverse edges are computed, not duplicated. */
	dependsOn?: string[];
	/** Ids waiting on this task. */
	blocks?: string[];
}

/** What changed, emitted on the bus with every task:* event. */
export interface TaskChange {
	action: "created" | "updated" | "removed" | "completed" | "cancelled";
	task: StoredTask;
}
