/**
 * Client-side mirror of the eta-server wire protocol. Kept as a hand copy (not
 * a package import) so the web app never depends on server runtime code —
 * the JSON frames are the contract.
 */

import type { HarnessEvent, SessionView } from "@eta/core";

export interface DevFrame {
	ts: number;
	session: string;
	category: string;
	action: string;
	data: unknown;
}

export interface SidebarSession {
	name: string;
	badges: string[];
	personas: string[];
}

export type ClientMessage =
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
	| { op: "answer"; session: string; questionId: string; response: unknown }
	| { op: "session.create"; name: string; personaId: string; cwd?: string; prompt?: string }
	| { op: "session.delete"; name: string }
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

export type ServerMessage =
	| { channel: "view"; session: string; view: SessionView }
	| { channel: "agent"; session: string; event: HarnessEvent }
	| { channel: "dev"; frame: DevFrame }
	| { type: "hello"; sessions: SidebarSession[]; attach: string | null; tasks: InboxTaskJson[] }
	| { type: "tasks"; tasks: InboxTaskJson[] }
	| { type: "sessions"; sessions: SidebarSession[] }
	| { type: "created"; name: string }
	| { type: "deleted"; name: string }
	| { type: "error"; message: string };
