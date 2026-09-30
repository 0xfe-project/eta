/**
 * The shapes a client draws with. These are *data contracts*, not the pipe: the protocol
 * itself (calls, state, events) is in `index.ts` and knows nothing about sessions, git or
 * plugins. A section the server never sends is simply a section the client never sees.
 */
import type { AgentMessage, AskPayload, GoalState, StoredTask, ThinkingLevel, Usage } from "@eta/core";
import type { BtwThread, SubagentRecord } from "@eta/harness";

/** A plugin's front-end, as data. The server never renders and never runs client code. */
export interface PluginPanelDescriptor {
	name: string;
	title: string;
	slot: PluginSlot;
	/** Where the sandbox loads from, when the plugin has a front-end at all. */
	entry?: string | undefined;
	/** The state target that feeds this panel: the client subscribes to what it draws. */
	state?: string | undefined;
	multiple?: boolean | undefined;
}

export type PluginSlot = "sidebar" | "panel" | "overlay" | "statusbar";

/** A plugin the server has, as `hello` reports it. */
export interface MountedPlugin {
	name: string;
	version?: string | undefined;
	/** How it was loaded: shipped with the server, or scanned from the user's directories. */
	source: "bundled" | "user";
	descriptor?: PluginPanelDescriptor | undefined;
	/** Set when the plugin failed to load: the pipe is fine, this plugin is not. */
	error?: string | undefined;
}

/** What the prompt layer reports about the blocks it composed. */
export interface ViewDiagnostics {
	stableChars: number;
	adaptiveChars: number;
	sections: { name: string; stable: boolean; text: string }[];
}

// ------------------------------------------------------------------- session sections

/** The session's own slice: who it is, and whether something is happening right now. */
export interface ViewCore {
	session: string;
	cwd?: string | undefined;
	running: boolean;
	/** The in-flight assistant message while a run streams; absent once committed. */
	streaming?: AgentMessage | undefined;
}

export interface ViewMessageRow {
	entryId: string;
	seq: number;
	at: number;
	message: AgentMessage;
}

export interface SessionViewMessageRow extends ViewMessageRow {}

/** A system row: something the session did that is not a message (goal, ask, btw…). */
export interface SessionViewSystemRow {
	entryId: string;
	seq: number;
	kind: string;
	args: Record<string, string>;
}

export interface TranscriptSection {
	messages: ViewMessageRow[];
	/** Messages older than this window exist in the journal; set once paging starts. */
	messagesBefore?: number | undefined;
}

export interface SessionViewQueuedItem {
	entryId: string;
	kind: string;
	text: string;
	/** Attachments ride as attachments: a pull-back restores chips, not base64 text. */
	images?: { mime: string; dataBase64: string }[] | undefined;
}

/** One btw thread as the panel sees it. */
export type SessionViewBtwThread = Pick<BtwThread, "id" | "kind" | "exchanges" | "saveState" | "pending" | "error">;

export type SessionViewSubagent = Pick<SubagentRecord, "id" | "status" | "turns">;

/**
 * The sections a session's state is *known* to have today.
 *
 * This is a lookup table for reading, never the container's type: a plugin contributes
 * `git`, `ssh`, whatever it owns, and neither the protocol nor the server learns its name.
 */
export interface SessionViewSections {
	core: ViewCore;
	transcript: TranscriptSection;
	systems: { rows: SessionViewSystemRow[] };
	thinking: { rows: string[] };
	branch: { tipId: string | null; compactionEpoch: number };
	usage: Usage;
	goal: GoalState | undefined;
	tasks: StoredTask[];
	sideThread: SessionViewBtwThread[];
	subagents: SessionViewSubagent[];
	personas: string[];
	model: { id: string; thinkingLevel: ThinkingLevel };
	queue: { items: SessionViewQueuedItem[] };
	tools: { name: string; description: string }[];
	metrics: { tokensPerSec: number };
	prompt: ViewDiagnostics | undefined;
	memory: { chars: number };
	state: { keys: string[] };
	ask: { pending?: AskPayload | undefined; deadline?: number | undefined };
	[name: string]: unknown;
}

export type SectionName = keyof SessionViewSections & string;

/** One session's state, as the client keeps it: sections plus their revisions. */
export interface SessionState {
	sections: Record<string, unknown>;
	revisions: Record<string, string>;
}

/** A row of the session list (the `sessions` target's state). */
export interface SidebarSession {
	id: string;
	title?: string | undefined;
	pinned?: boolean | undefined;
	archived?: boolean | undefined;
	cwd?: string | undefined;
	createdAt?: number | undefined;
	updated?: number | undefined;
	badges: string[];
	personas: string[];
	/** Why this session cannot be read, when it cannot (the store keeps the row). */
	broken?: string | undefined;
}
