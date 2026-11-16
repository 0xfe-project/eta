import type { Task, TaskStatus } from "@/queries/tasks";
import { runningFirst } from "@eta/client-contracts";
import { CaretDownIcon } from "@phosphor-icons/react/CaretDown";
import { CaretLeftIcon } from "@phosphor-icons/react/CaretLeft";
import { CaretRightIcon } from "@phosphor-icons/react/CaretRight";
import { LockSimpleIcon } from "@phosphor-icons/react/LockSimple";
import { TreeStructureIcon } from "@phosphor-icons/react/TreeStructure";
import { useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { agentName, useAgentList } from "@/queries/agents";
import { useUpdateTask } from "@/queries/tasks";
import { wireErrorMessage } from "@/queries/wire";
import {
  BlockedActions,
  ProgressBar,
  Pulse,
  RunningFor,
  TaskLine,
  WaitChip,
} from "./task-bits";
import { ago, statusLabel, statusTone } from "./task-format";
import { useTaskNav } from "./task-nav";
import {
  childrenOf,
  executorOf,
  isRunning,
  isWaiting,
  planOf,
  progressOf,
  stepAmongSiblings,
} from "./task-plan";
import { StatusIcon, StatusPill } from "./task-status-icon";
import {
  blockedLine,
  progressCounts,
  releaseLabel,
  waitingStripes,
} from "./task-words";
import { RunState } from "./tasks";

// The board: a column per status, the way work moves, with the backlog and the cancelled folded
// away on the right until opened. A card says how the task stands with the others: what it waits
// for, which piece of work it is a step of, what it lets go once delivered. On a phone the board
// is one column at a time, swiped across.

const showError = (error: Error) => toast.error(wireErrorMessage(error));

/** The columns in the order work moves through them. */
const main: TaskStatus[] = [
  "todo",
  "in_progress",
  "in_review",
  "blocked",
  "done",
];
/** Folded on the right until opened. */
const aside: TaskStatus[] = ["backlog", "cancelled"];

const dragType = "application/x-eta-task";

/** Who executes a task, by name. */
function useExecutorName() {
  const { t } = useTranslation(["tasks"] as const);
  const { agents } = useAgentList();
  return (task: Task) => {
    const id = executorOf(task);
    return id === null ? t("assignee.me") : agentName(agents, id);
  };
}

/** The parent's title and the step: "Release v1.0 › Step 2". */
function Crumb({ task, all }: { task: Task; all: readonly Task[] }) {
  const { t } = useTranslation(["tasks"] as const);
  if (task.parentId == null) return null;
  const parent = all.find((p) => p.id === task.parentId);
  if (parent === undefined) return null;
  const step = stepAmongSiblings(task, all);
  return (
    <span className="block truncate text-xs text-muted-foreground/80">
      <span className="text-muted-foreground">{parent.title}</span>
      {step === undefined ? null : ` › ${t("cards.step", { count: step })}`}
    </span>
  );
}

/** The card's corner: the lock, the run, "waiting for you", or the status mark. */
function Corner({ task }: { task: Task }) {
  const { t } = useTranslation(["tasks"] as const);
  if (isWaiting(task))
    return (
      <LockSimpleIcon
        aria-label={t("cards.waiting")}
        className="size-3.5 text-muted-foreground"
      />
    );
  if (isRunning(task)) return <RunningFor task={task} />;
  // A run outside of in progress (queued, a reply on a review) or one that failed still shows.
  const run = <RunState task={task} />;
  if (task.status === "in_review")
    return (
      <span className="flex items-center gap-2">
        {run}
        <StatusPill status="in_review">{t("cards.review")}</StatusPill>
      </span>
    );
  return (
    <span className="flex items-center gap-2">
      {run}
      <StatusIcon status={task.status} className="size-3.5" />
    </span>
  );
}

/** The card's whole face is the button that opens it; what sits on top of it (z-10) is its own. */
const stretched =
  "text-left outline-none after:absolute after:inset-0 after:content-[''] focus-visible:after:ring-1 focus-visible:after:ring-ring";

function TaskCard({ task, all }: { task: Task; all: readonly Task[] }) {
  // Re-render on a language change: the card's words come from `translate`.
  useTranslation(["tasks"] as const);
  const [, setNav] = useTaskNav();
  const executor = useExecutorName();
  const waiting = isWaiting(task);
  const blocked = task.status === "blocked";
  const right = releaseLabel(task, all) ?? ago(task.updatedAt);
  return (
    <li
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(dragType, task.id);
        e.dataTransfer.effectAllowed = "move";
      }}
      data-task={task.number}
      data-waiting={waiting || undefined}
      className={cn(
        "relative space-y-1 border bg-card px-2.5 py-2 text-sm duration-[60ms] ease-linear hover:border-foreground/30 active:cursor-grabbing",
        waiting && waitingStripes,
        blocked && "border-l-[3px] border-l-state-error",
        (task.status === "done" || task.status === "cancelled") && "opacity-75",
      )}
    >
      <Crumb task={task} all={all} />
      <span className="flex items-center justify-between gap-2 text-xs text-muted-foreground tabular-nums">
        #{task.number}
        <Corner task={task} />
      </span>
      <button
        type="button"
        onClick={() => void setNav({ task: task.id })}
        className={cn("block w-full", stretched)}
      >
        <span className="line-clamp-3 leading-snug wrap-anywhere">
          {task.title}
        </span>
      </button>
      {waiting ? <WaitChip task={task} all={all} className="mt-0.5" /> : null}
      {blocked ? (
        <>
          <p className="text-xs text-state-error-ink">
            {blockedLine(task, all)}
          </p>
          <BlockedActions
            task={task}
            all={all}
            className="relative z-10 pt-1"
          />
        </>
      ) : null}
      {blocked ? null : (
        <span className="flex items-center justify-between gap-2 pt-0.5 text-xs text-muted-foreground/80 tabular-nums">
          <span className="truncate">{executor(task)}</span>
          <span className="shrink-0">{right}</span>
        </span>
      )}
    </li>
  );
}

/**
 * A piece of work with subtasks: a stacked edge, a segment per subtask, what is going now and what
 * comes after, how many are in each state; opened, its subtasks are listed under it.
 */
function ParentCard({ task, all }: { task: Task; all: readonly Task[] }) {
  const { t } = useTranslation(["tasks"] as const);
  const [, setNav] = useTaskNav();
  const [open, setOpen] = useState(false);
  const progress = progressOf(task, all);
  const children = childrenOf(task.id, all);
  const plan = planOf(children);
  const ordered = [...children].sort(
    (a, b) =>
      plan.stepOf.get(a.id)! - plan.stepOf.get(b.id)! || a.number - b.number,
  );
  return (
    <li data-task={task.number} data-parent className="space-y-1.5">
      <div className="relative mr-[3px] mb-[3px] space-y-1 border border-border-strong bg-card px-2.5 py-2 text-sm shadow-[3px_3px_0_-1px_var(--color-card),3px_3px_0_0_var(--color-border-strong)] duration-[60ms] ease-linear hover:border-foreground/40">
        <Crumb task={task} all={all} />
        <span className="flex items-center justify-between gap-2 text-xs text-muted-foreground tabular-nums">
          <span className="inline-flex items-center gap-1">
            <TreeStructureIcon aria-hidden="true" className="size-3.5" />
            {`#${task.number} · ${t("cards.subtaskCount", { count: progress.total })}`}
          </span>
          <span className="inline-flex items-center gap-1.5">
            <StatusIcon status={task.status} className="size-3.5" />
            {t("statusMenu.auto")}
          </span>
        </span>
        <button
          type="button"
          onClick={() => void setNav({ task: task.id })}
          className={cn("block w-full", stretched)}
        >
          <span className="line-clamp-3 leading-snug wrap-anywhere">
            {task.title}
          </span>
        </button>
        {progress.total > 0 ? (
          <ProgressBar progress={progress} className="my-1.5" />
        ) : null}
        {progress.now || progress.next ? (
          <p className="flex min-w-0 items-baseline gap-1.5 text-xs text-muted-foreground">
            {progress.now && isRunning(progress.now) ? (
              <Pulse className="text-state-info-ink" />
            ) : null}
            <span className="line-clamp-2 wrap-anywhere">
              {[
                progress.now
                  ? t("cards.now", { title: progress.now.title })
                  : null,
                progress.next
                  ? t("cards.next", { title: progress.next.title })
                  : null,
              ]
                .filter(Boolean)
                .join(" · ")}
            </span>
          </p>
        ) : null}
        <span className="flex items-start justify-between gap-2 pt-0.5 text-xs text-muted-foreground/80 tabular-nums">
          <span className="min-w-0" data-counts>
            {progressCounts(progress)}
          </span>
          {children.length > 0 ? (
            <Button
              variant="ghost"
              size="icon-xs"
              aria-expanded={open}
              aria-label={t(open ? "graph.collapse" : "graph.expand", {
                number: task.number,
              })}
              onClick={() => setOpen((o) => !o)}
              className="relative z-10 -my-1 -mr-1.5 size-5"
            >
              {open ? (
                <CaretDownIcon aria-hidden="true" />
              ) : (
                <CaretRightIcon aria-hidden="true" />
              )}
            </Button>
          ) : null}
        </span>
      </div>
      {open ? (
        <ul
          aria-label={t("graph.children")}
          className="ml-2 space-y-px border-l pl-2"
        >
          {ordered.map((child) => (
            <li key={child.id}>
              <button
                type="button"
                onClick={() => void setNav({ task: child.id })}
                className="flex w-full min-w-0 items-center gap-1.5 px-1 py-1 text-left text-xs outline-none hover:bg-muted focus-visible:bg-muted"
              >
                <StatusIcon status={child.status} className="size-3.5" />
                <span className="shrink-0 text-muted-foreground tabular-nums">
                  #{child.number}
                </span>
                <span className="min-w-0 flex-1 truncate">{child.title}</span>
                <TaskLine
                  task={child}
                  all={all}
                  step={plan.stepOf.get(child.id)}
                  className="max-w-[45%] shrink-0"
                />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function Column({
  status,
  tasks,
  all,
  folded,
  onFold,
  className,
  hideHead = false,
}: {
  status: TaskStatus;
  tasks: readonly Task[];
  all: readonly Task[];
  folded: boolean;
  onFold?: ((folded: boolean) => void) | undefined;
  className?: string;
  hideHead?: boolean;
}) {
  const { t } = useTranslation(["tasks"] as const);
  const update = useUpdateTask();
  const [over, setOver] = useState(false);
  const label = statusLabel(status);
  // Newest first, as the board sends them, but a task that runs before one that waits.
  // A piece of work leads its column; then the board's order, running before waiting.
  const group = runningFirst(
    tasks.filter((task) => task.status === status),
  ).sort((a, b) => Number(b.subtasks != null) - Number(a.subtasks != null));
  const drop = {
    onDragOver: (e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes(dragType)) return;
      e.preventDefault();
      setOver(true);
    },
    onDragLeave: (e: React.DragEvent) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver(false);
    },
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      setOver(false);
      const id = e.dataTransfer.getData(dragType);
      const task = all.find((x) => x.id === id);
      // A parent's status is its subtasks': it is not moved by hand.
      if (task && task.status !== status && task.subtasks == null)
        update.mutate({ taskId: id, status }, { onError: showError });
    },
  };
  if (folded)
    return (
      <section
        aria-label={label}
        data-folded
        {...drop}
        className={cn(
          "flex w-9 shrink-0 flex-col border-t-2 bg-muted/40",
          statusTone(status).border,
          over && "bg-muted outline outline-foreground/30",
        )}
      >
        <button
          type="button"
          aria-expanded={false}
          aria-label={t("cards.showColumn", { name: label })}
          onClick={() => onFold?.(false)}
          className="flex flex-1 flex-col items-center gap-2 pt-2.5 text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
        >
          <StatusIcon status={status} className="size-3.5" />
          <span className="[writing-mode:vertical-rl]">{label}</span>
          <span className="tabular-nums">{group.length}</span>
        </button>
      </section>
    );
  return (
    <section
      aria-label={label}
      {...drop}
      className={cn(
        "flex min-h-0 flex-col border-t-2 duration-[60ms] ease-linear",
        statusTone(status).border,
        over && "bg-muted/60 outline outline-foreground/30",
        className,
      )}
    >
      {hideHead ? null : (
        <div className="flex h-9 shrink-0 items-center gap-2 pr-1 pl-0.5 text-xs">
          <StatusIcon status={status} className="size-3.5" />
          {label}
          <span className="text-muted-foreground tabular-nums">
            {group.length}
          </span>
          {onFold ? (
            <Button
              variant="ghost"
              size="icon-xs"
              aria-expanded
              aria-label={t("cards.hideColumn", { name: label })}
              onClick={() => onFold(true)}
              className="ml-auto"
            >
              <CaretRightIcon aria-hidden="true" />
            </Button>
          ) : null}
        </div>
      )}
      <ul className="min-h-0 flex-1 space-y-2 overflow-y-auto pb-3">
        {group.map((task) =>
          task.subtasks == null ? (
            <TaskCard key={task.id} task={task} all={all} />
          ) : (
            <ParentCard key={task.id} task={task} all={all} />
          ),
        )}
      </ul>
    </section>
  );
}

/** The board on a wide page: the five columns side by side, the backlog and cancelled folded. */
function WideBoard({
  tasks,
  all,
}: {
  tasks: readonly Task[];
  all: readonly Task[];
}) {
  const [unfolded, setUnfolded] = useState<ReadonlySet<TaskStatus>>(
    () => new Set(),
  );
  const fold = (status: TaskStatus) => (folded: boolean) =>
    setUnfolded((was) => {
      const next = new Set(was);
      if (folded) next.delete(status);
      else next.add(status);
      return next;
    });
  return (
    <div className="flex h-full gap-2.5 overflow-x-auto bg-sidebar/60 px-4 pt-3 sm:px-6">
      {main.map((status) => (
        <Column
          key={status}
          status={status}
          tasks={tasks}
          all={all}
          folded={false}
          className="w-60 min-w-52 flex-1"
        />
      ))}
      {aside.map((status) => (
        <Column
          key={status}
          status={status}
          tasks={tasks}
          all={all}
          folded={!unfolded.has(status)}
          onFold={fold(status)}
          className="w-60 min-w-52 flex-1"
        />
      ))}
    </div>
  );
}

/** The board on a phone: one column at a time, swiped across, its neighbours named at the top. */
function PhoneBoard({
  tasks,
  all,
}: {
  tasks: readonly Task[];
  all: readonly Task[];
}) {
  const { t } = useTranslation(["tasks"] as const);
  const columns = [...main, ...aside];
  // Start where the work is going.
  const [index, setIndex] = useState(1);
  const trackRef = useRef<HTMLDivElement>(null);
  // Open on the column it starts at, not the first one the track would show.
  useLayoutEffect(() => {
    const el = trackRef.current;
    if (el) el.scrollLeft = 1 * el.clientWidth;
  }, []);
  const go = (to: number) => {
    const next = Math.max(0, Math.min(columns.length - 1, to));
    setIndex(next);
    const el = trackRef.current;
    el?.scrollTo?.({ left: next * el.clientWidth, behavior: "smooth" });
  };
  const status = columns[index]!;
  const count = tasks.filter((task) => task.status === status).length;
  const prev = columns[index - 1];
  const next = columns[index + 1];
  return (
    <div className="flex h-full flex-col bg-sidebar/60">
      <div className="flex h-9 shrink-0 items-center gap-2 px-3 text-xs">
        <StatusIcon status={status} className="size-3.5" />
        <span aria-live="polite">
          {statusLabel(status)}{" "}
          <span className="text-muted-foreground tabular-nums">{count}</span>
        </span>
        <span className="ml-auto flex items-center text-muted-foreground">
          <Button
            variant="ghost"
            size="xs"
            disabled={!prev}
            aria-label={t("cards.prevColumn")}
            onClick={() => go(index - 1)}
          >
            <CaretLeftIcon aria-hidden="true" />
            {prev ? statusLabel(prev) : null}
          </Button>
          <span aria-hidden="true">·</span>
          <Button
            variant="ghost"
            size="xs"
            disabled={!next}
            aria-label={t("cards.nextColumn")}
            onClick={() => go(index + 1)}
          >
            {next ? statusLabel(next) : null}
            <CaretRightIcon aria-hidden="true" />
          </Button>
        </span>
      </div>
      <div
        ref={trackRef}
        data-swipe
        onScroll={(e) => {
          const el = e.currentTarget;
          if (el.clientWidth > 0)
            setIndex(Math.round(el.scrollLeft / el.clientWidth));
        }}
        className="flex min-h-0 flex-1 snap-x snap-mandatory overflow-x-auto overscroll-x-contain"
      >
        {columns.map((s) => (
          <div
            key={s}
            className="flex w-full shrink-0 snap-start flex-col px-3"
          >
            <Column
              status={s}
              tasks={tasks}
              all={all}
              folded={false}
              hideHead
              className="h-full border-t-0"
            />
          </div>
        ))}
      </div>
    </div>
  );
}

export function BoardView({
  tasks,
  all,
  phone,
}: {
  tasks: readonly Task[];
  all: readonly Task[];
  phone: boolean;
}) {
  return phone ? (
    <PhoneBoard tasks={tasks} all={all} />
  ) : (
    <WideBoard tasks={tasks} all={all} />
  );
}
