import type { BoardTaskStatus, BoardTaskView } from "@eta/client-contracts";
import type { Theme } from "../../config/types";
import type { PendingMessageKey } from "./messages";
import { inkColor } from "../../ui/theme";

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

/**
 * A status's colour, as the web app's marks have it in terminal colours: running is the accent,
 * waiting for review the warning, done the success, blocked the error; the backlog and the
 * cancelled are muted, to-do is plain text.
 */
export function statusColor(
  status: BoardTaskStatus,
  theme: Pick<
    Theme,
    "text" | "muted" | "accent" | "warning" | "error" | "success"
  >,
): string | undefined {
  const tokens: Record<BoardTaskStatus, string> = {
    backlog: theme.muted,
    todo: theme.text,
    in_progress: theme.accent,
    in_review: theme.warning,
    done: theme.success,
    blocked: theme.error,
    cancelled: theme.muted,
  };
  return inkColor(tokens[status]);
}

/**
 * Where a task stands in the task graph, as the words after its status: what its work still waits
 * for, a cancelled dependency, or how far its subtasks are. Nothing for a task outside the graph, or
 * from a host older than it.
 */
export function graphText(
  task: Pick<BoardTaskView, "status" | "waitingOn" | "subtasks">,
  t: (
    key: PendingMessageKey,
    values?: Record<string, string | number>,
  ) => string,
): string {
  const parts: string[] = [];
  if (task.subtasks != null) parts.push(t("subtasks", { ...task.subtasks }));
  const open =
    task.status === "todo" ||
    task.status === "blocked" ||
    task.status === "backlog";
  const waits = open ? (task.waitingOn ?? []) : [];
  const named = (state: string) =>
    waits
      .filter((wait) => wait.state === state)
      .map((wait) => `#${wait.number}`)
      .join(", ");
  if (named("cancelled") !== "")
    parts.push(t("dependencyCancelled", { tasks: named("cancelled") }));
  if (named("waiting") !== "")
    parts.push(t("waitingFor", { tasks: named("waiting") }));
  return parts.map((part) => ` · ${part}`).join("");
}
