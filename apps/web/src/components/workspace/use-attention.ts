import type { RoutineSummary } from "@/queries/routines";
import type { Task } from "@/queries/tasks";
import { usePendingInteractions } from "@/queries/chat";
import { useRoutines } from "@/queries/routines";
import { useTasks } from "@/queries/tasks";

// What waits for the user, derived from what the services already say: the
// confirmations agents asked for, tasks that are the user's to act on, and
// routines with reports or failures the user has not seen.

const closed = new Set<string>(["done", "cancelled"]);

/** Why a task waits for the user, or null. */
function taskReason(task: Task): string | null {
  if (closed.has(task.status)) return null;
  // A run an AXP agent asked for (#99), once the board has that status.
  if ((task.run_status as string | null) === "awaiting_confirmation")
    return "等你确认交给远程智能体";
  if (task.run_status === "failed") return "远程运行失败";
  if (task.status === "blocked") return "受阻";
  if (task.status === "in_review") return "待验收";
  if (task.assignee.kind === "user") return "指派给你";
  return null;
}

function routineReason(routine: RoutineSummary): string | null {
  const parts = [
    routine.unseen_reports ? `${routine.unseen_reports} 份新报告` : null,
    routine.unseen_failures ? `${routine.unseen_failures} 次失败` : null,
  ].filter(Boolean);
  return parts.length ? parts.join("、") : null;
}

/** The things waiting for the user, and how many in all. */
export function useAttention() {
  const interactions = usePendingInteractions().length;
  const { data: board } = useTasks();
  const { data: routines } = useRoutines();
  const tasks = (board?.tasks ?? []).flatMap((task) => {
    const reason = taskReason(task);
    const alert = task.run_status === "failed" || task.status === "blocked";
    return reason ? [{ task, reason, alert }] : [];
  });
  const waiting = (routines ?? []).flatMap((routine) => {
    const reason = routineReason(routine);
    const alert = routine.unseen_failures > 0;
    return reason ? [{ routine, reason, alert }] : [];
  });
  return {
    interactions,
    tasks,
    routines: waiting,
    total: interactions + tasks.length + waiting.length,
  };
}
