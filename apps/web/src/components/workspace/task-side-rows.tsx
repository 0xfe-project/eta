import type { Task } from "@/queries/tasks";
import { LockSimpleIcon } from "@phosphor-icons/react/LockSimple";
import { useTranslation } from "react-i18next";
import { ProgressBar, RunningFor } from "./task-bits";
import { isRunning, isWaiting, progressOf, waitsOf } from "./task-plan";
import { StatusPill } from "./task-status-icon";

// What a task row of the side panel says at its end: a piece of work's small bar, "waiting for
// prerequisites" behind a lock, or the status label in its colour.

export function ContextAside({
  task,
  all,
}: {
  task: Task;
  all: readonly Task[];
}) {
  const { t } = useTranslation(["tasks"] as const);
  if (task.subtasks != null) {
    const progress = progressOf(task, all);
    return (
      <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground tabular-nums">
        <ProgressBar progress={progress} className="w-12" />
        {t("side.progress", { done: progress.done, total: progress.total })}
      </span>
    );
  }
  if (isWaiting(task))
    return (
      <span className="inline-flex shrink-0 items-center gap-1 border px-1.5 text-xs leading-5 text-muted-foreground">
        <LockSimpleIcon aria-hidden="true" className="size-3" />
        {t("side.waitPrereq")}
      </span>
    );
  return <StatusPill status={task.status} icon={false} />;
}

/**
 * The end of a row in the task tab: why it needs the user (its label), how far a piece of work is,
 * how long a run has gone, or whom it waits for.
 */
export function SideMarker({
  task,
  all,
}: {
  task: Task;
  all: readonly Task[];
}) {
  const { t } = useTranslation(["tasks"] as const);
  if (task.subtasks != null) return <ContextAside task={task} all={all} />;
  if (task.status === "in_progress" && isRunning(task))
    return <RunningFor task={task} short />;
  if (isWaiting(task)) {
    const waiting = waitsOf(task).filter((w) => w.state === "waiting");
    return (
      <span className="inline-flex max-w-[45%] min-w-0 shrink-0 items-center gap-1 text-xs text-muted-foreground">
        <LockSimpleIcon aria-hidden="true" className="size-3 shrink-0" />
        <span className="truncate">
          {waiting.length === 1
            ? waiting[0]!.title
            : t("chatCard.waitMany", { count: waiting.length })}
        </span>
      </span>
    );
  }
  if (task.status === "blocked" || task.status === "in_review")
    return <StatusPill status={task.status} icon={false} />;
  return null;
}
