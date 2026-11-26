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
import type { DaemonInstall } from "./link";

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
  /** The persona card it wears, by name. Empty for external runtimes, or the project's default card on `"eta"`. */
  persona: string;
  /** What answers for it: eta's own loop, or an external runtime on the machine. */
  runtime: AgentRuntime;
  /**
   * `provider:modelId`. On eta's own loop it names a model: the host refuses to save one without,
   * and one left from before is told to choose when asked to answer. On an external runtime it is
   * `runtime:modelId` in that runtime's names, and null means the runtime's default.
   */
  model: string | null;
  thinkingLevel: ThinkingLevel | null;
  /**
   * The machine it runs on, when it is pinned to one. Built-in `"eta"` agents may use `null` to
   * follow the project or run across machines when pinned; external runtimes (`runtime !== "eta"`)
   * are always pinned to one machine and cannot be used across machines.
   */
  machineId: string | null;
  /** The plugins it has enabled, by name. */
  plugins: string[];
  /** Those of them its sessions skip for now: they need configuring, or are gone. */
  skippedPlugins: string[];
  /** `captain` for the one El Capitan agent; null for every ordinary agent. */
  systemRole: "captain" | null;
  /** The seed its avatar is drawn from; null draws it from `id`, the face every agent starts with. */
  avatarSeed: string | null;
  /** The last few seeds it wore, newest first: the current one, then the ones it can go back to. */
  avatarSeeds: string[];
  /** The agent's workspace directory (on the primary machine). */
  home: string;
  homeProjectId: string;
  status: AgentStatus;
  createdAt: number;
  updatedAt: number;
}

export type MachineKind = "primary" | "daemon" | "ssh";
export type MachineStatus = "online" | "offline" | "pending";

/**
 * A computer sessions can run on: the primary, or a machine that runs the daemon. A daemon is
 * `pending` from the moment it exchanges its install code until the user approves its
 * fingerprint, `online` while its link is up, and `offline` while it is not.
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
  /** The daemon's build as it last said; null for the primary and before a daemon reports. */
  version: string | null;
  /** `<os>-<arch>`, what its build is for. */
  platform: string | null;
  /** How the daemon was started: only a `service` can be replaced from here. */
  install: DaemonInstall | null;
  protocol: number | null;
  /** Why it could not be brought up to date, the last time that was tried. */
  updateError: string | null;
  /** The Tailscale node it is, when it came in over the tailnet. */
  tailnetNode: string | null;
  /**
   * Against the daemon build this primary carries: `current`, `outdated` (another version),
   * `updating` (being replaced now), or null when there is nothing to compare (the primary, no
   * builds carried, or a daemon that has not said).
   */
  build: "current" | "outdated" | "updating" | null;
}

export type ProjectKind = "project" | "agent_home";

/** A directory on a machine. Stewards belong to groups, not projects (`ConversationSummary.stewardId`). */
export interface ProjectView {
  id: string;
  machineId: string;
  /** Absolute, and unique per machine. */
  path: string;
  /**
   * The path as its machine writes it for a person: `~/Developer/eta` under the machine's home,
   * `~\code\eta` on Windows, the path itself elsewhere. Clients show it as it is.
   */
  display: string;
  name: string;
  kind: ProjectKind;
  /** The agent whose own workspace this is: set on an `agent_home`, null on any other project. */
  ownerAgentId: string | null;
  archived: boolean;
  createdAt: number;
  updatedAt: number;
}

/**
 * `group`, or `captain` for Captain's own conversation, which is not a row of `conversations.list`
 * and is reached through `captain.direct`.
 *
 * A private chat is a group of one (`agentOnlyChat`), not a kind of its own: the table's CHECK has
 * allowed only `group` and `captain` since migration 0061 rewrote every `direct` row.
 */
export type ConversationKind = "group" | "captain";

/**
 * Whether a conversation is one agent's own chat: a group whose only member is that agent.
 *
 * This is what "talk to this agent" means: a private chat is a group of one. Three things are
 * deliberately left to the caller:
 *
 * - `archived`: an agent's own row hides a chat that is put away, the archive shows it. The
 *   predicate says what the conversation *is*, not whether it should be drawn here.
 * - the project: a caller that claims a conversation for an agent's row also checks it is in that
 *   agent's home project (`AgentView.homeProjectId`), which is where the client makes it. A group
 *   of one in someone else's project is still that project's row.
 * - Captain's own conversation, which is `captain` and not a group of anything.
 */
export function agentOnlyChat(
  conversation: Pick<ConversationSummary, "kind" | "participants"> | undefined,
  agentId: string | null | undefined,
): boolean {
  // Everything a page reads is optional while it loads, so nothing to look at is simply "no".
  if (conversation === undefined || agentId === null || agentId === undefined)
    return false;
  return (
    conversation.kind === "group" &&
    conversation.participants.length === 1 &&
    conversation.participants[0]?.agentId === agentId
  );
}

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
  /** The one reply currently running in this conversation, when it can be stopped individually. */
  activeReplyId?: string;
}

/** One row of the conversation list. */
export interface ConversationSummary {
  id: string;
  projectId: string;
  kind: ConversationKind;
  name: string;
  archived: boolean;
  /**
   * Who takes a user message that names nobody: one of the members, or null for none. Nobody is
   * ever added to the conversation for it; with none, a group of one member gives it to that one
   * and a larger group wakes nobody.
   */
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
  /** A member, or null for none (see `ConversationSummary.stewardId`). */
  stewardId: string | null;
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

/**
 * One step of a reply's process, in the order the run took it (`data.process`): what it thought,
 * what it said along the way, and which tool it called (`id` names an entry of `data.activity`).
 * The text at the end, after the last thought or call, is the reply's answer; the steps before it
 * are drawn in the process, so a finished reply reads in the order it was written. Long texts are
 * cut.
 */
export type ProcessStep =
  | { type: "thinking"; text: string }
  | { type: "text"; text: string }
  | { type: "tool"; id: string }
  /** The run took words the user put into it (a steer): where in the process they arrived. */
  | { type: "steer" };

/** One row of a conversation's timeline. */
export interface MessageView {
  id: string;
  conversationId: string;
  /** Per conversation, dense, and the order the timeline is read in. A reply keeps the place it started in. */
  seq: number;
  kind: MessageKind;
  author: "user" | "agent" | "system" | "captain";
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
   * `joined` (agents whose turn it steered), `into` (the message or card row it was put into, see
   * `ConversationArgs["send"]["into"]`) and, when files came with it, `attachments`
   * (`AttachmentView[]`) and, when the sender folded pastes in it, `blocks` (the
   * `ConversationArgs["send"]["blocks"]` pairs it sent, verbatim); a system row has the `event`
   * it records (`steward` with `from`/`to`, `wake_budget`); a failed reply has the `code` it
   * failed with (`restart`, `run_failed`, `unavailable`, `gone`) and, like any reply that ran,
   * the `activity` of its tool calls (`ToolActivity[]`, absent when it made none) and the
   * `process` they were steps of (`ProcessStep[]`, absent from rows written before it); a
   * `task_draft` row has `TaskDraftData` and a `task_card` row has `TaskCardData`.
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
  /** The installs over SSH of this host's life, newest first (the last few). */
  installs: MachineInstallView[];
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
export const AGENT_ACTIONS = [
  "create",
  "update",
  "delete",
  "runtimes",
  "runtimeAccount",
] as const;
export type AgentAction = (typeof AGENT_ACTIONS)[number];

/**
 * What can answer for an agent. `eta` is eta's own loop on eta's models; the others are agent
 * runtimes installed on the machine (Claude Code, Codex, OpenCode, Pi, Antigravity, Grok Build, Qwen Code), each
 * with its own tools, context and models, that the agent's sessions hand their runs to.
 */
export const AGENT_RUNTIMES = [
  "eta",
  "claude",
  "codex",
  "opencode",
  "pi",
  "antigravity",
  "grok",
  "qwen",
] as const;
/** The built-in runtimes: eta's own loop and the ones reached through oar. */
export type BuiltinAgentRuntime = (typeof AGENT_RUNTIMES)[number];
/**
 * A runtime id. Beyond the built-in ones, every ACP agent the host's `acp.json` lists is a
 * runtime of its own, `acp.<id>`.
 */
export type AgentRuntime = BuiltinAgentRuntime | `acp.${string}`;

const ACP_RUNTIME = /^acp\.[a-z0-9][a-z0-9-]*$/;

/** Whether a string names a runtime: a built-in one, or `acp.<slug>`. */
export function isAgentRuntime(value: string): value is AgentRuntime {
  return (
    (AGENT_RUNTIMES as readonly string[]).includes(value) ||
    ACP_RUNTIME.test(value)
  );
}

/**
 * Whether a runtime runs outside eta's own loop (any built-in OAR runtime or custom ACP runtime).
 * External runtimes never carry a persona card and are strictly bound to one machine.
 */
export function isExternalRuntime(runtime: AgentRuntime): boolean {
  return runtime !== "eta";
}

/** A model an external runtime can run, in its own names. */
export interface AgentRuntimeModel {
  /** What its `--model` takes; an agent stores it as `runtime:id`. */
  id: string;
  name: string;
  /** The one it runs when told none. */
  default: boolean;
  /**
   * Its reasoning-effort levels, in the runtime's spelling (`none` is its off switch); empty when
   * it has no effort setting for this model.
   */
  efforts: string[];
  /**
   * The runtime has an effort setting but could not say its levels this time (oar's
   * `effortUnavailableReason`): `efforts` is empty and means nothing. Older daemons never send it.
   */
  effortsUnknown?: boolean | undefined;
}

/** An external runtime, as a machine has it. */
export interface AgentRuntimeInfo {
  /** `claude`, `codex`, ... or `acp.<id>`. */
  id: Exclude<AgentRuntime, "eta">;
  label: string;
  /** Installed and signed in; installed and not signed in; not installed; or asking failed. */
  status: "available" | "unauthenticated" | "missing" | "error";
  version?: string;
  detail?: string;
  models: AgentRuntimeModel[];
}

/**
 * Who a runtime is signed in as and how much of its plan is used, as the runtime itself reports
 * it. Read only: asking never signs it in or out. A part is absent when the runtime has no way to
 * say it (OpenCode and Pi have neither).
 */
export interface AgentRuntimeAccount {
  /** From the runtime's own status query, which may refresh its stored sign-in. */
  auth?:
    | {
        kind: "logged_in";
        email?: string;
        /** `max`, `pro`, ... */
        plan?: string;
        /** How it is signed in, in the runtime's words (`claude.ai`, `chatgpt`, `apiKey`, ...). */
        method?: string;
      }
    | { kind: "logged_out"; detail?: string }
    /** The query failed or could not tell. */
    | { kind: "unknown"; detail?: string };
  usage?:
    | {
        kind: "available";
        plan?: string;
        email?: string;
        rateLimited: boolean;
        windows: {
          label: string;
          /** From 0 to 1. */
          usedRatio: number;
          /** ISO 8601, when the runtime says. */
          resetsAt?: string;
        }[];
      }
    /** Signed out, or its sign-in cannot read usage: `reason` is the runtime's code. */
    | { kind: "reauth_required"; reason?: string }
    | { kind: "unsupported"; reason?: string }
    /** Asking failed. */
    | { kind: "error"; detail: string };
}

export interface AgentFields {
  name: string;
  instructions?: string;
  persona?: string;
  /** What answers for it; `eta` when omitted on create. */
  runtime?: AgentRuntime;
  /** `provider:modelId` (`runtime:modelId` on an external runtime); null clears it. */
  model?: string | null;
  thinkingLevel?: ThinkingLevel | null;
  /** The machine to run on; null follows the project (allowed only for `"eta"` agents). */
  machineId?: string | null;
  /** The plugins it has enabled. Adding one that cannot be enabled is refused. */
  plugins?: string[];
}

/** Valid requests from a client. The server still validates untrusted JSON at runtime. */
export interface AgentArgs {
  /** Makes the agent, its workspace directory and its home project. */
  create: AgentFields;
  /** `avatarSeed` draws its avatar from that seed and puts it at the front of `avatarSeeds`. */
  update: { agentId: string; avatarSeed?: string } & Partial<AgentFields>;
  /** Clears it as steward, archives the chats it was alone in, and leaves its directory on disk. */
  delete: { agentId: string };
  /**
   * The external runtimes a machine has, with their models: the primary's, or `machineId`'s (which
   * has to be online to be asked). `fresh` asks the runtimes again.
   */
  runtimes: { fresh?: boolean; machineId?: string };
  /** A built-in runtime's sign-in and plan usage on the primary or `machineId` (online). */
  runtimeAccount: { runtime: string; machineId?: string };
}
export interface AgentResults {
  create: { agent: AgentView };
  update: {
    agent: AgentView;
    /**
     * The level the agent had, cleared to the model's default because the model it moved to does
     * not take it. Absent when nothing was cleared.
     */
    thinkingCleared?: ThinkingLevel | undefined;
  };
  delete: { agentId: string };
  runtimes: { runtimes: AgentRuntimeInfo[] };
  runtimeAccount: { account: AgentRuntimeAccount };
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
  "removePreview",
  "remove",
  "setMaxActiveRuns",
  "upgrade",
  "discover",
  "install",
  "addresses",
  "phoneLink",
] as const;
export type MachineAction = (typeof MACHINE_ACTIONS)[number];

export interface MachineRemovePreview {
  machine: { id: string; name: string };
  agents: { id: string; name: string; runtime: AgentRuntime }[];
  projects: { id: string; name: string; path: string }[];
  conversations: {
    id: string;
    name: string;
    projectId: string;
    archived: boolean;
  }[];
  activeRuns: number;
  activeReplies: number;
}

export interface MachineRemoveResult {
  machineId: string;
  removedAgents: string[];
  removedProjects: string[];
  removedConversations: string[];
}

export interface MachineArgs {
  rename: { machineId: string; name: string };
  /**
   * Make a one-time install code (good for 24 hours, once). `url` is the address the machine
   * should dial: what the user's browser sees, because the host cannot know its public name.
   */
  enroll: { name?: string; url?: string };
  /**
   * What the phone app scans to connect once. `url` is the address the phone should dial: what the
   * user's browser sees, because the host cannot know its public name.
   */
  phoneLink: { url?: string };
  /** Let a pending machine in. `fingerprint` must be the one the machine printed. */
  approve: { machineId: string; fingerprint: string };
  /** Preview every agent, project, conversation and active run/reply removing this machine affects. */
  removePreview: { machineId: string };
  /** Permanently remove a daemon machine and all projects, conversations, places and pinned agents on it. */
  remove: { machineId: string };
  /** How many task runs the machine works on at once, 1 to 20; runs already going go on. */
  setMaxActiveRuns: { machineId: string; maxActiveRuns: number };
  /**
   * Replace a connected daemon with the build this primary carries, now. Daemons are replaced when
   * they connect anyway; this is the retry, after a failure was fixed.
   */
  upgrade: { machineId: string };
  /** The nodes of the tailnet this host is on, and which of them are machines here already. */
  discover: Record<string, never>;
  /**
   * Put the daemon on a computer over SSH and register it: `host` is what `ssh` is given (a tailnet
   * node's name, `user@host`, an alias). `url` is the address it should dial, as for `enroll`.
   * `password` logs in when the computer has no key for this host; it is used for this install
   * only, never kept or logged. Returns at once; the steps show in the `installs` section.
   */
  install: { host: string; name?: string; url?: string; password?: string };
  /** The addresses a new machine can dial this host at, besides the one the page is on. */
  addresses: Record<string, never>;
}

/** An install over SSH, as it goes (`machines.installs`). */
export interface MachineInstallView {
  id: string;
  host: string;
  /** The step it is on; `done` and `failed` are where it ended. */
  step: "connect" | "send" | "register" | "service" | "done" | "failed";
  error: string | null;
  /** The machine it registered as, once it has. */
  machineId: string | null;
  startedAt: number;
}

/** A node of the tailnet, as `machines.discover` shows it. */
export interface TailnetPeerView {
  /** Tailscale's stable node id. */
  node: string;
  name: string;
  /** The MagicDNS name, when MagicDNS is on: what `install` is best given. */
  dnsName: string;
  os: string;
  online: boolean;
  /** Whose it is; null for a tagged node. */
  login: string | null;
  /** The user's own node: one that would be let in without approval. */
  own: boolean;
  /** The machine it already is here, when it is one. */
  machineId: string | null;
}
export interface MachineResults {
  rename: { machine: MachineView };
  enroll: { code: string; expiresAt: number; url: string; command: string };
  /** `link` carries the access token, so it is shown, never logged. */
  phoneLink: { link: string; url: string };
  approve: { machine: MachineView };
  removePreview: MachineRemovePreview;
  remove: MachineRemoveResult;
  setMaxActiveRuns: { machine: MachineView };
  upgrade: { machine: MachineView };
  /** `available` is false without Tailscale on this host (`reason` says what is missing). */
  discover: {
    available: boolean;
    reason?: string;
    self?: { name: string; dnsName: string; login: string | null };
    peers: TailnetPeerView[];
  };
  install: { installId: string };
  /** The host's tailnet address (`http://<MagicDNS name>:<port>`), when it listens there. */
  addresses: { tailnet: string | null };
}
export type MachineCall = {
  [A in MachineAction]: Omit<CallFrame, "target" | "action" | "args"> & {
    target: "machines";
    action: A;
    args: MachineArgs[A];
  };
}[MachineAction];

/* ------------------------------------------------------------------ upgrade */

export const UPGRADE_ACTIONS = [
  "check",
  "start",
  "cancel",
  "setUpstream",
  "setToken",
  "setPrerelease",
] as const;
export type UpgradeAction = (typeof UPGRADE_ACTIONS)[number];

/** Where a running upgrade is, in order. Until `stopping` the host goes on serving. */
export const UPGRADE_PHASES = [
  "starting",
  "downloading",
  "waiting",
  "stopping",
  "backing-up",
  "restarting",
  "verifying",
  "rolling-back",
] as const;
export type UpgradePhase = (typeof UPGRADE_PHASES)[number];

/**
 * How it ended: `failed` before the service was touched, `rolled-back` on the old build with its
 * database, `broken` when going back failed too and the service needs a person, `lost` when the
 * process doing it died.
 */
export const UPGRADE_STATES = [
  "running",
  "done",
  "failed",
  "rolled-back",
  "broken",
  "cancelled",
  "lost",
] as const;
export type UpgradeState = (typeof UPGRADE_STATES)[number];

export const UPGRADE_BUSY_KINDS = ["task", "routine", "reply"] as const;
export type UpgradeBusyKind = (typeof UPGRADE_BUSY_KINDS)[number];

/** One thing a restart would stop. A task has its number; `name` is its title, or the routine's or conversation's name. */
export interface UpgradeBusy {
  kind: UpgradeBusyKind;
  name: string;
  number?: number;
}

/** Bytes received and expected while downloading the release. */
export interface UpgradeDownloadProgress {
  received: number;
  total?: number;
}

/** An upgrade, as the process doing it reports it: on disk, so it outlasts the host. */
export interface UpgradeStatusView {
  id: string;
  state: UpgradeState;
  phase: UpgradePhase;
  from: string;
  /** Known once the release is found. */
  to?: string;
  startedAt: number;
  finishedAt?: number;
  /** How far the download has got, in the `downloading` phase. */
  download?: UpgradeDownloadProgress;
  /** What it is waiting for, in the `waiting` phase. */
  busy?: UpgradeBusy[];
  error?: string;
  log: string[];
}

/** Why this host cannot upgrade itself from the page. */
export type UpgradeBlock =
  | "source"
  | "no-service"
  /** The same, on Windows, where installing the service takes an Administrator. */
  | "no-windows-service"
  | "other-file";

/** Who says where releases come from: the host's environment, the user's setting, or the build. */
export type UpgradeUpstreamSource = "env" | "setting" | "build";

/** The repository this host takes its releases from, which is whose code it would run. */
export interface UpgradeUpstreamView {
  /** The one in use: `owner/name`, or an address. */
  label: string;
  source: UpgradeUpstreamSource;
  /** What the user saved, in use or not. */
  saved: string | null;
  /** What this build follows with nothing saved. */
  fallback: string;
}

/** Which token would read the upstream. The token itself never comes back from the host. */
export interface UpgradeTokenView {
  /** The GitHub host it would go to; null for a server that only takes `ETA_RELEASES_TOKEN`. */
  host: string | null;
  /** Where it comes from: an environment variable, `gh`, or `Settings`; null with none. */
  from: string | null;
  /** The host the saved token is for, which may not be this one. */
  saved: string | null;
}

/** What a newer release says it brings: its notes as written (Markdown), and its page. */
export interface UpgradeNotesView {
  /** The start of the release's body; a long one is cut, the page has it all. */
  text: string;
  /** Its page on the website; null where the server gives none. */
  url: string | null;
}

export interface UpgradeCheckView {
  /** This build. */
  version: string;
  /** The latest release on the channel (`prerelease`); null when it could not be found out. */
  latest: string | null;
  available: boolean;
  /** Whether pre-releases count as upgrades too: the `upgrade.prerelease` setting. */
  prerelease: boolean;
  /**
   * This build is a pre-release, pre-releases are off, and no full release is newer: nothing is
   * offered until one is. Turning the switch off never goes back to an older full release.
   */
  heldOnPrerelease: boolean;
  blocked: UpgradeBlock | null;
  /** What a restart would stop right now. */
  busy: UpgradeBusy[];
  upstream: UpgradeUpstreamView;
  token: UpgradeTokenView;
  /** The notes of `latest`, only when it is an upgrade (`available`) and says anything. */
  notes: UpgradeNotesView | null;
  error: string | null;
}

export interface UpgradeArgs {
  check: Record<string, never>;
  /** `force` restarts over working agents instead of waiting for them. */
  start: { force?: boolean };
  cancel: Record<string, never>;
  /** Save where releases come from; without `upstream`, go back to what the build follows. */
  setUpstream: { upstream?: string };
  /** Save a token for the upstream's host; without `token`, forget the one saved. */
  setToken: { token?: string };
  /** Let upgrades go to pre-releases, or only to full releases. */
  setPrerelease: { prerelease: boolean };
}

export interface UpgradeResults {
  check: UpgradeCheckView;
  start: { id: string };
  cancel: { cancelled: boolean };
  setUpstream: UpgradeUpstreamView;
  setToken: { saved: string | null };
  setPrerelease: { prerelease: boolean };
}

/* ------------------------------------------------------------------ projects */

export const PROJECT_ACTIONS = ["create", "update", "files"] as const;
export type ProjectAction = (typeof PROJECT_ACTIONS)[number];

export interface ProjectArgs {
  /**
   * The machine defaults to the primary. The path is read by that machine's rules (`~`, drives,
   * backslashes: `places.resolve`) and must be an existing directory there.
   */
  create: {
    path: string;
    machineId?: string;
    name?: string;
  };
  update: { projectId: string; name?: string; archived?: boolean };
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
  "attachment",
] as const;
export type ConversationAction = (typeof CONVERSATION_ACTIONS)[number];

export interface ConversationArgs {
  /**
   * A group needs at least one member. `stewardId` has to be one of them, or null for none; left
   * out, it is the first member.
   */
  create: {
    projectId: string;
    name?: string;
    agentIds?: string[];
    stewardId?: string | null;
  };
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
  /** One agent, or several at once (all join or none do); never both fields. */
  invite:
    | { conversationId: string; agentId: string; agentIds?: never }
    | { conversationId: string; agentIds: string[]; agentId?: never };
  /** Takes a member out. Not for a direct chat, which is the agent and the user. */
  remove: { conversationId: string; agentId: string };
  /** A member of the group, or null for none. */
  setSteward: { conversationId: string; agentId: string | null };
  /**
   * Say something. `mentions` are agent ids; a message that names nobody goes to the steward, or
   * to the only member of a group without one (`nobody` in the result when it woke nobody).
   * `mode` is how it joins an agent that is already answering: `queue` (the default) waits for
   * that reply to end and gets one of its own, `steer` changes the turn in flight. `clientId`
   * makes a retry the same message.
   */
  send: {
    conversationId: string;
    text: string;
    mentions?: string[];
    mode?: "queue" | "steer";
    /**
     * A non-held message or card of this conversation (user message, Captain review card,
     * Captain proposal card, or active reply) to put this one into: it joins the turn of every
     * agent answering that target right now (its replies in flight), whatever `mentions` and
     * `mode` say, and the row records it as `data.into`, so it can be drawn as part of that
     * message or card. With nobody answering it any more it is sent as a message of its own, as
     * `mentions` and `mode: "queue"` would have it, and the row has no `into`.
     */
    into?: string;
    clientId?: string;
    /**
     * Where the sender folded a paste inside `text`: pairs of integers `[start, end)`, counted
     * in UTF-16 offsets (the unit `String.prototype.slice` uses). Recorded on the row as
     * `data.blocks` for renderers to fold back into a chip; the agent reads `text` alone, so
     * they change nothing the agent is told. The host stores them without looking at them.
     */
    blocks?: [number, number][];
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
  /** Reads a sent image attachment of the conversation, to show it in the transcript. */
  attachment: { conversationId: string; attachmentId: string };
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

/**
 * The attachments the host gives back as pictures, at `attachmentPicturePath`: the image formats
 * a browser draws as pictures and nothing that could run as a page (an SVG is a file like any other).
 */
const PICTURE_TYPES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

/** Whether the host shows an attachment of this type back as a picture. */
export const isPictureType = (contentType: string | undefined) =>
  PICTURE_TYPES.has(contentType ?? "");

/** Where the host serves an attached file's bytes (`GET`, behind the normal access): a picture
 * as itself, any other file as bytes to save. */
export const attachmentPicturePath = (id: string) =>
  `/attachments/${encodeURIComponent(id)}`;

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
  recall: { conversationId: string; recalled: boolean };
  stop: { stopped: MessageView[] };
  read: { conversation: ConversationSummary };
  history: HistoryResult;
  attach: { attachment: AttachmentView | null };
  unattach: { removed: boolean };
  attachment: { contentType: string; data: string };
}
export type ConversationCall = {
  [A in ConversationAction]: Omit<CallFrame, "target" | "action" | "args"> & {
    target: "conversations";
    action: A;
    args: ConversationArgs[A];
  };
}[ConversationAction];
