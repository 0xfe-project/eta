/**
 * Task store (C4 lite, semantics from pi-tasks): four states, ids never
 * reused, dependency edges kept even when they form cycles (with a warning,
 * matching pi-tasks' "warn but keep" behavior), and a normalization guard on
 * load so a corrupt KV row can't poison the session.
 */

import type { StoredTask, Task, TaskStatus } from "./session/types.ts";

export type { StoredTask } from "./session/types.ts";

const STATUSES: readonly TaskStatus[] = ["pending", "in_progress", "completed", "cancelled"];

export class TaskStore {
	private tasks = new Map<string, StoredTask>();
	private nextId = 1;

	/** Fires after every create/update so the owner can persist the whole list. */
	private readonly onMutate: (() => void) | undefined;

	constructor(onMutate?: () => void) {
		this.onMutate = onMutate;
	}

	private mutate(): void {
		this.onMutate?.();
	}

	/** Add a task; auto-ids are t1, t2, ... and are never reused. */
	create(content: string, extra: { deps?: string[]; priority?: Task["priority"] } = {}): { task: StoredTask; warnings: string[] } {
		const id = `t${this.nextId++}`;
		const task: StoredTask = { id, content, status: "pending", priority: extra.priority, dependsOn: [], blocks: [] };
		this.tasks.set(id, task);
		const warnings = this.setDeps(task, extra.deps ?? []);
		this.mutate();
		return { task, warnings };
	}

	/** Drop a task outright; dangling references in other tasks are pruned. */
	remove(id: string): boolean {
		if (!this.tasks.delete(id)) return false;
		for (const task of this.tasks.values()) {
			if (task.dependsOn?.includes(id)) task.dependsOn = task.dependsOn.filter((dep) => dep !== id);
			if (task.blocks?.includes(id)) task.blocks = task.blocks.filter((dep) => dep !== id);
		}
		this.mutate();
		return true;
	}

	get(id: string): StoredTask | undefined {
		return this.tasks.get(id);
	}

	list(): StoredTask[] {
		return [...this.tasks.values()];
	}

	update(id: string, patch: { content?: string; status?: TaskStatus; deps?: string[]; priority?: Task["priority"] }): { task: StoredTask; warnings: string[] } | undefined {
		const task = this.tasks.get(id);
		if (task === undefined) return undefined;
		const warnings: string[] = [];
		if (patch.status !== undefined) {
			if (!STATUSES.includes(patch.status)) warnings.push(`unknown status ${patch.status}`);
			else task.status = patch.status;
		}
		if (patch.content !== undefined) task.content = patch.content;
		if (patch.priority !== undefined) task.priority = patch.priority;
		if (patch.deps !== undefined) warnings.push(...this.setDeps(task, patch.deps));
		this.mutate();
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
				const deps = this.tasks.get(id)?.dependsOn ?? [];
				next.push(...deps);
			}
			frontier = next;
		}
		return false;
	}

	serialize(): StoredTask[] {
		return this.list();
	}

	/** The one load path: drop malformed rows, keep the rest; ids are never reused across a restore. */
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
