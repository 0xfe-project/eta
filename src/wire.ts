/**
 * The wire contract between eta-server and any front-end: JSON-safe frames and
 * the client op union. One source of truth shared by the server and the web, so
 * the two can never drift apart the way a hand-copied mirror does. Runtime code
 * (the codec, the telemetry ring) stays where it is used; this file is types and
 * the one constant the split depends on.
 */

import type { ThinkingLevel } from "./types.ts";
import type { HarnessEvent } from "./harness/agent-harness.ts";
import type { SessionView } from "./harness/session-view.ts";
import type { RemoteView, RemoteWorkspace } from "./remote.ts";

export interface DevFrame {
	/** Assigned by the client as a frame folds in, so a dev list reconciles by key. */
	id?: number;
	ts: number;
	session: string;
	category: string;
	action: string;
	data: unknown;
}

export interface SidebarSession {
	name: string;
	title?: string;
	pinned?: boolean;
	archived?: boolean;
	cwd?: string;
	updated?: number;
	badges: string[];
	personas: string[];
	/** Set by the local host from persisted remote identity, never inferred from the path. */
	remote?: RemoteWorkspace;
}

/**
 * The parts of a view that only move when the journal does. Everything else in a
 * view is either small or recomputed per token, so it rides every frame; these
 * three are the transcript, and a long session's transcript is megabytes that do
 * not change while the model is writing a sentence.
 */
export const HEAVY_VIEW_FIELDS = ["messages", "systems", "thinking"] as const;

export type SessionViewPatch = Omit<SessionView, (typeof HEAVY_VIEW_FIELDS)[number]>;

export type ChannelFrame =
	| { channel: "view"; session: string; version: number; view: SessionView }
	| { channel: "view"; session: string; version: number; patch: SessionViewPatch }
	| { channel: "agent"; session: string; event: HarnessEvent }
	| { channel: "dev"; frame: DevFrame };

/** The full GUI write path; identical semantics to the v1 in-process GuiOps. */
export type GuiOp =
	| { op: "focus"; session: string }
	| { op: "resync"; session: string; from?: number }
	| {
			op: "prompt";
			session: string;
			text: string;
			mode?: "queue" | "steer";
			images?: { mime: string; dataBase64: string }[];
	  }
	| { op: "goal"; session: string; action: "set" | "pause" | "resume" | "clear"; objective?: string }
	| { op: "taskCreate"; session: string; content: string; priority?: "high" | "medium" | "low" }
	| { op: "taskUpdate"; session: string; id: string; content?: string; priority?: "high" | "medium" | "low" }
	| { op: "taskRemove"; session: string; id: string }
	| { op: "loopRemove"; session: string; id: string }
	| { op: "loopToggle"; session: string; id: string; paused: boolean }
	| { op: "loopCreate"; session: string; id: string; note: string; every?: string; cron?: string }
	| { op: "taskSet"; session: string; id: string; status: "pending" | "in_progress" | "completed" | "cancelled" }
	| { op: "btwOpen"; session: string; kind: "contextual" | "tangent" }
	| { op: "modelSet"; session: string; modelId: string }
	| { op: "personaSet"; session: string; personaId: string }
	| { op: "thinkingLevel"; session: string; level: ThinkingLevel }
	| { op: "queueRemove"; session: string; entryId: string }
	| { op: "btwAsk"; session: string; threadId: string; question: string }
	| { op: "btwAnswer"; session: string; threadId: string; question: string; answer: string }
	| { op: "btwSave"; session: string; threadId: string }
	| { op: "btwHandoff"; session: string; threadId: string }
	| { op: "btwClear"; session: string; threadId: string }
	| { op: "stateDelete"; session: string; key: string }
	| { op: "subagentStop"; session: string; id: string }
	| { op: "compact"; session: string }
	| { op: "abort"; session: string }
	| { op: "answer"; session: string; questionId: string; response: unknown }
	| { op: "askAbort"; session: string; questionId: string };

export type ControlOp =
	/**
	 * A shell-side click (menu, tray) folded back into the frames every client already
	 * listens to. The desktop app uses this when it is a client of the machine's own
	 * backend rather than the process hosting it.
	 */
	| { op: "native"; kind: "menu" | "tray" | "update"; action: string; data?: unknown }
	| { op: "session.create"; remoteId?: string; name: string; personaId: string; cwd?: string; prompt?: string; modelId?: string }
	| { op: "session.delete"; name: string }
	| { op: "session.pin"; session: string; pinned: boolean }
	| { op: "session.archive"; session: string; archived: boolean }
	| { op: "session.rename"; session: string; title: string };

export type ClientMessage = GuiOp | ControlOp;

export type ServerMessage =
	| ChannelFrame
	| { type: "hello"; sessions: SidebarSession[]; attach: string | null }
	| { type: "sessions"; sessions: SidebarSession[] }
	| { type: "personas" }
	| { type: "models_changed" }
	| { type: "remotes"; remotes: RemoteView[] }
	| { type: "search"; query: string; hits: { session: string; snippet: string }[] }
	| { type: "created"; name: string }
	| { type: "deleted"; name: string }
	| { type: "error"; message: string }
	/**
	 * Answer to a queueRemove. Needed because the chip disappearing means one of two
	 * opposite things — we took it out, or the run drained it — and only the first
	 * should put the text back in the composer or re-inject it as a steer.
	 */
	| { type: "queueAck"; session: string; entryId: string; outcome: QueueAckOutcome }
	/** Native shell → client: a menu or tray item was clicked, an update changed state. */
	| { type: "native"; kind: "menu" | "tray" | "update"; action: string; data?: unknown };

/** The lane's own vocabulary, passed through rather than translated. */
export type QueueAckOutcome = "cancelled" | "already_consumed" | "not_found";
