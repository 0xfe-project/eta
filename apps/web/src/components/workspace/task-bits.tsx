import type { Progress, Segment } from "./task-plan";
import type { Task, TaskStatus } from "@/queries/tasks";
import { LockSimpleIcon } from "@phosphor-icons/react/LockSimple";
import { useEffect, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import {
  useAddDependency,
  useRemoveDependency,
  useTask,
} from "@/queries/tasks";
import { wireErrorMessage } from "@/queries/wire";
import { ago } from "./task-format";
import {
  edgeRefusal,
  isRunning,
  isWaiting,
  releaseOf,
  waitsOf,
  waitSummary,
} from "./task-plan";
import { StatusIcon } from "./task-status-icon";
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
 * Pick another task to wait for, instead of the cancelled one: the tasks it may wait for come
 * first, those it may not are greyed with why (a cycle, its own parent or subtask, cancelled).
 */
function ReplaceDependency({
  task,
  all,
  cancelled,
  disabled,
}: {
  task: Task;
  all: readonly Task[];
  cancelled: string[];
  disabled: boolean;
}) {
  const { t } = useTranslation(["tasks"] as const);
  const add = useAddDependency();
  const remove = useRemoveDependency();
  const [open, setOpen] = useState(false);
  const candidates = all
    // What it waits for already is not a new choice: picking it would only reset how it lets go.
    .filter(
      (other) =>
        other.id !== task.id &&
        !cancelled.includes(other.id) &&
        !(task.dependsOn ?? []).some((e) => e.taskId === other.id),
    )
    .map((other) => ({ other, refusal: edgeRefusal(task.id, other.id, all) }))
    .sort((a, b) => Number(Boolean(a.refusal)) - Number(Boolean(b.refusal)));
  const choose = (dependsOn: string) => {
    setOpen(false);
    add.mutate(
      { taskId: task.id, dependsOn },
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
    );
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="xs" disabled={disabled}>
          {t("cards.replace")}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 p-0">
        <Command>
          <CommandInput placeholder={t("cards.replaceSearch")} />
          <CommandList>
            <CommandEmpty>{t("cards.noCandidates")}</CommandEmpty>
            <CommandGroup heading={t("cards.replaceTitle")}>
              {candidates.map(({ other, refusal }) => (
                <CommandItem
                  key={other.id}
                  value={`#${other.number} ${other.title}`}
                  disabled={refusal !== undefined}
                  onSelect={() => choose(other.id)}
                  className="gap-2"
                >
                  <StatusIcon status={other.status} className="size-3.5" />
                  <span className="w-8 shrink-0 text-muted-foreground tabular-nums">
                    #{other.number}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{other.title}</span>
                  {refusal === undefined ? null : (
                    <span className="shrink-0 text-xs text-destructive">
                      {t(`cards.refusal.${refusal}`)}
                    </span>
                  )}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
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
  if (task.status !== "blocked" || own.length === 0) return null;
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
        all={all}
        cancelled={own}
        disabled={remove.isPending}
      />
    </div>
  );
}
