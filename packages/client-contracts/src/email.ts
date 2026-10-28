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

/**
 * What one ETA agent sends another, next to the mail a person reads.
 *
 * Two audiences in one message. `ask`, `work` and `decided` are the part the sending agent writes;
 * `from` and `human` are filled by the host that sends it, from what it already knows. The body a
 * person reads is short on purpose: it has to be auditable in one look before the human presses
 * send. The payload is the superset of it — `read_email` gives the peer this, not the body.
 */
export interface EtaMailPayload {
  protocol: "eta-mp/1";
  v: 1;
  createdAt: string;
  from: EtaMailPayloadFrom;
  work: EtaMailPayloadWork;
  ask: EtaMailPayloadAsk;
  decided: EtaMailPayloadDecided[];
  human: EtaMailPayloadHuman;
}

/** Who sent it and where they were standing. The host fills every field here. */
export interface EtaMailPayloadFrom {
  agentId: string | null;
  agentName: string | null;
  /** The session that sent it, on the sending side. */
  sessionId: string | null;
  /**
   * The conversation or task session key it sits in, so that a reply lands in the same place.
   * `task:<id>` when a task's executor sent it.
   */
  conversationId: string | null;
  /** The board task whose executor sent it, when it is one. */
  taskId: string | null;
  /** The directory this session was working in: where the peer has to look. */
  cwd: string | null;
  /** The mail thread this is already part of, when it is a reply. */
  mailThreadId: string | null;
}

/** What the work is, as the sender would say it to the peer. */
export interface EtaMailPayloadWork {
  /** One line: what this session is doing. */
  doing: string | null;
  repo: string | null;
  branch: string | null;
  /** Paths the peer has to look at to follow the sender. */
  paths: string[];
}

/** What the sender is asking for. */
export interface EtaMailPayloadAsk {
  /** The human's question, close to their own words. */
  question: string | null;
  /** What the sender needs the peer's agent to do. */
  needed: string | null;
  /** When it is needed, in the sender's words. */
  by: string | null;
}

/** Something the sender has already settled, so that the peer does not reopen it. */
export interface EtaMailPayloadDecided {
  text: string;
  /** Where it came from: a message, a task, an artifact, a path. */
  source: string | null;
}

/** What the sending human did to the body before confirming it. */
export interface EtaMailPayloadHuman {
  /** The final body, when the human changed it. Carried so the agent side never loses it. */
  note: string | null;
  edited: boolean;
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
  /**
   * Where the payload was found. Headers survive a mail client that rewrites the body; the logo
   * alt survives a forward; `none` means this mail carries no agent part at all.
   */
  carrier: EmailMetaCarrier;
  signaturePresent: boolean;
  signatureValid: boolean | null;
  decodeError: string | null;
  payload: EtaMailPayload | null;
}

export type EmailMetaCarrier = "header" | "alt" | "logo" | "none";

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
