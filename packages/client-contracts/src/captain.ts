import type { CallFrame } from "@eta/client-wire-proto";
import type { AgentRuntime, MessageView } from "./product";
import type { BoardTaskDetail, BoardTaskStatus } from "./tasks";

export const CAPTAIN_ACTIONS = [
  "ensure",
  "direct",
  "setModel",
  "assign",
  "decideOperation",
  "setMemoryPaused",
  "promptHistory",
  "setPrompt",
  "rollbackPrompt",
  "setSetting",
  "settingHistory",
  "rollbackSetting",
  /**
   * @deprecated Captain no longer raises alerts and no client lists them. The host still answers
   * it, so a page from before that (one that still drew a "Mark read" button) does not error.
   */
  "markNotificationRead",
] as const;
export type CaptainAction = (typeof CAPTAIN_ACTIONS)[number];

export const CAPTAIN_ASSIGNMENT_STATUSES = [
  "dispatched",
  "working",
  "completed",
  "failed",
  "blocked",
  "cancelled",
] as const;
export type CaptainAssignmentStatus =
  (typeof CAPTAIN_ASSIGNMENT_STATUSES)[number];

export const CAPTAIN_OPERATION_STATUSES = [
  "pending",
  "approved",
  "rejected",
  "applied",
  "failed",
  "expired",
] as const;
export type CaptainOperationStatus =
  (typeof CAPTAIN_OPERATION_STATUSES)[number];

export const CAPTAIN_PROMPT_KINDS = [
  "instructions",
  "persona",
  "base",
] as const;
export type CaptainPromptKind = (typeof CAPTAIN_PROMPT_KINDS)[number];

export interface CaptainIdentityView {
  agentId: string;
  name: string;
  home: string;
  /** `provider:modelId`, or null until the user chooses what answers for Captain. */
  model: string | null;
  conversationId: string | null;
  createdAt: number;
}

export interface CaptainAssignmentTargetView {
  id: string;
  agentId: string;
  replyId: string | null;
  status: CaptainAssignmentStatus;
  taskCount: number;
}

export interface CaptainAssignmentView {
  id: string;
  conversationId: string;
  messageId: string;
  rootMessageId: string | null;
  captainAgentId: string;
  round: number;
  status: CaptainAssignmentStatus;
  targets: CaptainAssignmentTargetView[];
  createdAt: number;
  updatedAt: number;
}

export interface CaptainOperationView {
  id: string;
  kind: string;
  actorAgentId: string | null;
  requiresApproval: boolean;
  status: CaptainOperationStatus;
  payload: Record<string, unknown>;
  result: Record<string, unknown> | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

/**
 * A group Captain proposed: the payload of a `create_group` operation. Nothing exists until the user
 * confirms it; then the directory is added as a project if it is not one yet, and the group is made.
 */
export interface CaptainGroupProposal {
  /** Where Captain proposed it: the card is there, and so is the message that tells Captain. */
  originConversationId: string;
  /** The card's row in that conversation. */
  messageId: string;
  name: string;
  goal: string | null;
  memberIds: string[];
  stewardId: string;
  /** The project it goes in; null when the directory is not a project yet. */
  projectId: string | null;
  machineId: string;
  path: string;
  /** What the directory is called on the card: the project's name, or the new one's. */
  projectName: string;
}

/** What a confirmed `create_group` made. */
export interface CaptainGroupResult {
  conversationId: string;
  projectId: string;
  /** The directory became a project when the group was made. */
  projectCreated: boolean;
}

/**
 * An agent Captain proposed: the payload of a `create_agent` operation. Nothing exists until the user
 * confirms it; then the agent, its workspace project and its first prompt versions are made, on the
 * primary machine. The persona is one of the cards that already exist, named by its id — no card is
 * written — and the model is the one the user chose.
 */
export interface CaptainAgentProposal {
  /** Where Captain proposed it: the card is there. */
  originConversationId: string;
  /** The card's row in that conversation. */
  messageId: string;
  name: string;
  /** What the agent is for, and when it should retire: one sentence, read on the card. */
  purpose: string;
  instructions: string;
  /** The id of an existing persona card: the agent's `persona` is this id, never the card's text. */
  persona: string;
  model: string;
  runtime: AgentRuntime;
  plugins: string[];
}

/** What a confirmed `create_agent` made. */
export interface CaptainAgentResult {
  agentId: string;
  projectId: string;
  name: string;
}

/**
 * Every proposal Captain makes goes the same way: a pending operation of its kind (`create_group`,
 * `create_agent`), a card in the conversation it was proposed from, the user's answer on that card,
 * and a message that tells Captain how it ended. What follows is what clients read of that.
 */

/** The `event` of the system row that draws a proposal as a card. */
export const CAPTAIN_PROPOSAL_EVENT = "captain_proposal";

/** The data of that row. `kind` is the operation's; `proposal` is its payload, as it was proposed. */
export interface CaptainProposalRowData<P = Record<string, unknown>> {
  event: typeof CAPTAIN_PROPOSAL_EVENT;
  kind: string;
  operationId: string;
  proposal: P;
}

/** A proposal card's row, as `captainProposalOf` reads it. */
export interface CaptainProposalRow<P = Record<string, unknown>> {
  kind: string;
  operationId: string;
  proposal: P;
}

/**
 * The events rows were drawn from before every kind shared one, with the kind each stands for. A
 * row of these carries the same `operationId` and `proposal`.
 */
const LEGACY_PROPOSAL_EVENTS: Record<string, string> = {
  captain_group_proposal: "create_group",
  captain_agent_proposal: "create_agent",
};

/** The proposal a row draws as a card, old rows included; undefined for any other row. */
export function captainProposalOf<P = Record<string, unknown>>(
  message: Pick<MessageView, "data">,
): CaptainProposalRow<P> | undefined {
  const { event, kind, operationId, proposal } = message.data as {
    event?: unknown;
    kind?: unknown;
    operationId?: unknown;
    proposal?: unknown;
  };
  if (typeof event !== "string") return undefined;
  const known =
    event === CAPTAIN_PROPOSAL_EVENT
      ? typeof kind === "string"
        ? kind
        : undefined
      : LEGACY_PROPOSAL_EVENTS[event];
  if (
    known === undefined ||
    typeof operationId !== "string" ||
    typeof proposal !== "object" ||
    proposal === null
  )
    return undefined;
  return { kind: known, operationId, proposal: proposal as P };
}

/**
 * `MessageView.data.captainOutcome` of the message that tells Captain how a proposal it made ended.
 * That message is Captain's context, in English, and wakes its next turn; the user already sees the
 * outcome on the proposal's card, so clients do not draw it.
 *
 * Only a proposal reports back. An agent or a group the user makes in a dialog is no operation, so
 * nothing is said about it.
 */
export interface CaptainOutcomeData {
  operationId: string;
  kind: string;
  status: CaptainOperationStatus;
}

/** The keys the mark had before every kind shared one; messages carrying them are still skipped. */
const LEGACY_OUTCOME_KEYS = ["captainGroupOutcome", "captainAgentOutcome"];

/**
 * The opening of the outcome message as the host wrote it before it carried a mark at all:
 * `Your proposed group "<name>" (operation <uuid>) was confirmed…` or `…was rejected…`. Only a
 * `system` message is matched, and only the host writes those. The host still opens a group's
 * outcome this way, so a client from before the shared mark keeps skipping it.
 */
const LEGACY_GROUP_OUTCOME =
  /^Your proposed group "[\s\S]*" \(operation [0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\) was (?:confirmed|rejected) by the user/;

/** Whether a row is the message that tells Captain how a proposal it made ended; clients skip it. */
export function isCaptainOutcome(
  message: Pick<MessageView, "author" | "kind" | "text" | "data">,
): boolean {
  if (message.author !== "system" || message.kind !== "message") return false;
  for (const key of ["captainOutcome", ...LEGACY_OUTCOME_KEYS]) {
    const outcome = message.data[key];
    if (typeof outcome === "object" && outcome !== null) return true;
  }
  return LEGACY_GROUP_OUTCOME.test(message.text);
}

export interface CaptainPromptVersionView {
  id: string;
  subjectId: string;
  kind: CaptainPromptKind;
  version: number;
  content: string;
  actorAgentId: string | null;
  createdAt: number;
}

export interface CaptainSettingView {
  key: string;
  value: unknown;
  version: number;
  updatedAt: number;
}

export interface CaptainMemoryPauseView {
  scopeType: "conversation" | "task";
  scopeId: string;
  paused: boolean;
  updatedBy: string | null;
  updatedAt: number;
}

export interface CaptainSettingsView {
  supervisorEnabled: boolean;
  patrolMinutes: number;
  inboxMinutes: number;
  stuckMinutes: number;
  retryLimit: number;
  loopRounds: number;
}

export interface CaptainSections {
  identity: CaptainIdentityView | null;
  assignments: CaptainAssignmentView[];
  operations: CaptainOperationView[];
  memoryPauses: CaptainMemoryPauseView[];
  settings: CaptainSettingsView;
}

export interface CaptainAssignInput {
  conversationId: string;
  text: string;
  agentIds: string[];
  mode?: "queue" | "steer";
  rootMessageId?: string | null;
}

export interface CaptainArgs {
  ensure: Record<string, never>;
  direct: Record<string, never>;
  setModel: { model: string };
  assign: CaptainAssignInput;
  decideOperation: {
    operationId: string;
    decision: "approve" | "reject";
  };
  setMemoryPaused: {
    scopeType: "conversation" | "task";
    scopeId: string;
    paused: boolean;
  };
  promptHistory: {
    subjectId?: string;
    kind?: CaptainPromptKind;
    limit?: number;
  };
  setPrompt: {
    subjectId: string;
    kind: CaptainPromptKind;
    content: string;
  };
  rollbackPrompt: {
    subjectId: string;
    kind: CaptainPromptKind;
    version: number;
  };
  setSetting: {
    key: keyof CaptainSettingsView;
    value: boolean | number;
  };
  settingHistory: {
    key: keyof CaptainSettingsView;
    limit?: number;
  };
  rollbackSetting: {
    key: keyof CaptainSettingsView;
    version: number;
  };
  /** @deprecated See `CAPTAIN_ACTIONS`: kept only so older clients do not error. */
  markNotificationRead: { notificationId: string };
}

export interface CaptainResults {
  ensure: { identity: CaptainIdentityView; created: boolean };
  direct: { identity: CaptainIdentityView; conversationId: string };
  setModel: { identity: CaptainIdentityView };
  assign: {
    assignment: CaptainAssignmentView;
    messageId: string;
    replyIds: string[];
  };
  decideOperation: { operation: CaptainOperationView };
  setMemoryPaused: { pause: CaptainMemoryPauseView };
  promptHistory: { versions: CaptainPromptVersionView[] };
  setPrompt: { version: CaptainPromptVersionView };
  rollbackPrompt: { version: CaptainPromptVersionView };
  setSetting: { setting: CaptainSettingView };
  settingHistory: { versions: CaptainSettingView[] };
  rollbackSetting: { setting: CaptainSettingView };
  markNotificationRead: { notificationId: string };
}

export type CaptainCall = {
  [A in CaptainAction]: Omit<CallFrame, "target" | "action" | "args"> & {
    target: "captain";
    action: A;
    args: CaptainArgs[A];
  };
}[CaptainAction];

export interface CaptainTaskControl {
  task: BoardTaskDetail;
  action: "continue" | "pause" | "interrupt" | "cancel" | "rerun" | "delete";
  status?: BoardTaskStatus;
}
