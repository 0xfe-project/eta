/**
 * Agent Inbox lite (GUI-PLAN v2 W5.1): a task store backed by tasks.json with
 * an append-only event audit. Remote channels are not wired yet (source stays
 * a union); dispatch to a project session only ever happens after a local
 * approve, and the server closes the loop on child-session lifecycle events —
 * the last mile picot left unimplemented.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

export type TaskStatus = "pending" | "running" | "needs_input" | "blocked" | "done" | "failed";

export interface TaskEvent {
	at: number;
	type: "created" | "approved" | "dispatched" | "needs_input" | "completed" | "failed" | "dismissed";
	status: TaskStatus;
	message: string;
}

export interface InboxTask {
	id: string;
	title: string;
	description: string;
	status: TaskStatus;
	targetProject: string;
	source: { channel: "local" | string; detail?: string };
	result?: { status: TaskStatus; summary: string; completedAt: number };
	dispatch?: { childSession: string; startedAt: number; finishedAt?: number };
	events: TaskEvent[];
}

const ORDER: TaskStatus[] = ["pending", "needs_input", "blocked", "running", "failed", "done"];

export class InboxStore {
	private tasks: InboxTask[] = [];
	private readonly listeners = new Set<(tasks: InboxTask[]) => void>();
	private readonly file: string;

	constructor(dir: string) {
		this.file = `${dir}/tasks.json`;
		if (existsSync(dir) && existsSync(this.file)) {
			try {
				const parsed = JSON.parse(readFileSync(this.file, "utf8")) as InboxTask[];
				if (Array.isArray(parsed)) this.tasks = parsed.filter((task) => typeof task.id === "string" && Array.isArray(task.events));
			} catch {
				/* corrupted store starts empty; the next write heals it */
			}
		} else {
			mkdirSync(dir, { recursive: true });
		}
	}

	list(): InboxTask[] {
		return [...this.tasks].sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status));
	}

	of(id: string): InboxTask | undefined {
		return this.tasks.find((task) => task.id === id);
	}

	create(input: { title: string; description: string; targetProject: string; source?: { channel: string; detail?: string } }): InboxTask {
		const task: InboxTask = {
			id: randomUUID().slice(0, 8),
			title: input.title,
			description: input.description,
			status: "pending",
			targetProject: input.targetProject,
			source: input.source ?? { channel: "local" },
			events: [{ at: Date.now(), type: "created", status: "pending", message: "task created" }],
		};
		this.tasks.push(task);
		this.persist();
		return task;
	}

	approve(id: string, message: string): InboxTask | undefined {
		return this.mutate(id, (task) => {
			task.status = "running";
			task.dispatch = { childSession: `task-${task.id}`, startedAt: Date.now() };
			this.audit(task, "dispatched", "running", message);
		});
	}

	needsInput(id: string, message: string): InboxTask | undefined {
		return this.mutate(id, (task) => {
			task.status = "needs_input";
			this.audit(task, "needs_input", "needs_input", message);
		});
	}

	complete(id: string, summary: string): InboxTask | undefined {
		return this.mutate(id, (task) => {
			task.status = "done";
			task.result = { status: "done", summary, completedAt: Date.now() };
			if (task.dispatch !== undefined) task.dispatch.finishedAt = Date.now();
			this.audit(task, "completed", "done", summary);
		});
	}

	fail(id: string, reason: string): InboxTask | undefined {
		return this.mutate(id, (task) => {
			task.status = "failed";
			task.result = { status: "failed", summary: reason, completedAt: Date.now() };
			if (task.dispatch !== undefined) task.dispatch.finishedAt = Date.now();
			this.audit(task, "failed", "failed", reason);
		});
	}

	dismiss(id: string): boolean {
		const before = this.tasks.length;
		this.tasks = this.tasks.filter((task) => task.id !== id);
		this.persist();
		return this.tasks.length < before;
	}

	clearDone(): number {
		const before = this.tasks.length;
		this.tasks = this.tasks.filter((task) => task.status !== "done");
		this.persist();
		return before - this.tasks.length;
	}

	childOf(session: string): InboxTask | undefined {
		return this.tasks.find((task) => task.dispatch?.childSession === session);
	}

	onChanged(listener: (tasks: InboxTask[]) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private mutate(id: string, fn: (task: InboxTask) => void): InboxTask | undefined {
		const task = this.of(id);
		if (task === undefined) return undefined;
		fn(task);
		this.persist();
		return task;
	}

	private audit(task: InboxTask, type: TaskEvent["type"], status: TaskStatus, message: string): void {
		task.events.push({ at: Date.now(), type, status, message });
	}

	private persist(): void {
		mkdirSync(this.file.slice(0, this.file.lastIndexOf("/")), { recursive: true });
		writeFileSync(this.file, JSON.stringify(this.tasks, null, "\t"), "utf8");
		for (const listener of [...this.listeners]) listener(this.list());
	}
}

/** The dispatch prompt: task context + stop-to-ask + closing summary rules. */
export function buildTaskPrompt(task: InboxTask): string {
	return [
		`[Agent Inbox task ${task.id}] ${task.title}`,
		task.description,
		"",
		"如果需要澄清,停下并把问题通过 ask_user 报出来(status 会记为 needs_input)。",
		"完成后总结:改了什么、如何验证、有什么风险。",
	].join("\n");
}
