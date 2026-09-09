/**
 * Wire protocol between eta-server and any front-end (GUI-PLAN v2 W0.3).
 * The three channels are the v1 contract verbatim (SessionView truth,
 * AgentEvent interaction, telemetry dev ring), plus the GuiOps echo-drive
 * union and the new-session control messages. Everything JSON-safe.
 */

import type { HarnessEvent, SessionView } from "@eta/core";

export interface DevFrame {
	ts: number;
	session: string;
	category: string;
	action: string;
	data: unknown;
}

export type ChannelFrame =
	| { channel: "view"; session: string; view: SessionView }
	| { channel: "agent"; session: string; event: HarnessEvent }
	| { channel: "dev"; frame: DevFrame };

export interface SidebarSession {
	name: string;
	badges: string[];
	personas: string[];
}

/** The full GUI write path; identical semantics to the v1 in-process GuiOps. */
export type GuiOp =
	| { op: "focus"; session: string }
	| { op: "prompt"; session: string; text: string }
	| { op: "goal"; session: string; action: "set" | "pause" | "resume" | "clear"; objective?: string }
	| { op: "loopToggle"; session: string; id: string; paused: boolean }
	| { op: "taskSet"; session: string; id: string; status: "pending" | "in_progress" | "completed" | "cancelled" }
	| { op: "btwOpen"; session: string; kind: "contextual" | "tangent" }
	| { op: "btwAnswer"; session: string; threadId: string; question: string; answer: string }
	| { op: "btwSave"; session: string; threadId: string }
	| { op: "btwClear"; session: string; threadId: string }
	| { op: "stateDelete"; session: string; key: string }
	| { op: "subagentStop"; session: string; id: string }
	| { op: "compact"; session: string }
	| { op: "abort"; session: string }
	| { op: "answer"; session: string; questionId: string; response: unknown };

export type ControlOp =
	| { op: "session.create"; name: string; personaId: string; cwd?: string; prompt?: string }
	| { op: "session.delete"; name: string };

export type InboxOp =
	| { op: "task.create"; title: string; description: string; targetProject?: string }
	| { op: "task.approve"; id: string }
	| { op: "task.dismiss"; id: string }
	| { op: "task.clearDone" };

export interface InboxTaskJson {
	id: string;
	title: string;
	description: string;
	status: "pending" | "running" | "needs_input" | "blocked" | "done" | "failed";
	targetProject: string;
	source: { channel: string; detail?: string };
	result?: { status: string; summary: string; completedAt: number };
	dispatch?: { childSession: string; startedAt: number; finishedAt?: number };
	events: { at: number; type: string; status: string; message: string }[];
}

export type ClientMessage = GuiOp | ControlOp | InboxOp;

export type ServerMessage =
	| ChannelFrame
	| { type: "hello"; sessions: SidebarSession[]; attach: string | null; tasks: InboxTaskJson[] }
	| { type: "tasks"; tasks: InboxTaskJson[] }
	| { type: "sessions"; sessions: SidebarSession[] }
	| { type: "created"; name: string }
	| { type: "deleted"; name: string }
	| { type: "error"; message: string };

/** Per-session ring of the last N telemetry frames; full ring replays on attach. */
export class DevRing {
	private frames: DevFrame[] = [];
	private next = 0;
	private filled = false;

	private readonly capacity: number;

	constructor(capacity = 512) {
		this.capacity = capacity;
	}

	push(frame: DevFrame): void {
		this.frames[this.next] = frame;
		this.next = (this.next + 1) % this.capacity;
		if (this.next === 0) this.filled = true;
	}

	tail(filter?: string): DevFrame[] {
		const ordered = this.filled ? [...this.frames.slice(this.next), ...this.frames.slice(0, this.next)] : this.frames.slice();
		const needle = filter?.trim().toLowerCase();
		if (needle === undefined || needle === "") return ordered;
		return ordered.filter((f) => f.category.toLowerCase().includes(needle) || f.action.toLowerCase().includes(needle));
	}
}

export function encodeMessage(message: ServerMessage): string {
	return JSON.stringify(message);
}

export function decodeClientMessage(raw: string): ClientMessage {
	return JSON.parse(raw) as ClientMessage;
}
