import type { Progress, Segment } from "./task-plan";
import type { Task, TaskStatus } from "@/queries/tasks";
import { LockSimpleIcon } from "@phosphor-icons/react/LockSimple";
import { useEffect, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

import { cn } from "@/lib/utils";
import {
  useAddDependency,
  useRemoveDependency,
  useTask,
} from "@/queries/tasks";
import { wireErrorMessage } from "@/queries/wire";
import { ago } from "./task-format";
import { useProjectOf } from "./task-hooks";
import { useTaskNav } from "./task-nav";
import { TaskPicker } from "./task-picker";
import {
  isRunning,
  isWaiting,
  releaseOf,
  waitsOf,
  waitSummary,
} from "./task-plan";
import { blockedLine } from "./task-words";

// The small pieces the board, the list and the plan say a task with: its progress, what it waits
// for, how long it has run, what it lets go, and the ways out of a block.

const showError = (error: Error) => toast.error(wireErrorMessage(error));

const segmentFill: Record<Segment, string> = {
  done: "bg-state-success",
  in_review: "bg-state-warning",
  in_progress: "bg-state-info",
  blocked: "bg-state-error",
  waiting:
    "bg-[repeating-linear-gradient(-45deg,var(--color-border-strong)_0_2px,transparent_2px_4px)]",
  todo: "bg-border",
  backlog: "bg-border",
};

/** A parent's bar: a segment per subtask, in its state's colour. */
export function ProgressBar({
  progress,
  className,
}: {
  progress: Progress;
  className?: string;
}) {
  const { t } = useTranslation(["tasks"] as const);
  return (
    <span
      role="img"
      aria-label={t("cards.progress", {
        done: progress.done,
        total: progress.total,
      })}
      data-progress={progress.segments.map((s) => s.segment).join(" ")}
      className={cn("flex h-1.5 gap-0.5", className)}
    >
      {progress.segments.map(({ task, segment }) => (
        <i
          key={task.id}
          className={cn("min-w-0 flex-1", segmentFill[segment])}
        />
      ))}
    </span>
  );
}

/** The square beside a run that is going. */
export function Pulse({ className }: { className?: string }) {
  return (
    <i
      aria-hidden="true"
      className={cn(
        "inline-block size-1.5 shrink-0 bg-current motion-safe:animate-run-blink",
        className,
      )}
    />
  );
}

/** Minutes since a time, kept current. */
function useMinutesSince(at: number | null | undefined) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (at == null) return;
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [at]);
  return at == null ? undefined : Math.max(0, Math.floor((now - at) / 60_000));
}

/**
 * "Running 6 minutes", from the start of the task's newest run. The list does not carry when a
 * run started; the task's own target does, so only a task that is running reads it.
 */
export function RunningFor({
  task,
  short = false,
  className,
}: {
  task: Task;
  short?: boolean;
  className?: string;
}) {
  const { t } = useTranslation(["tasks"] as const);
  const { task: detail } = useTask(task.id);
  const run = detail?.runs.filter((r) => r.agentId === null).at(-1);
  const minutes = useMinutesSince(run?.startedAt);
  const words =
    minutes === undefined
      ? t("cards.runningUnknown")
      : short
        ? t("cards.minutes", { count: minutes })
        : t("cards.running", { count: minutes });
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 text-xs text-state-info-ink",
        className,
      )}
    >
      <Pulse />
      {words}
    </span>
  );
}

/** The lock that says a task waits for others: "Waiting for <title> to be delivered". */
export function WaitChip({
  task,
  all,
  className,
}: {
  task: Task;
  all: readonly Task[];
  className?: string;
}) {
  const { t } = useTranslation(["tasks"] as const);
  const wait = waitSummary(task, all);
  if (wait === undefined) return null;
  return (
    <span
      data-wait
      className={cn(
        "inline-flex max-w-full min-w-0 items-center gap-1.5 border bg-card px-2 text-xs leading-5",
        className,
      )}
    >
      <LockSimpleIcon aria-hidden="true" className="size-3 shrink-0" />
      <span className="truncate">
        {wait.kind === "one" ? (
          <Trans
            t={t}
            i18nKey={
              wait.requireDone ? "cards.waitDone" : "cards.waitDelivered"
            }
            values={{ title: wait.title }}
            components={{ b: <b className="font-medium" /> }}
          />
        ) : (
          t("cards.waitMany", { total: wait.total, left: wait.left })
        )}
      </span>
    </span>
  );
}

/**
 * What a task is doing or waiting for, in one line, for a list row or a plan node: running for so
 * long, waiting for whom, stuck on what, waiting for review, or settled and when.
 */
export function TaskLine({
  task,
  all,
  step,
  className,
}: {
  task: Task;
  all: readonly Task[];
  /** Its step among its parent's subtasks, said for what is done and needs nothing more. */
  step?: number | undefined;
  className?: string;
}) {
  const { t } = useTranslation(["tasks"] as const);
  const base = cn("min-w-0 truncate text-xs", className);
  if (isRunning(task)) return <RunningFor task={task} className={base} />;
  if (task.status === "blocked")
    return (
      <span className={cn(base, "text-state-error-ink")}>
        {blockedLine(task, all)}
      </span>
    );
  if (isWaiting(task)) {
    const wait = waitSummary(task, all)!;
    return (
      <span
        className={cn(
          base,
          "inline-flex items-center gap-1 text-muted-foreground",
        )}
      >
        <LockSimpleIcon aria-hidden="true" className="size-3 shrink-0" />
        <span className="truncate">
          {wait.kind === "one"
            ? t(wait.requireDone ? "lines.waitDone" : "lines.waitDelivered", {
                title: wait.title,
              })
            : t("cards.waitMany", { total: wait.total, left: wait.left })}
        </span>
      </span>
    );
  }
  const released = releaseOf(task, all).released;
  const words: Partial<Record<TaskStatus, string>> = {
    in_progress: t("lines.inProgress"),
    in_review:
      released > 0
        ? `${t("lines.review")} · ${t("cards.released", { count: released })}`
        : t("lines.review"),
    todo: t("lines.todo"),
    backlog: t("lines.backlog"),
    cancelled: t("lines.cancelled"),
    done:
      step === undefined
        ? `${t("lines.done")} · ${ago(task.updatedAt)}`
        : t("cards.step", { count: step }),
  };
  return (
    <span
      className={cn(
        base,
        task.status === "in_review"
          ? "text-state-warning-ink"
          : "text-muted-foreground",
        task.status === "in_progress" && "text-state-info-ink",
      )}
    >
      {words[task.status]}
    </span>
  );
}

/**
 * Pick another task to wait for, instead of the cancelled one: the one picker of tasks, without
 * what it waits for already (picking that would only reset how it lets go).
 */
function ReplaceDependency({
  task,
  cancelled,
  disabled,
}: {
  task: Task;
  cancelled: string[];
  disabled: boolean;
}) {
  const { t } = useTranslation(["tasks"] as const);
  const add = useAddDependency();
  const remove = useRemoveDependency();
  const projectOf = useProjectOf();
  return (
    <TaskPicker
      mode="dependsOn"
      subject={{ id: task.id, parentId: task.parentId ?? null }}
      projectId={projectOf(task)}
      exclude={[
        ...cancelled,
        ...(task.dependsOn ?? []).map((edge) => edge.taskId),
      ]}
      onPick={(other, requireDone) =>
        add.mutate(
          { taskId: task.id, dependsOn: other.id, requireDone },
          {
            onError: showError,
            // Once it waits for the new one, it no longer needs the cancelled ones.
            onSuccess: () => {
              for (const old of cancelled)
                remove.mutate(
                  { taskId: task.id, dependsOn: old },
                  { onError: showError },
                );
            },
          },
        )
      }
    >
      <Button variant="outline" size="xs" disabled={disabled}>
        {t("cards.replace")}
      </Button>
    </TaskPicker>
  );
}

/**
 * Where a blocked task with nothing of its own to change is dealt with: the parent whose
 * prerequisite was cancelled, or the piece of work itself, whose page has the ways on.
 */
function GoDeal({ task, all }: { task: Task; all: readonly Task[] }) {
  const { t } = useTranslation(["tasks"] as const);
  const [, setNav] = useTaskNav();
  const inherited = waitsOf(task).find(
    (w) => w.state === "cancelled" && w.via !== null,
  );
  const owner =
    inherited === undefined
      ? task
      : (all.find((x) => x.number === inherited.via) ?? task);
  return (
    <Button
      variant="outline"
      size="xs"
      onClick={(event) => {
        event.stopPropagation();
        void setNav({ task: owner.id });
      }}
    >
      {owner.id === task.id
        ? t("cards.dealHere")
        : t("cards.dealOnParent", { number: owner.number })}
    </Button>
  );
}

/**
 * The two ways out of a block a cancelled task made: stop waiting and start now (the task's own
 * edges to cancelled tasks go, and the host lets it start), or wait for another task instead.
 * Inherited edges are the parent's to change, so only the task's own are offered.
 */
export function BlockedActions({
  task,
  all,
  className,
}: {
  task: Task;
  all: readonly Task[];
  className?: string;
}) {
  const { t } = useTranslation(["tasks"] as const);
  const remove = useRemoveDependency();
  const own = waitsOf(task)
    .filter((w) => w.state === "cancelled" && w.via === null)
    .map((w) => w.taskId);
  if (task.status !== "blocked") return null;
  // Nothing of its own to change: the way to where it is dealt with.
  if (own.length === 0)
    return (
      <div
        role="group"
        aria-label={t("cards.blockedExits")}
        className={cn("flex flex-wrap gap-1.5", className)}
      >
        <GoDeal task={task} all={all} />
      </div>
    );
  return (
    <div
      role="group"
      aria-label={t("cards.blockedExits")}
      className={cn("flex flex-wrap gap-1.5", className)}
    >
      <Button
        variant="outline"
        size="xs"
        disabled={remove.isPending}
        onClick={() => {
          for (const dependsOn of own)
            remove.mutate(
              { taskId: task.id, dependsOn },
              { onError: showError },
            );
        }}
      >
        {t("cards.startAnyway")}
      </Button>
      <ReplaceDependency
        task={task}
        cancelled={own}
        disabled={remove.isPending}
      />
    </div>
  );
}
