import type { PlanEdge } from "./task-plan";
import type { Task } from "@/queries/tasks";
import { LockSimpleIcon } from "@phosphor-icons/react/LockSimple";
import { PlusIcon } from "@phosphor-icons/react/Plus";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useOutbox } from "@/queries/outbox";
import {
  useAddDependency,
  useRemoveDependency,
  useTask,
} from "@/queries/tasks";
import { wireErrorMessage } from "@/queries/wire";
import { TaskLine } from "./task-bits";
import { numbersLabel } from "./task-format";
import { useTaskNav } from "./task-nav";
import {
  childrenOf,
  edgeRefusal,
  isWaiting,
  onCritical,
  planOf,
  stepsLeft,
} from "./task-plan";
import { StatusIcon } from "./task-status-icon";
import { waitingStripes } from "./task-words";
import { useOpenGroup } from "./use-groups";
import { useWorkspaceStore } from "./workspace-store";

// The plan: a piece of work's tasks in the order they can happen. The steps come from the edges
// (`planOf`), so the tasks of one step can run side by side; the longest chain is drawn heavier.
// On a wide page an edge is made by dragging from a task's right edge onto another (it then waits
// for the first), and one is changed or removed from its own menu; the host checks every change
// again. On a phone the steps are stacked and the edges are not drawn or made.

const showError = (error: Error) => toast.error(wireErrorMessage(error));

/** Where each node is, relative to the plan's own box. */
interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** A drag from a node's handle: where it started, where the pointer is, and what it is over. */
interface Drag {
  from: string;
  x: number;
  y: number;
  over: string | undefined;
  refusal: string | undefined;
  moved: boolean;
  /** What it is over waits for where it started already: letting go changes nothing. */
  existing: boolean;
}

/** What a step's head says beside its name: all done, waiting for the step before, side by side. */
function stepNote(
  step: Task[],
  index: number,
  t: (k: string, o?: object) => string,
) {
  const done = step.filter((x) => x.status === "done").length;
  if (done === step.length)
    return t("plan.stepDone", { done, total: step.length });
  if (step.some(isWaiting)) return t("plan.waitsFor", { count: index });
  if (step.length > 1) return t("plan.parallel");
  if (done > 0) return t("plan.stepDone", { done, total: step.length });
  return "";
}

/**
 * "+ Add a step at the end": a new subtask of the parent, waiting for every task of the last step.
 * Tasks are drafted by agents, so this asks for one in the parent's conversation: the composer
 * there is filled in with what to draft, for the user to finish and send.
 */
function AddStep({
  parent,
  last,
  className,
}: {
  parent: Task;
  last: readonly Task[];
  className?: string;
}) {
  const { t } = useTranslation(["tasks"] as const);
  const { task: detail } = useTask(parent.id);
  const openGroup = useOpenGroup();
  const setNewConversation = useWorkspaceStore((s) => s.setNewConversation);
  const ask = () => {
    // Nothing to wait for when the plan is empty (all of it cancelled, or never split).
    const text =
      last.length === 0
        ? t("plan.addStepDraftFirst", {
            number: parent.number,
            title: parent.title,
          })
        : t("plan.addStepDraft", {
            number: parent.number,
            title: parent.title,
            tasks: numbersLabel(last.map((x) => x.number)),
          });
    const conversation =
      parent.conversationId ?? detail?.originConversationId ?? null;
    if (conversation === null) {
      setNewConversation({ open: true });
      return;
    }
    const { drafts, setDraft } = useOutbox.getState();
    const draft = drafts[conversation] ?? [];
    setDraft(conversation, [
      ...draft,
      { type: "text", text: draft.length ? `\n${text}` : text },
    ]);
    openGroup(conversation);
  };
  return (
    <button
      type="button"
      onClick={ask}
      title={t("plan.addStepHint")}
      className={cn(
        "pointer-events-auto flex w-full items-center gap-1.5 border border-dashed border-border-strong px-2.5 py-2 text-left text-xs text-muted-foreground outline-none hover:border-foreground/40 hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring",
        className,
      )}
    >
      <PlusIcon aria-hidden="true" className="size-3.5" />
      {t("plan.addStep")}
    </button>
  );
}

function Node({
  task,
  all,
  critical,
  register,
  connecting,
  onHandleDown,
  onPick,
  phone,
  over,
  refused,
}: {
  task: Task;
  all: readonly Task[];
  critical: boolean;
  register?: (id: string, el: HTMLElement | null) => void;
  connecting?: boolean;
  onHandleDown?: (e: React.PointerEvent, id: string) => void;
  onPick?: (id: string) => boolean;
  phone: boolean;
  over?: boolean;
  refused?: boolean;
}) {
  const { t } = useTranslation(["tasks"] as const);
  const [, setNav] = useTaskNav();
  return (
    <div
      ref={(el) => register?.(task.id, el)}
      data-plan-node={task.id}
      data-task={task.number}
      data-critical={critical || undefined}
      className={cn(
        "group pointer-events-auto relative border bg-card px-2.5 py-2 text-xs",
        critical && "border-[1.5px] border-foreground",
        isWaiting(task) && waitingStripes,
        over && !refused && "outline-2 outline-foreground",
        over && refused && "outline-2 outline-state-error",
      )}
    >
      <button
        type="button"
        onClick={() => {
          if (onPick?.(task.id)) return;
          void setNav({ task: task.id });
        }}
        className={cn(
          "flex w-full min-w-0 items-center gap-1.5 text-left text-[0.8125rem] outline-none after:absolute after:inset-0 after:content-[''] focus-visible:after:ring-1 focus-visible:after:ring-ring",
          connecting && "cursor-crosshair",
        )}
      >
        <StatusIcon status={task.status} className="size-3.5" />
        <span className="min-w-0 truncate">{task.title}</span>
      </button>
      <span className="mt-0.5 flex min-w-0 items-center gap-1 pl-5 text-muted-foreground tabular-nums">
        <span className="shrink-0">#{task.number} ·</span>
        <TaskLine task={task} all={all} />
      </span>
      {phone || !onHandleDown ? null : (
        <button
          type="button"
          aria-label={t("plan.connectFrom", { number: task.number })}
          title={t("plan.connect")}
          data-handle={task.id}
          onPointerDown={(e) => onHandleDown(e, task.id)}
          className="absolute top-1/2 -right-[7px] z-10 size-3 -translate-y-1/2 cursor-crosshair touch-none rounded-full border border-foreground/50 bg-card opacity-0 outline-none group-hover:opacity-100 hover:bg-foreground focus-visible:opacity-100 focus-visible:ring-1 focus-visible:ring-ring"
        />
      )}
    </div>
  );
}

/** The menu of an edge, at its middle: remove it, or switch between delivered and done. */
function EdgeMenu({
  edge,
  at,
  all,
  onLeave,
  onEnter,
  ref,
}: {
  ref: React.Ref<HTMLDivElement>;
  edge: PlanEdge;
  at: { x: number; y: number };
  all: readonly Task[];
  onLeave: () => void;
  onEnter: () => void;
}) {
  const { t } = useTranslation(["tasks"] as const);
  const add = useAddDependency();
  const remove = useRemoveDependency();
  const from = all.find((x) => x.id === edge.from);
  const to = all.find((x) => x.id === edge.to);
  return (
    <div
      role="group"
      aria-label={t("plan.edge", { from: from?.number, to: to?.number })}
      ref={ref}
      onPointerEnter={onEnter}
      onPointerLeave={onLeave}
      onFocus={onEnter}
      onBlur={onLeave}
      style={{ left: at.x, top: at.y }}
      className="absolute z-20 flex -translate-x-1/2 -translate-y-1/2 gap-px border bg-popover p-0.5 shadow-md"
    >
      <Button
        variant="ghost"
        size="xs"
        disabled={add.isPending}
        onClick={() =>
          add.mutate(
            {
              taskId: edge.to,
              dependsOn: edge.from,
              requireDone: !edge.requireDone,
            },
            { onError: showError },
          )
        }
      >
        {t(edge.requireDone ? "plan.requireAny" : "plan.requireDone")}
      </Button>
      <Button
        variant="ghost"
        size="xs"
        className="text-destructive"
        disabled={remove.isPending}
        onClick={() => {
          onLeave();
          remove.mutate(
            { taskId: edge.to, dependsOn: edge.from },
            { onError: showError },
          );
        }}
      >
        {t("plan.removeEdge")}
      </Button>
    </div>
  );
}

const curve = (x1: number, y1: number, x2: number, y2: number) => {
  const m = (x1 + x2) / 2;
  return `M${x1} ${y1}C${m} ${y1} ${m} ${y2} ${x2 - 5} ${y2}`;
};

const arrow = (x: number, y: number) =>
  `M${x - 6} ${y - 3.5}L${x} ${y}L${x - 6} ${y + 3.5}z`;

/** The plan of one set of tasks laid out in steps, wide: lanes side by side with the edges drawn. */
function WidePlan({
  tasks,
  all,
  parent,
}: {
  tasks: readonly Task[];
  all: readonly Task[];
  parent: Task | undefined;
}) {
  const { t } = useTranslation(["tasks"] as const);
  const add = useAddDependency();
  const plan = planOf(tasks);
  const critical = new Set(plan.critical);
  const boxRef = useRef<HTMLDivElement>(null);
  const nodesRef = useRef(new Map<string, HTMLElement>());
  const [boxes, setBoxes] = useState<Map<string, Box>>(() => new Map());
  const [drag, setDrag] = useState<Drag | undefined>();
  const [connectFrom, setConnectFrom] = useState<string | undefined>();
  const [hovered, setHovered] = useState<string | undefined>();
  const menuRef = useRef<HTMLDivElement>(null);
  const leaveTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const register = useCallback((id: string, el: HTMLElement | null) => {
    if (el) nodesRef.current.set(id, el);
    else nodesRef.current.delete(id);
  }, []);
  const measure = useCallback(() => {
    const root = boxRef.current?.getBoundingClientRect();
    if (!root) return;
    const next = new Map<string, Box>();
    for (const [id, el] of nodesRef.current) {
      const r = el.getBoundingClientRect();
      next.set(id, {
        left: r.left - root.left,
        top: r.top - root.top,
        right: r.right - root.left,
        bottom: r.bottom - root.top,
      });
    }
    setBoxes(next);
  }, []);
  const layoutKey =
    tasks.map((x) => `${x.id}:${x.status}:${x.title}`).join("|") +
    plan.edges.map((e) => `${e.from}>${e.to}`).join("|");
  useLayoutEffect(measure, [measure, layoutKey]);
  useEffect(() => {
    const el = boxRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [measure]);
  useEffect(() => {
    if (connectFrom === undefined) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setConnectFrom(undefined);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [connectFrom]);

  const refusalOf = (to: string, from: string) => edgeRefusal(to, from, all);
  /** Whether `to` waits for `from` already: then there is nothing to make. */
  const waitsAlready = (to: string, from: string) =>
    (all.find((x) => x.id === to)?.dependsOn ?? []).some(
      (e) => e.taskId === from,
    );
  const connect = (from: string, to: string) => {
    // The host would take the edge again as an upsert and reset it to "delivered is enough";
    // changing how an edge lets go is its menu's job, not a drag's.
    if (waitsAlready(to, from)) return true;
    if (refusalOf(to, from) !== undefined) return false;
    add.mutate({ taskId: to, dependsOn: from }, { onError: showError });
    return true;
  };

  const point = (e: { clientX: number; clientY: number }) => {
    const root = boxRef.current?.getBoundingClientRect();
    return {
      x: e.clientX - (root?.left ?? 0),
      y: e.clientY - (root?.top ?? 0),
    };
  };
  const nodeAt = (e: { clientX: number; clientY: number }, from: string) => {
    const hit = document.elementFromPoint?.(e.clientX, e.clientY);
    const id = hit?.closest<HTMLElement>("[data-plan-node]")?.dataset.planNode;
    return id === undefined || id === from || !nodesRef.current.has(id)
      ? undefined
      : id;
  };
  const onHandleDown = (e: React.PointerEvent, from: string) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const start = { ...point(e), clientX: e.clientX, clientY: e.clientY };
    setConnectFrom(undefined);
    setDrag({
      from,
      x: start.x,
      y: start.y,
      over: undefined,
      refusal: undefined,
      moved: false,
      existing: false,
    });
    const move = (ev: PointerEvent) => {
      const over = nodeAt(ev, from);
      const moved =
        Math.abs(ev.clientX - start.clientX) +
          Math.abs(ev.clientY - start.clientY) >
        3;
      setDrag(
        (d) =>
          d && {
            ...d,
            ...point(ev),
            over,
            existing: over !== undefined && waitsAlready(over, from),
            refusal:
              over === undefined || waitsAlready(over, from)
                ? undefined
                : refusalOf(over, from),
            moved: d.moved || moved,
          },
      );
    };
    // One signal takes all three listeners off, whichever ends the drag.
    const listening = new AbortController();
    const up = (ev: PointerEvent) => {
      listening.abort();
      const over = nodeAt(ev, from);
      const moved =
        Math.abs(ev.clientX - start.clientX) +
          Math.abs(ev.clientY - start.clientY) >
        3;
      setDrag(undefined);
      if (over !== undefined) connect(from, over);
      // A press without a drag starts connecting by clicks: the next task picked waits for this one.
      else if (!moved) setConnectFrom(from);
    };
    const cancel = () => {
      listening.abort();
      setDrag(undefined);
    };
    const options = { signal: listening.signal };
    window.addEventListener("pointermove", move, options);
    window.addEventListener("pointerup", up, options);
    window.addEventListener("pointercancel", cancel, options);
  };
  const onPick = (id: string) => {
    if (connectFrom === undefined) return false;
    if (id !== connectFrom && waitsAlready(id, connectFrom))
      toast(
        t("plan.exists", {
          from: all.find((x) => x.id === connectFrom)?.number,
          to: all.find((x) => x.id === id)?.number,
        }),
      );
    else if (id !== connectFrom) {
      const refusal = refusalOf(id, connectFrom);
      if (refusal !== undefined) {
        toast.error(t(`cards.refusal.${refusal}`));
        return true;
      }
      connect(connectFrom, id);
    }
    setConnectFrom(undefined);
    return true;
  };

  const edgeKey = (e: PlanEdge) => `${e.from}>${e.to}`;
  const ends = (e: PlanEdge) => {
    const a = boxes.get(e.from);
    const b = boxes.get(e.to);
    if (!a || !b) return undefined;
    return {
      x1: a.right,
      y1: (a.top + a.bottom) / 2,
      x2: b.left,
      y2: (b.top + b.bottom) / 2,
    };
  };
  const hoveredEdge = plan.edges.find((e) => edgeKey(e) === hovered);
  const hoveredEnds = hoveredEdge && ends(hoveredEdge);
  const enter = (key: string) => {
    clearTimeout(leaveTimerRef.current);
    setHovered(key);
  };
  const leave = () => {
    clearTimeout(leaveTimerRef.current);
    leaveTimerRef.current = setTimeout(setHovered, 150, undefined);
  };
  const dragFrom = drag && boxes.get(drag.from);
  const dragTo = drag?.over === undefined ? undefined : boxes.get(drag.over);
  const last = plan.steps.at(-1) ?? [];

  return (
    <div className="overflow-x-auto">
      <div ref={boxRef} className="relative min-w-max p-3.5">
        <svg
          aria-hidden={false}
          role="presentation"
          className="pointer-events-none absolute inset-0 size-full overflow-visible"
        >
          {plan.edges.map((edge) => {
            const p = ends(edge);
            const heavy = onCritical(plan, edge);
            const key = edgeKey(edge);
            const lit = hovered === key;
            return (
              <g
                key={key}
                data-edge={key}
                data-critical={heavy || undefined}
                data-require-done={edge.requireDone || undefined}
                tabIndex={0}
                role="button"
                aria-label={t("plan.edgeLabel", {
                  from: all.find((x) => x.id === edge.from)?.number,
                  to: all.find((x) => x.id === edge.to)?.number,
                })}
                onFocus={() => enter(key)}
                onBlur={leave}
                onKeyDown={(e) => {
                  if (e.key !== "Enter" && e.key !== " ") return;
                  e.preventDefault();
                  enter(key);
                  // Into the menu, which the keyboard can then tab through.
                  requestAnimationFrame(() =>
                    menuRef.current?.querySelector("button")?.focus(),
                  );
                }}
                onPointerEnter={() => enter(key)}
                onPointerLeave={leave}
                className={cn(
                  "pointer-events-auto outline-none",
                  heavy ? "text-foreground" : "text-border-strong",
                  lit && "text-foreground",
                )}
              >
                <title>
                  {t(
                    edge.requireDone ? "plan.waitsDone" : "plan.waitsDelivered",
                  )}
                </title>
                {p ? (
                  <>
                    <path
                      d={curve(p.x1, p.y1, p.x2, p.y2)}
                      fill="none"
                      stroke="transparent"
                      strokeWidth={12}
                    />
                    <path
                      d={curve(p.x1, p.y1, p.x2, p.y2)}
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={heavy ? 1.7 : 1.2}
                    />
                    <path d={arrow(p.x2, p.y2)} fill="currentColor" />
                  </>
                ) : null}
              </g>
            );
          })}
          {drag && dragFrom && drag.moved ? (
            <path
              data-drag-line
              data-refused={drag.refusal !== undefined || undefined}
              d={curve(
                dragFrom.right,
                (dragFrom.top + dragFrom.bottom) / 2,
                dragTo ? dragTo.left : drag.x + 5,
                dragTo ? (dragTo.top + dragTo.bottom) / 2 : drag.y,
              )}
              fill="none"
              stroke="currentColor"
              strokeWidth={1.7}
              strokeDasharray={drag.over === undefined ? "4 3" : undefined}
              className={
                drag.refusal !== undefined
                  ? "text-state-error-ink"
                  : "text-foreground"
              }
            />
          ) : null}
        </svg>
        {hoveredEdge && hoveredEnds ? (
          <EdgeMenu
            ref={menuRef}
            edge={hoveredEdge}
            all={all}
            at={{
              x: (hoveredEnds.x1 + hoveredEnds.x2) / 2,
              y: (hoveredEnds.y1 + hoveredEnds.y2) / 2,
            }}
            onEnter={() => enter(edgeKey(hoveredEdge))}
            onLeave={leave}
          />
        ) : null}
        <ol className="pointer-events-none relative z-10 grid auto-cols-[minmax(13rem,16rem)] grid-flow-col gap-10">
          {plan.steps.map((step, i) => (
            <li
              key={step[0]!.id}
              aria-label={t("cards.step", { count: i + 1 })}
            >
              <h3 className="mb-2 flex justify-between gap-2 text-xs font-normal text-muted-foreground">
                <span className="text-foreground">
                  {t("cards.step", { count: i + 1 })}
                </span>
                <span>{stepNote(step, i, t)}</span>
              </h3>
              <div className="space-y-2.5">
                {step.map((task) => (
                  <Node
                    key={task.id}
                    task={task}
                    all={all}
                    critical={critical.has(task.id)}
                    register={register}
                    connecting={connectFrom !== undefined}
                    onHandleDown={onHandleDown}
                    onPick={onPick}
                    phone={false}
                    over={drag?.over === task.id}
                    refused={
                      drag?.over === task.id && drag.refusal !== undefined
                    }
                  />
                ))}
                {parent && i === plan.steps.length - 1 ? (
                  <AddStep parent={parent} last={last} />
                ) : null}
              </div>
            </li>
          ))}
        </ol>
        {drag?.refusal !== undefined ||
        drag?.existing ||
        connectFrom !== undefined ? (
          <p
            role="status"
            className={cn(
              "mt-3 text-xs",
              drag?.refusal ? "text-state-error-ink" : "text-muted-foreground",
            )}
          >
            {drag?.refusal
              ? t("plan.cycle")
              : drag?.existing
                ? t("plan.exists", {
                    from: all.find((x) => x.id === drag.from)?.number,
                    to: all.find((x) => x.id === drag.over)?.number,
                  })
                : t("plan.connectHint", {
                    number: all.find((x) => x.id === connectFrom)?.number,
                  })}
          </p>
        ) : null}
      </div>
    </div>
  );
}

/** The plan on a phone: the steps stacked, one group each; no edges to draw or make. */
function PhonePlan({
  tasks,
  all,
  parent,
}: {
  tasks: readonly Task[];
  all: readonly Task[];
  parent: Task | undefined;
}) {
  const { t } = useTranslation(["tasks"] as const);
  const plan = planOf(tasks);
  const critical = new Set(plan.critical);
  return (
    <ol className="space-y-3 p-3">
      {plan.steps.map((step, i) => {
        const note = stepNote(step, i, t);
        return (
          <li
            key={step[0]!.id}
            aria-label={t("cards.step", { count: i + 1 })}
            className="space-y-1.5"
          >
            <h3 className="text-xs font-normal text-muted-foreground">
              {t("cards.step", { count: i + 1 })}
              {note ? ` · ${note}` : ""}
            </h3>
            {step.map((task) => (
              <Node
                key={task.id}
                task={task}
                all={all}
                critical={critical.has(task.id)}
                phone
              />
            ))}
            {parent && i === plan.steps.length - 1 ? (
              <AddStep parent={parent} last={step} />
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

/** One piece of work's plan, with its head when it has a parent. */
export function PlanGroup({
  parent,
  tasks,
  all,
  phone,
  head = true,
}: {
  parent: Task | undefined;
  tasks: readonly Task[];
  all: readonly Task[];
  phone: boolean;
  head?: boolean;
}) {
  const { t } = useTranslation(["tasks"] as const);
  const [, setNav] = useTaskNav();
  const plan = planOf(tasks);
  const left = stepsLeft(plan);
  return (
    <section
      aria-label={parent ? parent.title : t("list.loose")}
      data-plan={parent?.number ?? "loose"}
      className="border bg-sidebar/60"
    >
      {head ? (
        <header className="flex items-center gap-2 border-b bg-background px-3.5 py-2 text-xs">
          {parent ? (
            <>
              <StatusIcon status={parent.status} className="size-3.5" />
              <button
                type="button"
                onClick={() => void setNav({ task: parent.id })}
                className="min-w-0 truncate text-sm outline-none hover:underline focus-visible:underline"
              >
                {parent.title}
              </button>
              <span className="shrink-0 text-muted-foreground tabular-nums">
                {`#${parent.number} · `}
                {left === 0
                  ? t("plan.allDone")
                  : t("plan.left", { count: left })}
              </span>
            </>
          ) : (
            <span className="text-muted-foreground">{t("list.loose")}</span>
          )}
        </header>
      ) : null}
      {tasks.length === 0 ? (
        <div className="p-3.5">
          <p className="mb-2 text-xs text-muted-foreground">
            {t("plan.empty")}
          </p>
          {parent ? (
            <AddStep parent={parent} last={[]} className="max-w-64" />
          ) : null}
        </div>
      ) : phone ? (
        <PhonePlan tasks={tasks} all={all} parent={parent} />
      ) : (
        <WidePlan tasks={tasks} all={all} parent={parent} />
      )}
      {phone || tasks.length === 0 ? null : (
        <div className="flex flex-wrap gap-x-3.5 gap-y-1 px-3.5 pb-3 text-xs text-muted-foreground">
          {(["done", "in_review", "in_progress"] as const).map((status) => (
            <span key={status} className="inline-flex items-center gap-1.5">
              <StatusIcon status={status} className="size-3.5" />
              {t(
                `plan.legend.${status === "in_review" ? "inReview" : status === "in_progress" ? "inProgress" : "done"}`,
              )}
            </span>
          ))}
          <span className="inline-flex items-center gap-1.5">
            <LockSimpleIcon aria-hidden="true" className="size-3.5" />
            {t("plan.legend.waiting")}
          </span>
          <span className="inline-flex items-center gap-1.5">
            <i className="inline-block w-4 border-t-[1.6px] border-foreground" />
            {t("plan.critical")}
          </span>
          <span>{t("plan.connect")}</span>
        </div>
      )}
    </section>
  );
}

/**
 * The whole page as plans: one for each piece of work that shows (a parent that matches, or has a
 * subtask that does), then one for the tasks that belong to none, laid out by their own edges.
 * Cancelled tasks are dropped work and are not part of a plan.
 */
export function PlanView({
  tasks,
  all,
  phone,
}: {
  tasks: readonly Task[];
  all: readonly Task[];
  phone: boolean;
}) {
  const shown = new Set(tasks.map((x) => x.id));
  const live = (x: Task) => x.status !== "cancelled";
  const groups = all
    .filter((parent) => childrenOf(parent.id, all).length > 0)
    .map((parent) => {
      const children = childrenOf(parent.id, all).filter(live);
      const matching = children.filter((x) => shown.has(x.id));
      // The piece of work itself matched: all of it shows.
      const nodes =
        shown.has(parent.id) && matching.length === 0 ? children : matching;
      return {
        parent,
        nodes,
        show: shown.has(parent.id) || matching.length > 0,
      };
    })
    .filter((g) => g.show);
  const loose = tasks.filter(
    (task) =>
      live(task) &&
      task.parentId == null &&
      childrenOf(task.id, all).length === 0,
  );
  return (
    <div className="h-full space-y-4 overflow-y-auto px-4 py-4 sm:px-6">
      {groups.map(({ parent, nodes }) => (
        <PlanGroup
          key={parent.id}
          parent={parent}
          tasks={nodes}
          all={all}
          phone={phone}
        />
      ))}
      {loose.length > 0 ? (
        <PlanGroup parent={undefined} tasks={loose} all={all} phone={phone} />
      ) : null}
    </div>
  );
}
