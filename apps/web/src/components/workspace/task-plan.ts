import type { TaskWaitView } from "@eta/client-contracts";
import type { Task, TaskStatus } from "@/queries/tasks";

// The board's graph as the page reads it: the steps a set of tasks falls into, the longest chain
// through them, whether a new edge would close a cycle, a parent's progress, and what a task waits
// for. All of it from the list the host sends (`dependsOn`, `waitingOn`, `parentId`), nothing
// stored: the host's own rules are in `apps/eta/src/tasks/graph.ts`, and this follows them.

/** Who executes a task: the agent it was assigned to, else the agent that made it. */
export const executorOf = (task: Task): string | null =>
  task.assigneeAgentId ?? task.createdBy.agentId;

/** A task's subtasks in the list, in the list's order. */
export const childrenOf = (id: string, all: readonly Task[]): Task[] =>
  all.filter((t) => t.parentId === id);

/** Its parent, the parent's parent and so on, nearest first. */
function ancestorsOf(task: Task, all: readonly Task[]): Task[] {
  const byId = new Map(all.map((t) => [t.id, t]));
  const out: Task[] = [];
  const seen = new Set([task.id]);
  let at = task.parentId ?? null;
  while (at !== null && !seen.has(at)) {
    const up = byId.get(at);
    if (up === undefined) break;
    out.push(up);
    seen.add(at);
    at = up.parentId ?? null;
  }
  return out;
}

/** Every task under it, at any depth. */
function descendantsOf(id: string, all: readonly Task[]): Task[] {
  const out: Task[] = [];
  const seen = new Set([id]);
  const walk = (at: string) => {
    for (const child of childrenOf(at, all)) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      out.push(child);
      walk(child.id);
    }
  };
  walk(id);
  return out;
}

// --- steps ---------------------------------------------------------------------------

/** One edge inside a plan: `to` waits for `from`. */
export interface PlanEdge {
  from: string;
  to: string;
  requireDone: boolean;
}

export interface Plan {
  /** The steps in order, each with its tasks by number. */
  steps: Task[][];
  /** Each task's step, from 1. */
  stepOf: Map<string, number>;
  /** The edges between the plan's own tasks. */
  edges: PlanEdge[];
  /** The longest chain of waiting, first to last; empty when nothing waits for anything. */
  critical: string[];
}

const finished = (status: TaskStatus) =>
  status === "done" || status === "in_review" || status === "cancelled";

/**
 * Lay a set of tasks out in steps: a task with nothing to wait for in the set is step 1, any other
 * comes one step after the latest of what it waits for, so the tasks of one step can run side by
 * side. Edges to tasks outside the set do not count. The critical path is the longest chain of
 * edges; where two chains are as long, the one still holding the work up (not delivered yet) wins,
 * then the lower number.
 */
export function planOf(tasks: readonly Task[]): Plan {
  const here = new Map(tasks.map((t) => [t.id, t]));
  const edges: PlanEdge[] = [];
  const before = new Map<string, Task[]>();
  for (const task of tasks) {
    const list: Task[] = [];
    for (const edge of task.dependsOn ?? []) {
      const from = here.get(edge.taskId);
      if (from === undefined || from.id === task.id) continue;
      edges.push({ from: from.id, to: task.id, requireDone: edge.requireDone });
      list.push(from);
    }
    before.set(task.id, list);
  }
  // Longest chain ending at each task, counted in tasks, and the task before it on that chain.
  const length = new Map<string, number>();
  const previous = new Map<string, Task | undefined>();
  const visiting = new Set<string>();
  const rank = (a: Task, b: Task) =>
    Number(finished(a.status)) - Number(finished(b.status)) ||
    a.number - b.number;
  const measure = (task: Task): number => {
    const known = length.get(task.id);
    if (known !== undefined) return known;
    // A cycle the host would never have let in: cut it here rather than loop.
    if (visiting.has(task.id)) return 0;
    visiting.add(task.id);
    let best = 0;
    let via: Task | undefined;
    for (const from of [...(before.get(task.id) ?? [])].sort(rank)) {
      const n = measure(from);
      if (n > best) {
        best = n;
        via = from;
      }
    }
    visiting.delete(task.id);
    length.set(task.id, best + 1);
    previous.set(task.id, via);
    return best + 1;
  };
  for (const task of tasks) measure(task);
  const stepOf = new Map(tasks.map((t) => [t.id, length.get(t.id) ?? 1]));
  const count = Math.max(0, ...stepOf.values());
  const steps: Task[][] = Array.from({ length: count }, () => []);
  for (const task of tasks) steps[stepOf.get(task.id)! - 1]!.push(task);
  for (const step of steps) step.sort((a, b) => a.number - b.number);
  let critical: string[] = [];
  if (count > 1) {
    const end = [...steps[count - 1]!].sort(rank)[0]!;
    for (let at: Task | undefined = end; at; at = previous.get(at.id))
      critical.unshift(at.id);
  }
  if (critical.length < 2) critical = [];
  return { steps, stepOf, edges, critical };
}

/** "N steps to go": the steps not all done yet. */
export const stepsLeft = (plan: Plan) =>
  plan.steps.filter((step) => step.some((x) => x.status !== "done")).length;

/** Whether an edge is on the critical path: its two ends follow each other on it. */
export const onCritical = (plan: Plan, edge: PlanEdge) => {
  const i = plan.critical.indexOf(edge.from);
  return i !== -1 && plan.critical[i + 1] === edge.to;
};

/** The step a subtask sits at among its parent's subtasks; undefined for a task with no parent. */
export function stepAmongSiblings(
  task: Task,
  all: readonly Task[],
): number | undefined {
  if (task.parentId == null) return undefined;
  return planOf(childrenOf(task.parentId, all)).stepOf.get(task.id);
}

// --- cycles --------------------------------------------------------------------------

/**
 * Why `taskId` may not wait for `dependsOnId`, or undefined when it may: itself, a cancelled
 * task, its own parent or subtask, or a cycle. Counted as the host counts it: a task waits for
 * what its parents wait for, and waiting for a parent is waiting for all of its subtasks.
 */
export function edgeRefusal(
  taskId: string,
  dependsOnId: string,
  all: readonly Task[],
): "self" | "cancelled" | "tree" | "cycle" | undefined {
  if (taskId === dependsOnId) return "self";
  const byId = new Map(all.map((t) => [t.id, t]));
  const task = byId.get(taskId);
  const target = byId.get(dependsOnId);
  if (task === undefined || target === undefined) return undefined;
  if ((task.dependsOn ?? []).some((e) => e.taskId === dependsOnId))
    return undefined;
  if (target.status === "cancelled") return "cancelled";
  if (
    ancestorsOf(task, all).some((t) => t.id === dependsOnId) ||
    descendantsOf(taskId, all).some((t) => t.id === dependsOnId)
  )
    return "tree";
  const withEdge = all.map((t) =>
    t.id === taskId
      ? {
          ...t,
          dependsOn: [
            ...(t.dependsOn ?? []),
            {
              taskId: dependsOnId,
              number: target.number,
              title: target.title,
              status: target.status,
              requireDone: false,
              state: "waiting" as const,
            },
          ],
        }
      : t,
  );
  if (hasCycle(withEdge)) return "cycle";
  return undefined;
}

/**
 * Whether the board waits in a circle, counted as the host counts it: a task waits for what its
 * parents wait for, and waiting for a parent is waiting for all of its subtasks.
 */
export function hasCycle(all: readonly Task[]): boolean {
  const byId = new Map(all.map((t) => [t.id, t]));
  const hasChildren = (id: string) => all.some((t) => t.parentId === id);
  // What a task really waits for: the leaves under each task its line waits for.
  const waitsFor = (id: string): string[] => {
    const at = byId.get(id);
    if (at === undefined) return [];
    const held = new Set<string>();
    for (const owner of [at, ...ancestorsOf(at, all)])
      for (const dep of owner.dependsOn ?? []) held.add(dep.taskId);
    const out = new Set<string>();
    for (const dep of held) {
      const leaves = descendantsOf(dep, all).filter((t) => !hasChildren(t.id));
      if (leaves.length === 0) out.add(dep);
      else for (const leaf of leaves) out.add(leaf.id);
    }
    return [...out];
  };
  const done = new Set<string>();
  const path = new Set<string>();
  const walk = (id: string): boolean => {
    if (path.has(id)) return true;
    if (done.has(id)) return false;
    path.add(id);
    for (const next of waitsFor(id)) if (walk(next)) return true;
    path.delete(id);
    done.add(id);
    return false;
  };
  return all.some((t) => walk(t.id));
}

/** Every task under it, at any depth (exported for the picker). */
export const descendantsOfTask = (id: string, all: readonly Task[]) =>
  descendantsOf(id, all);

/** Its parent, the parent's parent and so on, nearest first (exported for the picker). */
export const ancestorsOfTask = (task: Task, all: readonly Task[]) =>
  ancestorsOf(task, all);

// --- a parent's progress ------------------------------------------------------------

/** What one subtask is, for a parent's bar and counts. */
export type Segment =
  | "done"
  | "in_review"
  | "in_progress"
  | "blocked"
  | "waiting"
  | "todo"
  | "backlog";

/** The bar's order: what is finished first, then what is going, then what waits. */
const segmentOrder: Segment[] = [
  "done",
  "in_review",
  "in_progress",
  "blocked",
  "waiting",
  "todo",
  "backlog",
];

/**
 * What a task's work still waits for, its parents' edges included. A host older than subtasks
 * sends no `waitingOn`: then it is the task's own edges that are not resolved.
 */
export const waitsOf = (task: Task): TaskWaitView[] =>
  task.waitingOn ??
  (task.dependsOn ?? [])
    .filter((edge) => edge.state !== "resolved")
    .map(({ taskId, number, title, status, state }) => ({
      taskId,
      number,
      title,
      status,
      state: state as TaskWaitView["state"],
      via: null,
    }));

/** Whether a task's run is going (it may be starting, or queued behind a machine). */
export const isRunning = (task: Task) =>
  task.status === "in_progress" &&
  (task.runStatus === "running" || task.runStatus === "starting");

/** Whether a task's work waits for others: not started, and something it waits for is not there yet. */
export const isWaiting = (task: Task) =>
  (task.status === "todo" || task.status === "backlog") &&
  waitsOf(task).some((w) => w.state === "waiting") &&
  !waitsOf(task).some((w) => w.state === "cancelled");

const segmentOf = (task: Task): Segment => {
  if (isWaiting(task)) return "waiting";
  if (task.status === "cancelled") return "backlog";
  return task.status;
};

export interface Progress {
  /** One per subtask that is not cancelled, finished ones first. */
  segments: { task: Task; segment: Segment }[];
  /** How many of each, only those with any, in the bar's order. */
  counts: { segment: Segment; count: number }[];
  done: number;
  total: number;
  /** What is being worked on now, and what comes after. */
  now: Task | undefined;
  next: Task | undefined;
}

/**
 * A parent's progress from its subtasks, cancelled ones left out (as `subtasks.total` leaves them
 * out): a segment for each, how many are in each state, and the one going now and the one next.
 */
export function progressOf(parent: Task, all: readonly Task[]): Progress {
  const live = childrenOf(parent.id, all).filter(
    (t) => t.status !== "cancelled",
  );
  const plan = planOf(live);
  const byStep = (a: Task, b: Task) =>
    plan.stepOf.get(a.id)! - plan.stepOf.get(b.id)! || a.number - b.number;
  const segments = live
    .map((task) => ({ task, segment: segmentOf(task) }))
    .sort(
      (a, b) =>
        segmentOrder.indexOf(a.segment) - segmentOrder.indexOf(b.segment) ||
        byStep(a.task, b.task),
    );
  const counts = segmentOrder
    .map((segment) => ({
      segment,
      count: segments.filter((s) => s.segment === segment).length,
    }))
    .filter((c) => c.count > 0);
  const ordered = [...live].sort(byStep);
  const now =
    ordered.find((t) => t.status === "in_progress") ??
    ordered.find((t) => t.status === "blocked");
  const next = ordered.find(
    (t) => t !== now && (t.status === "todo" || t.status === "backlog"),
  );
  return {
    segments,
    counts,
    done: live.filter((t) => t.status === "done").length,
    total: live.length,
    now,
    next,
  };
}

// --- what a task waits for, and what waits for it ----------------------------------

/** What a waiting card says: one task by its title, or how many it waits for and how many are left. */
export type WaitSummary =
  | { kind: "one"; title: string; requireDone: boolean }
  | { kind: "many"; total: number; left: number };

export function waitSummary(
  task: Task,
  all: readonly Task[],
): WaitSummary | undefined {
  if (!isWaiting(task)) return undefined;
  const waiting = waitsOf(task).filter((w) => w.state === "waiting");
  if (waiting.length === 1) {
    const only = waiting[0]!;
    // The edge is the task's own, or a parent's (`via`): read `requireDone` from whichever has it.
    const owner =
      only.via === null
        ? task
        : (all.find((t) => t.number === only.via) ?? task);
    const edge = (owner.dependsOn ?? []).find((e) => e.taskId === only.taskId);
    return {
      kind: "one",
      title: only.title,
      requireDone: edge?.requireDone ?? false,
    };
  }
  const own = (task.dependsOn ?? []).length;
  const inherited = waitsOf(task).filter((w) => w.via !== null).length;
  return {
    kind: "many",
    total: Math.max(own + inherited, waiting.length),
    left: waiting.length,
  };
}

/**
 * What a task does for the tasks that wait for it: how many it will let go once delivered, and
 * how many it has let go already.
 */
export function releaseOf(task: Task, all: readonly Task[]) {
  let waiting = 0;
  let released = 0;
  for (const other of all)
    for (const edge of other.dependsOn ?? [])
      if (edge.taskId === task.id) {
        if (edge.state === "resolved") released += 1;
        else if (edge.state === "waiting") waiting += 1;
      }
  return { waiting, released };
}

/** Why a blocked task is stuck: the title of what it waited for and was cancelled, if one. */
export function blockedReason(task: Task, all: readonly Task[]) {
  const cancelled = waitsOf(task).filter((w) => w.state === "cancelled");
  if (cancelled.length === 1)
    return { kind: "cancelled" as const, title: cancelled[0]!.title };
  if (cancelled.length > 1)
    return { kind: "cancelledMany" as const, count: cancelled.length };
  const live = childrenOf(task.id, all);
  if (live.length > 0 && live.every((t) => t.status === "cancelled"))
    return { kind: "allCancelled" as const };
  return { kind: "decide" as const };
}

// --- filters -------------------------------------------------------------------------

export interface TaskFilter {
  /** Words in the title, or a number (`12`, `#12`). */
  q: string;
  /** An executor's agent id, or `me` for tasks with no agent. */
  who: string | null;
  /** A parent: the task itself and everything under it. */
  under: string | null;
}

export function filterTasks(
  tasks: readonly Task[],
  filter: TaskFilter,
): Task[] {
  const q = filter.q.trim().toLowerCase();
  const number = /^#?(\d+)$/.exec(q)?.[1];
  const inside =
    filter.under === null
      ? undefined
      : new Set([
          filter.under,
          ...descendantsOf(filter.under, tasks).map((t) => t.id),
        ]);
  return tasks.filter(
    (task) =>
      (q === "" ||
        task.title.toLowerCase().includes(q) ||
        (number !== undefined && String(task.number) === number)) &&
      (filter.who === null || (executorOf(task) ?? "me") === filter.who) &&
      (inside === undefined || inside.has(task.id)),
  );
}
