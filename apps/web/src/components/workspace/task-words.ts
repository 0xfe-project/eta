import type { Progress } from "./task-plan";
import type { Task } from "@/queries/tasks";
import { translate } from "@/lib/i18n";
import { blockedReason, releaseOf } from "./task-plan";

// The sentences the board, the list and the plan say a task with.

/** A stripe pattern on the card's own background: the task waits, it is not a status. */
export const waitingStripes =
  "bg-[repeating-linear-gradient(-45deg,var(--color-card)_0_7px,var(--color-muted)_7px_8px)]";

const countKey = {
  done: "done",
  in_review: "inReview",
  in_progress: "inProgress",
  blocked: "blocked",
  waiting: "waiting",
  todo: "todo",
  backlog: "backlog",
} as const;

/** "2 done · 1 in review · 1 running · 1 waiting". */
export function progressCounts(progress: Progress) {
  return progress.counts
    .map(({ segment, count }) =>
      translate(`tasks:cards.counts.${countKey[segment]}`, { count }),
    )
    .join(" · ");
}

/** "Unlocks 2 tasks" before it is delivered, "Let 1 go" after; nothing when nobody waits for it. */
export function releaseLabel(
  task: Task,
  all: readonly Task[],
): string | undefined {
  const { waiting, released } = releaseOf(task, all);
  // Done is settled: the card says when instead.
  if (task.status === "done" || task.status === "cancelled") return undefined;
  if (released > 0 && task.status === "in_review")
    return translate("tasks:cards.released", { count: released });
  if (waiting > 0) return translate("tasks:cards.unlocks", { count: waiting });
  if (released > 0)
    return translate("tasks:cards.released", { count: released });
  return undefined;
}

/** Why a blocked task is stuck, in a sentence. */
export function blockedLine(task: Task, all: readonly Task[]): string {
  const reason = blockedReason(task, all);
  switch (reason.kind) {
    case "cancelled":
      return translate("tasks:cards.blockedCancelled", { title: reason.title });
    case "cancelledMany":
      return translate("tasks:cards.blockedCancelledMany", {
        count: reason.count,
      });
    case "allCancelled":
      return translate("tasks:cards.blockedAllCancelled");
    default:
      return translate("tasks:cards.blockedDecide");
  }
}
