/**
 * The `inbox` target: every question an agent's session asks, in one place.
 *
 * A session's question is the session's own (`sessions.<id>` publishes it as its `ask` section and
 * `sessions.answer` settles it). The inbox is the same questions across all sessions, kept as rows:
 * what is waiting for the user now, and what became of the ones that were asked before. Its `list`
 * section is eager, so a client draws the pending count from `hello`.
 *
 * Tools the user marked as needing approval ask through the same channel (`approvals`): to the
 * inbox an approval is a question with two options, `allow` and `deny`.
 */
import type { CallFrame } from "@eta/client-wire-proto";

/**
 * Where a question is in its life. `pending` is the only state that wants an answer. `answered` is
 * a reply that came back; `canceled` means nobody is waiting any more because the run was stopped
 * (or the user answered with `none`); `expired` means the wait ended some other way: its deadline
 * passed, or the process that asked it restarted.
 */
export type InteractionStatus = "pending" | "answered" | "canceled" | "expired";

/** What the user says to a question; the shape a session's ask channel takes. */
export type InboxResponse =
  | { kind: "selection"; selections: string[]; comment?: string }
  | { kind: "freeform"; text: string }
  | { kind: "none" };

/** One question. */
export interface InteractionView {
  /** Unique across sessions; this is what `answer` takes. */
  id: string;
  sessionId: string;
  /** The question's id inside its session (the model's tool call id). */
  questionId: string;
  /** The agent whose session asked, and the conversation it was held in; null for a bare session. */
  agentId: string | null;
  conversationId: string | null;
  /** The reply row that was running when it was asked, when the ask happened inside a wake. */
  replyId: string | null;
  prompt: string;
  options: string[];
  /** The user may pick more than one option. */
  multi: boolean;
  status: InteractionStatus;
  /** What was answered, when the answer came through `inbox.answer`; null otherwise. */
  answer: InboxResponse | null;
  /** Grows on every change, so a client can tell newer from a second copy. */
  revision: number;
  createdAt: number;
  updatedAt: number;
}

/** The tool names that ask the user before they run. */
export interface ApprovalList {
  tools: string[];
}

/**
 * `list` has every pending question first (newest first), then the most recent ones that were
 * settled (newest first), bounded.
 */
export interface InboxSections {
  list: InteractionView[];
  approvals: ApprovalList;
}

export const INBOX_ACTIONS = ["answer", "setApprovals"] as const;
export type InboxAction = (typeof INBOX_ACTIONS)[number];

export interface InboxArgs {
  /**
   * Answer a pending question; the run waiting on it goes on. Answering one that is no longer
   * pending changes nothing and says so (`answered: false`).
   */
  answer: { id: string; response: InboxResponse };
  /** Replaces the list. A listed tool asks (`allow` or `deny`) before every call, in every session. */
  setApprovals: { tools: string[] };
}
export interface InboxResults {
  answer: { interaction: InteractionView; answered: boolean };
  setApprovals: { approvals: ApprovalList };
}
export type InboxCall = {
  [A in InboxAction]: Omit<CallFrame, "target" | "action" | "args"> & {
    target: "inbox";
    action: A;
    args: InboxArgs[A];
  };
}[InboxAction];
