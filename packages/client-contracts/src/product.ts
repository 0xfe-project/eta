/**
 * The product's own targets: agents, machines, projects and conversations.
 *
 * Four eager targets (`agents`, `machines`, `projects`, `conversations`) each publish one `list`
 * section, and every conversation is a target of its own (`conversations.<id>`) with `info`,
 * `members` and `timeline` sections. A session is still the upstream `sessions.<id>`: a
 * conversation member points at its session, and the transcript, the streaming text and the
 * pending question live there.
 *
 * Times are epoch milliseconds, like the rest of these contracts. Ids are opaque strings. Nothing
 * here embeds another target's rows: a conversation names its project and its agents by id, and
 * the client joins them against the lists it already holds, so renaming an agent moves one
 * section and not every conversation.
 */
import type { CallFrame } from "@eta/client-wire-proto";
import type { ThinkingLevel } from "./data";

/* ------------------------------------------------------------------ views */

/** What an agent is doing, across every conversation it is in. */
export type AgentStatus = "idle" | "working" | "waiting_for_input";

/**
 * An agent: a global configuration, not a container. Its workspace is a directory of its own on
 * the primary machine, and that directory is a project (`homeProjectId`) with the agent as its
 * steward; a private chat with the agent is a conversation in that project.
 */
export interface AgentView {
  id: string;
  name: string;
  /** Standing instructions, added to the base of the system prompt of each of its sessions. */
  instructions: string;
  /** The persona card it wears, by name. Empty means the project's default card. */
  persona: string;
  /** `provider:modelId`; null means whatever the settings choose. */
  model: string | null;
  thinkingLevel: ThinkingLevel | null;
  /** The bundles it loads, by name. */
  bundles: string[];
  /** The agent's workspace directory (on the primary machine). */
  home: string;
  homeProjectId: string;
  status: AgentStatus;
  createdAt: number;
  updatedAt: number;
}

export type MachineKind = "primary" | "daemon" | "ssh";
export type MachineStatus = "online" | "offline" | "pending" | "revoked";

/**
 * A computer sessions can run on: the primary, or a machine that runs the daemon. A daemon is
 * `pending` from the moment it exchanges its install code until the user approves its
 * fingerprint, `online` while its link is up, `offline` while it is not, and `revoked` for good.
 */
export interface MachineView {
  id: string;
  kind: MachineKind;
  name: string;
  status: MachineStatus;
  /** The digest of the key a daemon enrolled with (or an SSH host key); null for the primary. */
  fingerprint: string | null;
  /** The machine's home directory, when it has said. */
  home: string | null;
  os: string | null;
  /** How many task runs the machine works on at once; the rest wait in the queue. */
  maxActiveRuns: number;
  createdAt: number;
  lastSeenAt: number | null;
}

export type ProjectKind = "project" | "agent_home";

/** A directory on a machine, with an optional steward: the agent who takes what nobody is named for. */
export interface ProjectView {
  id: string;
  machineId: string;
  /** Absolute, and unique per machine. */
  path: string;
  name: string;
  kind: ProjectKind;
  stewardId: string | null;
  archived: boolean;
  createdAt: number;
  updatedAt: number;
}

export type ConversationKind = "group" | "direct";

/** `idle` unless one of the member's replies in the conversation is in flight. */
export type MemberStatus =
  | "idle"
  | "queued"
  | "working"
  | "waiting_for_input"
  | "stopping";

/**
 * Where one member stands in a conversation: its session (null until its first wake), how far it
 * has been shown the timeline, and whether it is answering now.
 */
export interface MemberView {
  agentId: string;
  sessionId: string | null;
  /** The newest timeline `seq` this member has been told about (or written itself). */
  lastSeq: number;
  status: MemberStatus;
}

/** One row of the conversation list. */
export interface ConversationSummary {
  id: string;
  projectId: string;
  kind: ConversationKind;
  name: string;
  archived: boolean;
  /** Who takes a message that names nobody: the conversation's own pick, else its project's. */
  stewardId: string | null;
  participants: MemberView[];
  lastSeq: number;
  readSeq: number;
  /** Rows past `readSeq` that the user did not write. */
  unread: number;
  /** The newest row's text, trimmed to a line. */
  preview: string;
  lastMessageAt: number | null;
  createdAt: number;
  updatedAt: number;
}

/** The conversation's own facts (the `info` section). */
export interface ConversationInfo {
  id: string;
  projectId: string;
  kind: ConversationKind;
  name: string;
  goal: string;
  decided: string;
  archived: boolean;
  /** The effective steward (see `ConversationSummary.stewardId`). */
  stewardId: string | null;
  /** The conversation's own pick; null means it follows its project. */
  stewardOverrideId: string | null;
  readSeq: number;
  lastSeq: number;
  createdAt: number;
  updatedAt: number;
}

/**
 * What a row is. `task_draft` and `task_card` are the task board's (see `tasks.ts`): a draft an
 * agent proposes, and the same row once the user has confirmed it.
 */
export type MessageKind =
  | "message"
  | "mention"
  | "system"
  | "task_draft"
  | "task_card";

/**
 * Where a reply stands. A user's or a system row is written straight to `done`. A reply is
 * `queued` until its session is free, `working` while it runs, `waiting_for_input` while the
 * session asks the user something, `stopping` once a stop was heard, and ends `done`, `failed` or
 * `stopped`.
 */
export type MessageStatus =
  | "queued"
  | "working"
  | "waiting_for_input"
  | "done"
  | "failed"
  | "stopping"
  | "stopped";

/**
 * One tool call a reply made, kept on the reply's row when it ends (`data.activity`, oldest
 * first) so the page can draw the same cards after the run as during it. Everything is short:
 * `input` is the call's arguments with long values cut, `output` is the head of the result text,
 * and `details` is what the tool left for the page (`publish_artifact` names its artifact) and is
 * dropped when it is large. A call the run ended before the result of is `failed`.
 */
export interface ToolActivity {
  id: string;
  name: string;
  input?: unknown;
  output?: string;
  status: "completed" | "failed";
  details?: unknown;
}

/** One row of a conversation's timeline. */
export interface MessageView {
  id: string;
  conversationId: string;
  /** Per conversation, dense, and the order the timeline is read in. A reply keeps the place it started in. */
  seq: number;
  kind: MessageKind;
  author: "user" | "agent" | "system";
  /** The author when it is an agent (the agent may have been deleted since). */
  agentId: string | null;
  text: string;
  /** What the agent worked through on the way to `text`; empty when the model does not reason. */
  thinking: string;
  status: MessageStatus;
  /** Grows on every change to the row, so a client can tell newer from a second copy. */
  revision: number;
  /** The agents this row wakes. */
  mentions: string[];
  /** The user row this branch of the conversation descends from. */
  rootMessageId: string | null;
  /** For a reply, the row that woke it. */
  replyToId: string | null;
  /**
   * What the row carries beyond its text. A user row has `woke` (agents given a reply row) and
   * `joined` (agents whose turn it steered) and, when files came with it, `attachments`
   * (`AttachmentView[]`); a system row has the `event` it records (`steward`
   * with `from`/`to`, `wake_budget`); a failed reply has the `code` it failed with (`restart`,
   * `run_failed`, `unavailable`, `gone`) and, like any reply that ran, the `activity` of its
   * tool calls (`ToolActivity[]`, absent when it made none); a `task_draft` row has `TaskDraftData` and a
   * `task_card` row has `TaskCardData`.
   */
  data: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

/** The newest window of a timeline, oldest first. */
export interface TimelineSection {
  messages: MessageView[];
  /** Older rows exist; `conversations.history` pages back to them. */
  hasMore: boolean;
  /**
   * Messages written but not in the conversation yet: every lane that would have answered them was
   * busy when they were sent. The composer draws them above its box, and `recall` takes one back
   * out — it never became a message, so nothing is lost from the record.
   */
  held: MessageView[];
}

/* ------------------------------------------------------------------ sections */

/** The sections each product target publishes. A lookup table for reading, like the session's. */
export interface AgentsSections {
  list: AgentView[];
}
export interface MachinesSections {
  list: MachineView[];
}
export interface ProjectsSections {
  list: ProjectView[];
}
export interface ConversationsSections {
  list: ConversationSummary[];
}
/** `conversations.<id>`: registered for every conversation, from startup or from its creation. */
export interface ConversationSections {
  info: ConversationInfo;
  members: MemberView[];
  timeline: TimelineSection;
}

/* ------------------------------------------------------------------ agents */

/** The actions this target has. One list, so the wire and the plugin cannot disagree. */
export const AGENT_ACTIONS = ["create", "update", "delete", "direct"] as const;
export type AgentAction = (typeof AGENT_ACTIONS)[number];

export interface AgentFields {
  name: string;
  instructions?: string;
  persona?: string;
  /** `provider:modelId`; null clears it. */
  model?: string | null;
  thinkingLevel?: ThinkingLevel | null;
  /** The bundles to load, by name. */
  bundles?: string[];
}

/** Valid requests from a client. The server still validates untrusted JSON at runtime. */
export interface AgentArgs {
  /** Makes the agent, its workspace directory and its home project. */
  create: AgentFields;
  update: { agentId: string } & Partial<AgentFields>;
  /** Clears it as steward, archives the chats it was alone in, and leaves its directory on disk. */
  delete: { agentId: string };
  /** The private chat with the agent, made the first time and found every time after. */
  direct: { agentId: string };
}
export interface AgentResults {
  create: { agent: AgentView };
  update: { agent: AgentView };
  delete: { agentId: string };
  direct: { conversation: ConversationSummary };
}
export type AgentCall = {
  [A in AgentAction]: Omit<CallFrame, "target" | "action" | "args"> & {
    target: "agents";
    action: A;
    args: AgentArgs[A];
  };
}[AgentAction];

/* ------------------------------------------------------------------ machines */

export const MACHINE_ACTIONS = [
  "rename",
  "enroll",
  "approve",
  "revoke",
  "setMaxActiveRuns",
] as const;
export type MachineAction = (typeof MACHINE_ACTIONS)[number];

export interface MachineArgs {
  rename: { machineId: string; name: string };
  /**
   * Make a one-time install code (good for 24 hours, once). `url` is the address the machine
   * should dial: what the user's browser sees, because the host cannot know its public name.
   */
  enroll: { name?: string; url?: string };
  /** Let a pending machine in. `fingerprint` must be the one the machine printed. */
  approve: { machineId: string; fingerprint: string };
  /** Close the door on a machine. Sessions already running there are not stopped. */
  revoke: { machineId: string };
  /** How many task runs the machine works on at once, 1 to 20; runs already going go on. */
  setMaxActiveRuns: { machineId: string; maxActiveRuns: number };
}
export interface MachineResults {
  rename: { machine: MachineView };
  enroll: { code: string; expiresAt: number; url: string; command: string };
  approve: { machine: MachineView };
  revoke: { machine: MachineView };
  setMaxActiveRuns: { machine: MachineView };
}
export type MachineCall = {
  [A in MachineAction]: Omit<CallFrame, "target" | "action" | "args"> & {
    target: "machines";
    action: A;
    args: MachineArgs[A];
  };
}[MachineAction];

/* ------------------------------------------------------------------ projects */

export const PROJECT_ACTIONS = [
  "create",
  "update",
  "setSteward",
  "files",
] as const;
export type ProjectAction = (typeof PROJECT_ACTIONS)[number];

export interface ProjectArgs {
  /** The machine defaults to the primary. The path must be an existing directory on it. */
  create: {
    path: string;
    machineId?: string;
    name?: string;
    stewardId?: string | null;
  };
  update: { projectId: string; name?: string; archived?: boolean };
  /** Null clears it. Writes a system row into every conversation that follows the project. */
  setSteward: { projectId: string; agentId: string | null };
  /**
   * The project's files, relative to its directory, listed on the project's own machine. Shallow
   * files come first; `limit` (default 2000, at most 5000) caps the list.
   */
  files: { projectId: string; limit?: number };
}
export interface ProjectResults {
  /** `existed` when the machine already had a project at that path: that one is returned. */
  create: { project: ProjectView; existed: boolean };
  update: { project: ProjectView };
  setSteward: { project: ProjectView };
  /** `truncated` when more files exist than were returned. */
  files: { files: string[]; truncated: boolean };
}
export type ProjectCall = {
  [A in ProjectAction]: Omit<CallFrame, "target" | "action" | "args"> & {
    target: "projects";
    action: A;
    args: ProjectArgs[A];
  };
}[ProjectAction];

/* ------------------------------------------------------------------ conversations */

export const CONVERSATION_ACTIONS = [
  "create",
  "recall",
  "update",
  "invite",
  "remove",
  "setSteward",
  "send",
  "stop",
  "read",
  "history",
  "attach",
  "unattach",
] as const;
export type ConversationAction = (typeof CONVERSATION_ACTIONS)[number];

export interface ConversationArgs {
  create: { projectId: string; name?: string; agentIds?: string[] };
  /**
   * Take back a message that is still waiting for a lane. False when it is no longer held: a lane
   * picked it up, and the words are in the conversation now.
   */
  recall: { conversationId: string; messageId: string };
  update: {
    conversationId: string;
    name?: string;
    goal?: string;
    decided?: string;
    archived?: boolean;
  };
  invite: { conversationId: string; agentId: string };
  /** Takes a member out. Not for a direct chat, which is the agent and the user. */
  remove: { conversationId: string; agentId: string };
  /** Null makes the conversation follow its project again. */
  setSteward: { conversationId: string; agentId: string | null };
  /**
   * Say something. `mentions` are agent ids; a message that names nobody goes to the steward.
   * `mode` is how it joins an agent that is already answering: `queue` (the default) waits for
   * that reply to end and gets one of its own, `steer` changes the turn in flight. `clientId`
   * makes a retry the same message.
   */
  send: {
    conversationId: string;
    text: string;
    mentions?: string[];
    mode?: "queue" | "steer";
    clientId?: string;
    /**
     * Files uploaded with `attach`, by id (at most `MAX_ATTACHMENTS`). The text may be empty when
     * there are some. They are handed to every agent the message wakes, as files it can open.
     */
    attachments?: string[];
  };
  /**
   * One chunk of a file on its way to the conversation, in order from `index` 0; `data` is the
   * chunk in base64 (at most `ATTACH_CHUNK_BYTES` of file). `uploadId` is chosen by the client
   * and becomes the attachment's id, so a chunk resent after a lost reply is the same upload.
   * The reply has the `attachment` once `last` was sent.
   */
  attach: {
    conversationId: string;
    uploadId: string;
    name: string;
    contentType?: string;
    index: number;
    last?: boolean;
    data: string;
  };
  /** Takes back an attachment that has not been sent. */
  unattach: { conversationId: string; attachmentId: string };
  /** One reply (`messageId`), or every reply in flight in the conversation. */
  stop: { conversationId: string; messageId?: string };
  /** Moves the user's read mark forward to `seq` (never back, never past the newest row). */
  read: { conversationId: string; seq: number };
  /** The page of rows before `beforeSeq` (the newest when omitted), oldest first. */
  history: { conversationId: string; beforeSeq?: number; limit?: number };
}

/** A file attached to a message (`data.attachments` of the user's row lists them). */
export interface AttachmentView {
  id: string;
  name: string;
  contentType: string;
  size: number;
}

/** A file at most this large, and a message at most this many files. */
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const MAX_ATTACHMENTS = 10;
/** The most file bytes one `attach` call carries. */
export const ATTACH_CHUNK_BYTES = 384 * 1024;

/** What `send` did. */
export interface SendResult {
  /** The user's row. */
  message: MessageView;
  /** The reply rows it started, one per agent woken, in the order they were named. */
  replies: MessageView[];
  /** Agents whose turn in flight the message joined (`steer`); they got no new reply row. */
  joined: string[];
  /** Nobody was woken and nobody joined: no steward, and more than one member to choose from. */
  nobody: boolean;
}

export interface HistoryResult {
  conversationId: string;
  messages: MessageView[];
  hasMore: boolean;
}

export interface ConversationResults {
  create: { conversation: ConversationSummary };
  update: { conversation: ConversationSummary };
  invite: { conversation: ConversationSummary };
  remove: { conversation: ConversationSummary };
  setSteward: { conversation: ConversationSummary };
  send: SendResult;
  stop: { stopped: MessageView[] };
  read: { conversation: ConversationSummary };
  history: HistoryResult;
  attach: { attachment: AttachmentView | null };
  unattach: { removed: boolean };
}
export type ConversationCall = {
  [A in ConversationAction]: Omit<CallFrame, "target" | "action" | "args"> & {
    target: "conversations";
    action: A;
    args: ConversationArgs[A];
  };
}[ConversationAction];
