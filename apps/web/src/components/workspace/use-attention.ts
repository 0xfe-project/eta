import type { RoutineSummary } from "@/queries/routines";

import type { Task } from "@/queries/tasks";
import { ROUTINES_VISIBLE } from "@/lib/features";
import { listSeparator, translate } from "@/lib/i18n";
import { usePendingInteractions } from "@/queries/inbox";
import { useRoutines } from "@/queries/routines";
import { useTasks } from "@/queries/tasks";

// What waits for the user, derived from what the services already say: the
// confirmations agents asked for, tasks that are the user's to act on, and
// routines with reports or failures the user has not seen.
//
// A task draft is not one of these, and folding one in the conversation changed nothing about that.
// What is counted here is a thing waiting where the reader is not looking: a question, a board task
// they have to move, a report nobody has read. A draft is already two places at once — it is a row of
// the conversation's timeline, so the conversation's own unread count includes it, and the card it is
// drawn on carries the mark that it waits and the way to confirm it, folded or not. It has no read or
// set-aside state either: until it is confirmed it is simply still there, so counting it here would be
// a badge the reader could only take off by confirming it or deleting the row. Confirmed, it is a task
// on the board and reaches this list as one, by its own status.

const closed = new Set<string>(["done", "cancelled"]);

/** Why a task waits for the user, or null. */
function taskReason(task: Task): string | null {
  if (closed.has(task.status)) return null;
  if (task.status === "blocked") return translate("tasks:status.blocked");
  if (task.status === "in_review") return translate("tasks:status.inReview");
  return null;
}

function routineReason(routine: RoutineSummary): string | null {
  const parts = [
    routine.unseenReports
      ? translate("overview:attention.newReports", {
          count: routine.unseenReports,
        })
      : null,
    routine.unseenFailures
      ? translate("overview:attention.failedRuns", {
          count: routine.unseenFailures,
        })
      : null,
  ].filter(Boolean);
  return parts.length ? parts.join(listSeparator()) : null;
}

/** The things waiting for the user, and how many in all. */
export function useAttention() {
  const interactions = usePendingInteractions().length;
  const { tasks: board } = useTasks();
  const { routines } = useRoutines();
  const tasks = board.flatMap((task) => {
    const reason = taskReason(task);
    const alert = task.status === "blocked";
    return reason ? [{ task, reason, alert }] : [];
  });
  // 定时 is not offered in this build: a report the reader cannot open is not something waiting
  // for them, and counting it would leave a badge no page can clear.
  const waiting = ROUTINES_VISIBLE
    ? routines.flatMap((routine) => {
        const reason = routineReason(routine);
        const alert = routine.unseenFailures > 0;
        return reason ? [{ routine, reason, alert }] : [];
      })
    : [];
  return {
    interactions,
    tasks,
    routines: waiting,
    total: interactions + tasks.length + waiting.length,
  };
}
