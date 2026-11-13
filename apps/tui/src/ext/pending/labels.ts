import type { BoardTaskStatus } from "@eta/client-contracts";
import type { PendingMessageKey } from "./messages";

const STATUS_TEXT: Record<BoardTaskStatus, PendingMessageKey> = {
  backlog: "statusBacklog",
  todo: "statusTodo",
  in_progress: "statusInProgress",
  in_review: "statusInReview",
  blocked: "statusBlocked",
  done: "statusDone",
  cancelled: "statusCancelled",
};

/** The words for a task's status. */
export const statusText = (status: BoardTaskStatus): PendingMessageKey =>
  STATUS_TEXT[status];
