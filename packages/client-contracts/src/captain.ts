import type { CallFrame } from "@eta/client-wire-proto";
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

export interface CaptainNotificationView {
  id: string;
  kind: string;
  body: string;
  data: Record<string, unknown>;
  readAt: number | null;
  createdAt: number;
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
  notifications: CaptainNotificationView[];
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
