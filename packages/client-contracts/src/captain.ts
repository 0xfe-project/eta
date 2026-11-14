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

/** The data of the system row that draws a proposal as a card (`event: "captain_group_proposal"`). */
export interface CaptainGroupProposalRowData {
  event: "captain_group_proposal";
  operationId: string;
  proposal: CaptainGroupProposal;
}

/**
 * An agent Captain proposed: the payload of a `create_agent` operation. Nothing exists until the user
 * confirms it; then the agent, its workspace project and its first prompt versions are made. The
 * persona is one of the cards that already exist — its id here, its body becomes the agent's persona,
 * and no card is written — and the model is the one the user chose.
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
  /** The id of an existing persona card. */
  persona: string;
  model: string;
  runtime: AgentRuntime;
  /** The primary machine's id, or null: an agent is only made on the primary. */
  machineId: string | null;
  plugins: string[];
}

/** What a confirmed `create_agent` made. */
export interface CaptainAgentResult {
  agentId: string;
  projectId: string;
  name: string;
}

/** The data of the system row that draws a proposal as a card (`event: "captain_agent_proposal"`). */
export interface CaptainAgentProposalRowData {
  event: "captain_agent_proposal";
  operationId: string;
  proposal: CaptainAgentProposal;
}

/**
 * `MessageView.data.captainGroupOutcome` of the message that tells Captain how a group proposal it
 * made ended. That message is Captain's context, in English, and wakes its next turn; the user
 * already sees the outcome on the proposal's card, so clients do not draw it.
 */
export interface CaptainGroupOutcomeData {
  operationId: string;
  status: CaptainOperationStatus;
}

/**
 * `MessageView.data.captainAgentOutcome` of the message that tells Captain how an agent proposal it
 * made ended. Like a group's outcome it is Captain's context, in English, and it wakes its next
 * turn; the user already sees the outcome on the proposal's card, so clients do not draw it.
 *
 * Only an agent Captain proposed reports back. An agent the user makes in the agent dialog is not
 * an operation at all, so nothing is said about it.
 */
export interface CaptainAgentOutcomeData {
  operationId: string;
  status: CaptainOperationStatus;
}

/**
 * The opening of the outcome message as the host wrote it before it carried
 * `data.captainGroupOutcome`: `Your proposed group "<name>" (operation <uuid>) was confirmed…` or
 * `…was rejected…`. Only a `system` message is matched, and only the host writes those.
 */
const LEGACY_GROUP_OUTCOME =
  /^Your proposed group "[\s\S]*" \(operation [0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\) was (?:confirmed|rejected) by the user/;

/** Whether a row is the message that tells Captain how its group proposal ended; clients skip it. */
export function isCaptainGroupOutcome(
  message: Pick<MessageView, "author" | "kind" | "text" | "data">,
): boolean {
  if (message.author !== "system" || message.kind !== "message") return false;
  const outcome = message.data.captainGroupOutcome;
  if (typeof outcome === "object" && outcome !== null) return true;
  return LEGACY_GROUP_OUTCOME.test(message.text);
}

/**
 * Whether a row is the message that tells Captain how an agent proposal it made ended; clients skip
 * it, as they do a group's. There is no legacy text to match: no such message was written before
 * the data key existed.
 */
export function isCaptainAgentOutcome(
  message: Pick<MessageView, "author" | "kind" | "data">,
): boolean {
  if (message.author !== "system" || message.kind !== "message") return false;
  const outcome = message.data.captainAgentOutcome;
  return typeof outcome === "object" && outcome !== null;
}

/**
 * Whether a row is the message that tells Captain how any proposal it made ended. One place for
 * clients to ask, so a new kind of proposal does not need every client taught about it.
 */
export function isCaptainOutcome(
  message: Pick<MessageView, "author" | "kind" | "text" | "data">,
): boolean {
  return isCaptainGroupOutcome(message) || isCaptainAgentOutcome(message);
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
