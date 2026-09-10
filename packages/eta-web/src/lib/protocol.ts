/**
 * Client-side mirror of the eta-server wire protocol. Kept as a hand copy (not
 * a package import) so the web app never depends on server runtime code —
 * the JSON frames are the contract.
 */

import type { HarnessEvent, SessionView } from "@eta/core";

export interface DevFrame {
	/**
	 * Assigned by the client as the frame is folded in, so a dev list can be
	 * reconciled by key instead of replaced — the rail keeps its rows and the pause
	 * button keeps its snapshot.
	 */
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
}

/** Mirrors eta-server/src/git.ts; the workspace panel is a read-only viewer. */
export interface GitFile {
	path: string;
	origPath?: string;
	status: string;
	added?: number;
	deleted?: number;
	partial?: boolean;
}

export interface GitStatus {
	notGit: boolean;
	branch: string | null;
	groups: {
		staged: GitFile[];
		changes: GitFile[];
		untracked: GitFile[];
		conflicted: GitFile[];
	};
}

export type GitDiffKind = "index" | "worktree" | "untracked";

export interface GitDiff {
	path: string;
	kind: GitDiffKind;
	text: string;
	truncated: boolean;
}

export type ClientMessage =
	| { op: "focus"; session: string }
	| { op: "resync"; session: string }
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
	| { op: "loopCreate"; session: string; id: string; note: string; every?: string }
	| { op: "taskSet"; session: string; id: string; status: "pending" | "in_progress" | "completed" | "cancelled" }
	| { op: "btwOpen"; session: string; kind: "contextual" | "tangent" }
	| { op: "btwAnswer"; session: string; threadId: string; question: string; answer: string }
	| { op: "btwAsk"; session: string; threadId: string; question: string }
	| { op: "modelSet"; session: string; modelId: string }
	| { op: "personaSet"; session: string; personaId: string }
	| { op: "thinkingLevel"; session: string; level: "off" | "minimal" | "low" | "medium" | "high" }
	| { op: "queueRemove"; session: string; entryId: string }
	| { op: "btwSave"; session: string; threadId: string }
	| { op: "btwClear"; session: string; threadId: string }
	| { op: "stateDelete"; session: string; key: string }
	| { op: "subagentStop"; session: string; id: string }
	| { op: "compact"; session: string }
	| { op: "abort"; session: string }
	| { op: "answer"; session: string; questionId: string; response: unknown }
	| { op: "askAbort"; session: string; questionId: string }
	| { op: "session.create"; name: string; personaId: string; cwd?: string; prompt?: string; modelId?: string }
	| { op: "session.delete"; name: string }
	| { op: "session.pin"; session: string; pinned: boolean }
	| { op: "session.archive"; session: string; archived: boolean }
	| { op: "session.rename"; session: string; title: string };

/**
 * A view frame without the transcript. Mirrors the server's `SessionViewPatch`:
 * everything except the three lists that only move when the journal does, which
 * every client already holds from that session's first (whole) frame.
 */
export type SessionViewPatch = Omit<SessionView, "messages" | "systems" | "thinking">;

export const HEAVY_VIEW_FIELDS = ["messages", "systems", "thinking"] as const;

export type ServerMessage =
	| { channel: "view"; session: string; version?: number; view: SessionView }
	| { channel: "view"; session: string; version?: number; patch: SessionViewPatch }
	| { channel: "agent"; session: string; event: HarnessEvent }
	| { channel: "dev"; frame: DevFrame }
	| { type: "hello"; sessions: SidebarSession[]; attach: string | null }
	| { type: "sessions"; sessions: SidebarSession[] }
	| { type: "personas" }
	| { type: "created"; name: string }
	| { type: "deleted"; name: string }
	| { type: "error"; message: string };
