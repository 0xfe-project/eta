/**
 * TaskService — the task primitive.
 *
 * Full semantic port of eta-agent's harness/task-store.ts (C4 lite, pi-tasks
 * semantics): four states, ids never reused, dependency edges kept even when
 * they form cycles (warn but keep), and a normalization guard on restore so a
 * corrupt row can't poison the session.
 *
 * Every mutation emits its task:* event on the bus; persistence is a bus
 * subscriber's job. Tool registration (TaskCreate/List/Get/Update) is NOT
 * here — that is the tools plugin's job (REFACTOR.md §2.3.3).
 */

import type { Context } from "cordis";
import { Service } from "cordis";
import type { Emit } from "../types/events";
import { kernelEmit } from "../types/events";
import type { StoredTask, Task, TaskStatus } from "../types/tasks";

const STATUSES: readonly TaskStatus[] = ["pending", "in_progress", "completed", "cancelled"];

export class TaskService extends Service {
	static readonly provide = "tasks";

	private tasks = new Map<string, StoredTask>();
	private nextId = 1;
	private readonly emit: Emit;

	constructor(ctx: Context) {
		super(ctx, "tasks");
		this.emit = kernelEmit(ctx);
	}

	/** Add a task; auto-ids are t1, t2, ... and are never reused. */
	create(
		content: string,
		extra: { deps?: string[]; priority?: Task["priority"] } = {},
	): { task: StoredTask; warnings: string[] } {
		const id = `t${this.nextId++}`;
		const task: StoredTask = { id, content, status: "pending", priority: extra.priority, dependsOn: [], blocks: [] };
		this.tasks.set(id, task);
		const warnings = this.setDeps(task, extra.deps ?? []);
		this.emit("task:created", { action: "created", task });
		return { task, warnings };
	}

	/** Drop a task outright; dangling references in other tasks are pruned. */
	remove(id: string): boolean {
		const task = this.tasks.get(id);
		if (task === undefined || !this.tasks.delete(id)) return false;
		for (const other of this.tasks.values()) {
			if (other.dependsOn?.includes(id)) other.dependsOn = other.dependsOn.filter((dep) => dep !== id);
			if (other.blocks?.includes(id)) other.blocks = other.blocks.filter((dep) => dep !== id);
		}
		this.emit("task:removed", { action: "removed", task });
		return true;
	}

	get(id: string): StoredTask | undefined {
		return this.tasks.get(id);
	}

	list(): StoredTask[] {
		return [...this.tasks.values()];
	}

	update(
		id: string,
		patch: { content?: string; status?: TaskStatus; deps?: string[]; priority?: Task["priority"] },
	): { task: StoredTask; warnings: string[] } | undefined {
		const task = this.tasks.get(id);
		if (task === undefined) return undefined;
		const warnings: string[] = [];
		if (patch.status !== undefined && !STATUSES.includes(patch.status)) {
			warnings.push(`unknown status ${patch.status}`);
		}
		if (patch.content !== undefined) task.content = patch.content;
		if (patch.priority !== undefined) task.priority = patch.priority;
		if (patch.deps !== undefined) warnings.push(...this.setDeps(task, patch.deps));

		const previous = task.status;
		if (patch.status !== undefined && STATUSES.includes(patch.status)) task.status = patch.status;

		if (previous !== task.status && (task.status === "completed" || task.status === "cancelled")) {
			const change = { action: task.status, task };
			this.emit(task.status === "completed" ? "task:completed" : "task:cancelled", change);
		}
		this.emit("task:updated", { action: "updated", task });
		return { task, warnings };
	}

	/** Rewrite dependency edges with warnings for self-deps and cycles (kept, not dropped). */
	private setDeps(task: StoredTask, deps: string[]): string[] {
		const warnings: string[] = [];
		for (const other of this.tasks.values()) {
			if (other.blocks?.includes(task.id)) other.blocks = other.blocks.filter((b) => b !== task.id);
		}
		task.dependsOn = [];
		for (const dep of deps) {
			if (dep === task.id) {
				warnings.push(`task ${task.id} depends on itself`);
			} else if (!this.tasks.has(dep)) {
				warnings.push(`unknown dependency ${dep} dropped`);
				continue;
			}
			task.dependsOn.push(dep);
			const depTask = this.tasks.get(dep);
			if (depTask !== undefined) {
				depTask.blocks = [...(depTask.blocks ?? []), task.id];
			}
			if (this.reaches(dep, task.id)) {
				warnings.push(`dependency cycle around ${task.id} <-> ${dep}`);
			}
		}
		return warnings;
	}

	private reaches(fromId: string, targetId: string): boolean {
		const seen = new Set<string>();
		let frontier = [fromId];
		while (frontier.length > 0) {
			const next: string[] = [];
			for (const id of frontier) {
				if (id === targetId && !seen.has(id)) return true;
				if (seen.has(id)) continue;
				seen.add(id);
				next.push(...(this.tasks.get(id)?.dependsOn ?? []));
			}
			frontier = next;
		}
		return false;
	}

	serialize(): StoredTask[] {
		return this.list();
	}

	/** The one load path: drop malformed rows, keep the rest; ids never reused across a restore. */
	restore(raw: unknown): { kept: number; dropped: string[] } {
		const dropped: string[] = [];
		let kept = 0;
		if (!Array.isArray(raw)) return { kept: 0, dropped: ["root"] };
		this.tasks.clear();
		let maxId = 0;
		for (const item of raw) {
			const t = item as Partial<StoredTask>;
			if (typeof t?.id !== "string" || typeof t.content !== "string" || !STATUSES.includes(t.status as TaskStatus)) {
				dropped.push(String((t as { id?: unknown })?.id ?? "unknown"));
				continue;
			}
			const task: StoredTask = {
				id: t.id,
				content: t.content,
				status: t.status as TaskStatus,
				priority: t.priority,
				dependsOn: Array.isArray(t.dependsOn) ? t.dependsOn.filter((d) => typeof d === "string") : [],
				blocks: Array.isArray(t.blocks) ? t.blocks.filter((d) => typeof d === "string") : [],
			};
			this.tasks.set(task.id, task);
			const num = /^t(\d+)$/.exec(task.id);
			if (num !== null) maxId = Math.max(maxId, Number(num[1]));
			kept += 1;
		}
		this.nextId = Math.max(this.nextId, maxId + 1);
		return { kept, dropped };
	}
}

/** Render the live task list into the system prompt block. */
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
