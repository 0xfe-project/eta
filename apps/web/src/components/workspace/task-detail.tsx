import type { TaskDependencyView } from "@eta/client-contracts";
import type { QueueMachine } from "./task-words";
import type { Task, TaskDetail } from "@/queries/tasks";
import { ArrowRightIcon } from "@phosphor-icons/react/ArrowRight";
import { LockSimpleIcon } from "@phosphor-icons/react/LockSimple";
import { PlusIcon } from "@phosphor-icons/react/Plus";
import { WarningIcon } from "@phosphor-icons/react/Warning";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useMachines } from "@/queries/projects";
import {
  useAddDependency,
  useRemoveDependency,
  useUpdateTask,
} from "@/queries/tasks";
import { wireErrorMessage } from "@/queries/wire";
import { ProgressBar, RunningFor } from "./task-bits";
import { ago } from "./task-format";
import { useExecutorName } from "./task-hooks";
import { useTaskNav } from "./task-nav";
import { useNewTask } from "./task-new-store";
import { TaskPicker } from "./task-picker";
import {
  blockedReason,
  childrenOf,
  isWaiting,
  planOf,
  progressOf,
  waitsOf,
  waitSummary,
} from "./task-plan";
import { StatusIcon } from "./task-status-icon";
import { flowWord, queueSentence } from "./task-words";

// The parts of a task's own page that say where it stands in the graph: what comes before and
// after it, why it has not started and what to do about it, why it is stuck, and, for a piece of
// work, how far along its subtasks are. The host decides all of it; these say it and send the
// user's choice.

const showError = (error: Error) => toast.error(wireErrorMessage(error));

/** The machine the task's queued run waits on, as far as the page can tell. */
function useQueueMachine(task: TaskDetail): QueueMachine | undefined {
  const { machines } = useMachines();
  const run = task.runs
    .filter((r) => r.agentId === null && r.status === "queued")
    .at(-1);
  if (run?.queueReason == null) return undefined;
  const machine = machines.find((m) => m.id === run.machineId);
  return {
    reason: run.queueReason,
    name: machine?.name,
    max: machine?.maxActiveRuns,
  };
}

// --- the flow bar --------------------------------------------------------------------

function FlowNode({
  edge,
  side,
}: {
  edge: TaskDependencyView;
  side: "before" | "after";
}) {
  const [, setNav] = useTaskNav();
  return (
    <li>
      <button
        type="button"
        onClick={() => void setNav({ task: edge.taskId })}
        className="flex w-full min-w-0 items-start gap-1.5 border bg-card px-2.5 py-1.5 text-left text-xs leading-5 hover:border-foreground/40"
      >
        <StatusIcon status={edge.status} className="mt-0.75 size-3.5" />
        <span className="min-w-0 flex-1 wrap-anywhere">{edge.title}</span>
        <span
          className={cn(
            "shrink-0",
            edge.state === "cancelled"
              ? "text-state-error-ink"
              : "text-muted-foreground",
          )}
        >
          {flowWord(side, edge)}
        </span>
      </button>
    </li>
  );
}

/**
 * "Before → this task → after": what it waits for, itself, and what waits for it, each by its whole
 * title and where it stands. On a phone, two groups one under the other.
 */
export function FlowBar({
  task,
  phone = false,
}: {
  task: TaskDetail;
  phone?: boolean;
}) {
  const { t } = useTranslation(["tasks"] as const);
  const before = task.dependsOn ?? [];
  const after = task.dependents ?? [];
  if (before.length === 0 && after.length === 0) return null;
  const left = waitsOf(task).filter((w) => w.state === "waiting").length;
  const column = (
    side: "before" | "after",
    edges: TaskDependencyView[],
    label: string,
  ) =>
    edges.length === 0 ? null : (
      <section aria-label={label} className="min-w-0 flex-1 space-y-1">
        <h3 className="text-xs text-muted-foreground">
          {label} · {edges.length}
        </h3>
        <ul className="space-y-1">
          {edges.map((edge) => (
            <FlowNode key={edge.taskId} edge={edge} side={side} />
          ))}
        </ul>
      </section>
    );
  if (phone)
    return (
      <div data-flow="column" className="space-y-3">
        {column("before", before, t("flow.before"))}
        {column("after", after, t("flow.after"))}
      </div>
    );
  return (
    <div data-flow="row" className="flex items-center gap-2">
      {column("before", before, t("flow.before"))}
      {before.length > 0 ? (
        <ArrowRightIcon
          aria-hidden="true"
          className="mt-5 size-3.5 shrink-0 text-muted-foreground"
        />
      ) : null}
      <div className="mt-5 flex min-w-0 flex-1 items-center gap-1.5 border-2 border-foreground bg-card px-3 py-2 text-xs">
        {left > 0 ? (
          <LockSimpleIcon aria-hidden="true" className="size-3.5 shrink-0" />
        ) : (
          <StatusIcon status={task.status} className="size-3.5" />
        )}
        <span className="font-semibold">{t("flow.self")}</span>
        <span className="ml-auto shrink-0 text-muted-foreground">
          {left > 0
            ? t("flow.left", { count: left })
            : flowWord("before", { status: task.status, state: "resolved" })}
        </span>
      </div>
      {after.length > 0 ? (
        <ArrowRightIcon
          aria-hidden="true"
          className="mt-5 size-3.5 shrink-0 text-muted-foreground"
        />
      ) : null}
      {column("after", after, t("flow.after"))}
    </div>
  );
}

// --- why it has not started ----------------------------------------------------------

/**
 * Why the task has not started, as a sentence, and, when it waits for one task of its own, the
 * three things to do: wait for delivery (as it does), wait until it is done, or not wait.
 */
export function QueueReason({
  task,
  all,
}: {
  task: TaskDetail;
  all: readonly Task[];
}) {
  const { t } = useTranslation(["tasks"] as const);
  const who = useExecutorName(task) ?? t("executor.me");
  const machine = useQueueMachine(task);
  const add = useAddDependency();
  const remove = useRemoveDependency();
  const sentence = queueSentence(task, all, who, machine);
  if (sentence === undefined) return null;
  const own = waitsOf(task).filter(
    (w) => w.state === "waiting" && w.via === null,
  );
  const wait = waitSummary(task, all);
  const one = own.length === 1 && wait?.kind === "one" ? own[0] : undefined;
  const busy = add.isPending || remove.isPending;
  const setRequireDone = (requireDone: boolean) => {
    if (one === undefined || wait?.kind !== "one") return;
    // The edge is already that way: nothing to send.
    if (wait.requireDone === requireDone) return;
    add.mutate(
      { taskId: task.id, dependsOn: one.taskId, requireDone },
      { onError: showError },
    );
  };
  return (
    <section
      aria-label={t("queue.label")}
      data-queue
      className="space-y-2 border bg-muted/50 px-3 py-2.5 text-sm"
    >
      <p className="flex items-start gap-2">
        <LockSimpleIcon
          aria-hidden="true"
          className="mt-0.75 size-3.5 shrink-0 text-muted-foreground"
        />
        <span>
          {sentence.includes("：") ? (
            <>
              <b className="font-semibold">
                {sentence.slice(0, sentence.indexOf("：") + 1)}
              </b>
              {sentence.slice(sentence.indexOf("：") + 1)}
            </>
          ) : (
            sentence
          )}
        </span>
      </p>
      {isWaiting(task) && own.length > 0 ? (
        <div
          role="group"
          className="flex flex-wrap items-center gap-x-2 pl-5.5 text-xs text-muted-foreground"
        >
          {one !== undefined && wait?.kind === "one" ? (
            <>
              <QueueChoice
                pressed={!wait.requireDone}
                disabled={busy}
                onClick={() => setRequireDone(false)}
              >
                {t("queue.waitDelivery")}
              </QueueChoice>
              <span aria-hidden="true">·</span>
              <QueueChoice
                pressed={wait.requireDone}
                disabled={busy}
                onClick={() => setRequireDone(true)}
              >
                {t("queue.waitDone")}
              </QueueChoice>
              <span aria-hidden="true">·</span>
            </>
          ) : null}
          <QueueChoice
            disabled={busy}
            onClick={() => {
              for (const w of own)
                remove.mutate(
                  { taskId: task.id, dependsOn: w.taskId },
                  { onError: showError },
                );
            }}
          >
            {t("queue.startNow")}
          </QueueChoice>
        </div>
      ) : null}
    </section>
  );
}

/** One of the queue's choices, as a link; the one that holds now is plain. */
function QueueChoice({
  pressed,
  disabled,
  onClick,
  children,
}: {
  pressed?: boolean;
  disabled: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "py-0.5 outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50",
        pressed === true
          ? "text-muted-foreground"
          : "text-foreground underline underline-offset-4 hover:decoration-2",
      )}
    >
      {children}
    </button>
  );
}

// --- stuck -----------------------------------------------------------------------------

/**
 * The red banner under the title of a task a cancelled dependency stopped: what was cancelled and
 * when, that the executor will not start it, and the four ways on: start now, wait for another
 * task, cancel this one, or go and see why that one was cancelled.
 */
export function BlockedBanner({
  task,
  all,
}: {
  task: TaskDetail;
  all: readonly Task[];
}) {
  const { t } = useTranslation(["tasks"] as const);
  const [, setNav] = useTaskNav();
  const who = useExecutorName(task) ?? t("executor.me");
  const add = useAddDependency();
  const remove = useRemoveDependency();
  const update = useUpdateTask();
  const openNew = useNewTask((s) => s.open);
  if (task.status !== "blocked") return null;
  const cancelled = waitsOf(task).filter((w) => w.state === "cancelled");
  const own = cancelled.filter((w) => w.via === null).map((w) => w.taskId);
  const inherited = cancelled.find((w) => w.via !== null);
  const cancelButton = (
    <Button
      variant="outline"
      size="xs"
      disabled={update.isPending}
      onClick={() =>
        update.mutate(
          { taskId: task.id, status: "cancelled" },
          { onError: showError },
        )
      }
    >
      {t("stuck.cancel")}
    </Button>
  );
  // A piece of work whose subtasks were all cancelled, or a subtask held by its parent's cancelled
  // prerequisite: nothing of its own to change, so the ways on are elsewhere.
  if (own.length === 0) {
    const parentOwner =
      inherited === undefined
        ? undefined
        : all.find((x) => x.number === inherited.via);
    const allCancelled =
      inherited === undefined &&
      blockedReason(task, all).kind === "allCancelled";
    if (!allCancelled && parentOwner === undefined) return null;
    return (
      <StuckFrame title={t("stuck.title")}>
        <p>
          {allCancelled
            ? t("stuck.allCancelled")
            : t("stuck.inherited", {
                title: parentOwner!.title,
                number: parentOwner!.number,
              })}
        </p>
        <div role="group" className="flex flex-wrap gap-1.5">
          {allCancelled ? (
            <Button
              variant="outline"
              size="xs"
              onClick={() => openNew({ parentId: task.id })}
            >
              {t("stuck.splitOne")}
            </Button>
          ) : (
            <Button
              variant="outline"
              size="xs"
              onClick={() => void setNav({ task: parentOwner!.id })}
            >
              {t("stuck.goParent", { number: parentOwner!.number })}
            </Button>
          )}
          {cancelButton}
        </div>
      </StuckFrame>
    );
  }
  const first = cancelled[0]!;
  const when = all.find((x) => x.id === first.taskId)?.updatedAt;
  const busy = add.isPending || remove.isPending || update.isPending;
  const dropCancelled = () => {
    for (const dependsOn of own)
      remove.mutate({ taskId: task.id, dependsOn }, { onError: showError });
  };
  return (
    <section
      role="alert"
      aria-label={t("stuck.title")}
      data-stuck
      className="space-y-2 border border-l-4 border-state-error bg-state-error/8 px-3 py-2.5 text-sm"
    >
      <p className="flex items-center gap-2 font-medium text-state-error-ink">
        <WarningIcon aria-hidden="true" className="size-4 shrink-0" />
        {t("stuck.title")}
      </p>
      <p>
        {cancelled.length === 1
          ? t("stuck.body", {
              title: first.title,
              number: first.number,
              when: when === undefined ? "" : ago(when),
              who,
            })
          : t("stuck.bodyMany", { count: cancelled.length, who })}
      </p>
      <div role="group" className="flex flex-wrap gap-1.5">
        <Button
          variant="outline"
          size="xs"
          disabled={busy || own.length === 0}
          onClick={dropCancelled}
        >
          {t("stuck.startNow")}
        </Button>
        <TaskPicker
          mode="dependsOn"
          subject={{ id: task.id, parentId: task.parentId ?? null }}
          projectId={task.projectId ?? undefined}
          exclude={[...own, ...(task.dependsOn ?? []).map((e) => e.taskId)]}
          onPick={(other, requireDone) => {
            const already = (task.dependsOn ?? []).find(
              (e) => e.taskId === other.id,
            );
            const done = () => dropCancelled();
            // An edge that is there already is not sent again (only its release, if that changed).
            if (already !== undefined && already.requireDone === requireDone)
              return done();
            add.mutate(
              { taskId: task.id, dependsOn: other.id, requireDone },
              { onError: showError, onSuccess: done },
            );
          }}
        >
          <Button
            variant="outline"
            size="xs"
            disabled={busy || own.length === 0}
          >
            {t("stuck.replace")}
          </Button>
        </TaskPicker>
        <Button
          variant="outline"
          size="xs"
          disabled={busy}
          onClick={() =>
            update.mutate(
              { taskId: task.id, status: "cancelled" },
              { onError: showError },
            )
          }
        >
          {t("stuck.cancel")}
        </Button>
        <Button
          variant="ghost"
          size="xs"
          onClick={() => void setNav({ task: first.taskId })}
        >
          {t("stuck.why", { number: first.number })}
        </Button>
      </div>
    </section>
  );
}

/** The red frame of a stuck task, with its heading. */
function StuckFrame({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section
      role="alert"
      aria-label={title}
      data-stuck
      className="space-y-2 border border-l-4 border-state-error bg-state-error/8 px-3 py-2.5 text-sm"
    >
      <p className="flex items-center gap-2 font-medium text-state-error-ink">
        <WarningIcon aria-hidden="true" className="size-4 shrink-0" />
        {title}
      </p>
      {children}
    </section>
  );
}

// --- a piece of work -------------------------------------------------------------------

function ProgressLine({ task }: { task: Task }) {
  const { t } = useTranslation(["tasks"] as const);
  const [, setNav] = useTaskNav();
  return (
    <li>
      <button
        type="button"
        onClick={() => void setNav({ task: task.id })}
        className="flex w-full min-w-0 items-center gap-1.5 text-left text-xs leading-6 hover:underline"
      >
        <StatusIcon status={task.status} className="size-3.5" />
        <span className="min-w-0 flex-1 truncate">{task.title}</span>
        {task.status === "in_progress" ? (
          <RunningFor task={task} short className="text-xs" />
        ) : task.status === "in_review" ? (
          <span className="shrink-0 text-state-warning-ink">
            {t("progress.toReview")}
          </span>
        ) : null}
      </button>
    </li>
  );
}

/**
 * How far a piece of work is: its bar, and its subtasks in three columns, done, now and next. The
 * parent does no work of its own; it says so.
 */
export function ProgressCard({
  task,
  all,
}: {
  task: Task;
  all: readonly Task[];
}) {
  const { t } = useTranslation(["tasks"] as const);
  const progress = progressOf(task, all);
  const live = childrenOf(task.id, all).filter((c) => c.status !== "cancelled");
  const plan = planOf(live);
  const byStep = (a: Task, b: Task) =>
    plan.stepOf.get(a.id)! - plan.stepOf.get(b.id)! || a.number - b.number;
  const done = live.filter((c) => c.status === "done").sort(byStep);
  const now = live
    .filter(
      (c) =>
        c.status === "in_progress" ||
        c.status === "in_review" ||
        c.status === "blocked",
    )
    .sort(byStep);
  const next = live
    .filter((c) => c.status === "todo" || c.status === "backlog")
    .sort(byStep);
  const columns = [
    ["done", done],
    ["now", now],
    ["next", next],
  ] as const;
  return (
    <section
      aria-labelledby="task-progress"
      data-progress-card
      className="space-y-3 border bg-card p-3"
    >
      <h2
        id="task-progress"
        className="flex flex-wrap items-baseline gap-x-2 text-sm font-semibold"
      >
        {t("progress.title")}
        <span className="text-xs font-normal text-muted-foreground tabular-nums">
          {t("progress.summary", {
            done: progress.done,
            total: progress.total,
          })}
        </span>
      </h2>
      <ProgressBar progress={progress} className="h-2" />
      <div className="grid grid-cols-1 gap-3 @lg:grid-cols-3">
        {columns.map(([key, tasks]) => (
          <section
            key={key}
            aria-label={t(`progress.${key}`)}
            className="min-w-0"
          >
            <h3 className="text-xs text-muted-foreground">
              {t(`progress.${key}`)}
            </h3>
            {tasks.length === 0 ? (
              <p className="text-xs leading-6 text-faint">—</p>
            ) : (
              <ul>
                {tasks.map((c) => (
                  <ProgressLine key={c.id} task={c} />
                ))}
              </ul>
            )}
          </section>
        ))}
      </div>
    </section>
  );
}

/** A piece of work's subtasks, each with its step, and "+ split one out". */
export function SubtaskList({
  task,
  all,
}: {
  task: Task;
  all: readonly Task[];
}) {
  const { t } = useTranslation(["tasks"] as const);
  const [, setNav] = useTaskNav();
  const open = useNewTask((s) => s.open);
  const children = childrenOf(task.id, all);
  const plan = planOf(children.filter((c) => c.status !== "cancelled"));
  const sorted = [...children].sort(
    (a, b) =>
      (plan.stepOf.get(a.id) ?? 99) - (plan.stepOf.get(b.id) ?? 99) ||
      a.number - b.number,
  );
  return (
    <section aria-labelledby="task-subtasks" className="space-y-1.5">
      <h2
        id="task-subtasks"
        className="flex items-center gap-2 text-sm font-semibold"
      >
        {t("graph.children")}
        <span className="font-normal text-muted-foreground tabular-nums">
          {children.length}
        </span>
        <Button
          variant="ghost"
          size="xs"
          className="ml-auto"
          onClick={() => open({ parentId: task.id })}
        >
          <PlusIcon aria-hidden="true" />
          {t("progress.splitOne")}
        </Button>
      </h2>
      <ul className="divide-y border-y">
        {sorted.map((child) => {
          const step = plan.stepOf.get(child.id);
          return (
            <li key={child.id}>
              <button
                type="button"
                onClick={() => void setNav({ task: child.id })}
                className="flex w-full min-w-0 items-center gap-2 px-1 py-1.5 text-left text-sm hover:bg-muted/60"
              >
                <StatusIcon status={child.status} className="size-3.5" />
                <span className="w-8 shrink-0 text-xs text-muted-foreground tabular-nums">
                  #{child.number}
                </span>
                <span className="min-w-0 flex-1 truncate">{child.title}</span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {step === undefined
                    ? t("lines.cancelled")
                    : t("cards.step", { count: step })}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
