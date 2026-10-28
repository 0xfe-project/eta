import type { CallFrame } from "@eta/client-wire-proto";

export type EmailAccountStatus = "unverified" | "ready" | "error";
export type EmailThreadStatus = "new" | "assigned" | "archived";
export type EmailMessageDirection = "incoming" | "outgoing";
export type EmailMessageStatus =
  | "received"
  | "draft"
  | "sending"
  | "accepted"
  | "failed";
export type EmailProposalKind = "new" | "reply";
export type EmailProposalStatus =
  | "pending"
  | "sending"
  | "accepted"
  | "failed"
  | "discarded";

export interface EmailAccountView {
  id: string;
  name: string;
  address: string;
  username: string;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  imapHost: string;
  imapPort: number;
  imapSecure: boolean;
  inboxFolder: string;
  junkFolder: string | null;
  pollIntervalSeconds: number;
  status: EmailAccountStatus;
  lastError: string | null;
  lastCheckedAt: number | null;
  lastPollAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface EmailAccountInput {
  id?: string;
  name: string;
  address: string;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  imapHost: string;
  imapPort: number;
  imapSecure: boolean;
  inboxFolder?: string;
  junkFolder?: string | null;
  pollIntervalSeconds?: number;
  username: string;
  password?: string;
}

export interface EmailMetaView {
  protocol: string | null;
  agentId: string | null;
  agentName: string | null;
  sessionId: string | null;
  logicalSessionId: string | null;
  mailThreadId: string | null;
  taskId: string | null;
  packetCount: number;
  signaturePresent: boolean;
  signatureValid: boolean | null;
  decodeError: string | null;
  context: unknown;
}

export interface EmailMessageView {
  id: string;
  threadId: string;
  accountId: string;
  direction: EmailMessageDirection;
  status: EmailMessageStatus;
  folder: string | null;
  from: string;
  to: string;
  subject: string;
  text: string;
  html: string;
  rfcMessageId: string | null;
  inReplyTo: string | null;
  references: string[];
  meta: EmailMetaView | null;
  error: string | null;
  createdAt: number;
}

export interface EmailThreadView {
  id: string;
  accountId: string;
  peer: string;
  subject: string;
  status: EmailThreadStatus;
  unread: boolean;
  messageCount: number;
  incomingCount: number;
  outgoingCount: number;
  lastMessageAt: number;
  lastMessage: string;
  rootMessageId: string | null;
  latestMessageId: string | null;
}

export interface EmailAssignmentView {
  id: string;
  threadId: string;
  sessionId: string;
  agentId: string;
  projectId: string;
  createdAt: number;
}

export interface EmailProposalView {
  id: string;
  threadId: string | null;
  replyToMessageId: string | null;
  sessionId: string;
  agentId: string;
  accountId: string;
  kind: EmailProposalKind;
  status: EmailProposalStatus;
  from: string;
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  markdown: string;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface EmailStatsView {
  unread: number;
  pendingProposals: number;
}

export interface EmailInboxSections {
  accounts: EmailAccountView[];
  threads: EmailThreadView[];
  proposals: EmailProposalView[];
  stats: EmailStatsView;
}

export interface EmailThreadSections {
  thread: EmailThreadView;
  messages: EmailMessageView[];
  assignments: EmailAssignmentView[];
  proposals: EmailProposalView[];
}

export const EMAIL_ACTIONS = [
  "saveAccount",
  "removeAccount",
  "verifyAccount",
  "refresh",
  "markRead",
  "deleteThreads",
  "assign",
  "confirmProposal",
  "discardProposal",
] as const;
export type EmailAction = (typeof EMAIL_ACTIONS)[number];

export interface EmailArgs {
  saveAccount: EmailAccountInput;
  removeAccount: { accountId: string };
  verifyAccount: { accountId: string };
  refresh: { accountId?: string };
  markRead: { threadId: string; unread: boolean };
  deleteThreads: { threadIds: string[] };
  assign: {
    threadIds: string[];
    agentId: string;
    projectId: string;
    sessionId?: string;
  };
  confirmProposal: {
    proposalId: string;
    subject?: string;
    markdown?: string;
    to?: string;
  };
  discardProposal: { proposalId: string };
}

export interface EmailResults {
  saveAccount: { account: EmailAccountView };
  removeAccount: { accountId: string };
  verifyAccount: { account: EmailAccountView };
  refresh: { checked: number; received: number };
  markRead: { thread: EmailThreadView };
  deleteThreads: { threadIds: string[] };
  assign: {
    sessionId: string;
    conversationId: string;
    agentName: string;
    assignments: EmailAssignmentView[];
  };
  confirmProposal: { proposal: EmailProposalView; message: EmailMessageView };
  discardProposal: { proposalId: string };
}

export type EmailCall = {
  [A in EmailAction]: Omit<CallFrame, "target" | "action" | "args"> & {
    target: "email";
    action: A;
    args: EmailArgs[A];
  };
}[EmailAction];
