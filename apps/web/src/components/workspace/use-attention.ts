import type { RoutineSummary } from "@/queries/routines";

import type { Task } from "@/queries/tasks";
import { listSeparator, translate } from "@/lib/i18n";
import { useQuestions } from "@/queries/questions";
import { useRoutines } from "@/queries/routines";
import { useTasks } from "@/queries/tasks";

// What waits for the user, derived from what the services already say: the
// confirmations agents asked for, tasks that are the user's to act on, and
// routines with reports or failures the user has not seen.

const closed = new Set<string>(["done", "cancelled"]);

/** Why a task waits for the user, or null. */
function taskReason(task: Task): string | null {
  if (closed.has(task.status)) return null;
  if (task.status === "blocked") return translate("tasks:status.blocked");
  if (task.status === "in_review") return translate("tasks:status.inReview");
  if (task.assignee === "user")
    return translate("overview:attention.assignedToYou");
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
  const interactions = useQuestions().length;
  const { tasks: board } = useTasks();
  const { routines } = useRoutines();
  const tasks = board.flatMap((task) => {
    const reason = taskReason(task);
    const alert = task.status === "blocked";
    return reason ? [{ task, reason, alert }] : [];
  });
  const waiting = routines.flatMap((routine) => {
    const reason = routineReason(routine);
    const alert = routine.unseenFailures > 0;
    return reason ? [{ routine, reason, alert }] : [];
  });
  return {
    interactions,
    tasks,
    routines: waiting,
    total: interactions + tasks.length + waiting.length,
  };
}
