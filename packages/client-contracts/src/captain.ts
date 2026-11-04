import type { CallFrame } from "@eta/client-wire-proto";
import type { BoardTaskDetail, BoardTaskStatus } from "./tasks";

export const CAPTAIN_ACTIONS = [
  "ensure",
  "direct",
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
