import type {
  BoardTaskStatus,
  TaskDependencyState,
  TaskWorkspaceMode,
} from "@eta/client-contracts";
import { reviewedOrDone } from "./status";
/**
 * The task graph: which task waits for which, which task is part of which, and what follows.
 *
 * Every rule about dependencies and subtasks is here and nowhere else: what an edge may be, when
 * it is resolved, whether a task may start, whether a change closes a cycle, what status a parent
 * takes from its subtasks, and which branch a task that builds on another starts from. It is pure:
 * it is handed the tasks and the edges as they are (`TaskBoard` reads them) and answers, so the
 * board, the runner, the tools and Captain all ask the same questions of the same answers instead
 * of each checking for themselves.
 *
 * - **An edge** says a task does not start before another is resolved. A task can wait for many,
 *   and many can wait for one.
 * - **Resolved** is the other task in review or done; an edge with `requireDone` takes done only.
 *   A parent's status is its subtasks' (`derive`), so waiting for a parent is waiting for all of
 *   its subtasks, the ones added later too.
 * - **Broken** is an edge whose task was cancelled: it will never resolve on its own, so the task
 *   that waits for it needs the user (remove the edge, or cancel the task).
 * - **A subtask inherits** what its parents wait for: a stage that waits for another holds all of
 *   its work back. A task with subtasks does not run itself.
 * - **No cycles**, counted the way the work really waits: a task waits for the subtasks of a parent
 *   it waits for, and for what its own parents wait for. So a subtask cannot wait for its own
 *   parent, and a parent cannot wait for its own subtask.
 * - Only the work's own start waits (a task's first run, a rerun); what the board does with the
 *   answer is the board's and the runner's.
 */

/** What the graph needs of a task. */
export interface GraphTask {
  id: string;
  number: number;
  title: string;
  status: BoardTaskStatus;
  projectId: string | null;
  workspaceMode: TaskWorkspaceMode;
  /** The task it is a subtask of. */
  parentId: string | null;
}

/** One edge: `taskId` waits for `dependsOnId`. */
export interface GraphEdge {
  taskId: string;
  dependsOnId: string;
  requireDone: boolean;
}

/** An edge a task waits on, with the task whose edge it is (itself, or a parent of it). */
export interface HeldEdge extends GraphEdge {
  /** Whether the edge is a parent's, which the task waits on as part of it. */
  inherited: boolean;
}

/** Whether a task's work may start, as far as what it waits for goes. */
export type Gate =
  | { state: "resolved" }
  /** Some of what it waits for is not resolved yet: these, oldest edge first. */
  | { state: "waiting"; waitingOn: GraphTask[] }
  /** Something it waits for was cancelled and never resolves: the user decides. */
  | { state: "broken"; cancelled: GraphTask[]; waitingOn: GraphTask[] };

/** Where a task's worktree starts when nobody said, as its dependencies decide it. */
export type DerivedBase =
  /** Nothing to derive from: the project checkout's HEAD, as always. */
  | { kind: "none" }
  /** The one task it builds on is not done: its branch, which must exist. */
  | { kind: "branch"; task: GraphTask; branch: string }
  /** The one task it builds on is done, and its branch usually merged and gone: HEAD. */
  | { kind: "head"; task: GraphTask };

/** A parent's status as its subtasks make it, and why, for the timeline. */
export interface Derived {
  status: BoardTaskStatus;
  /** `all_cancelled` when there is no subtask left to work on, which is the user's to decide. */
  reason: "subtasks" | "all_cancelled";
}

/** A task as a reader names it: `#12 "Title"`. */
export const nameOf = (task: Pick<GraphTask, "number" | "title">): string =>
  `#${task.number} "${task.title}"`;

/** The branch a task's worktree is made on. */
const branchOf = (task: Pick<GraphTask, "number">): string =>
  `eta/task-${task.number}`;

/** Why a cycle through the tree is one: said whenever subtasks are part of the question. */
const TREE_HINT =
  " (a subtask waits for what its parents wait for, and waiting for a parent is waiting for its subtasks)";

/**
 * A parent's status from its subtasks that are not cancelled, the first rule that holds: all done,
 * all past review, someone working, someone stuck, part done (the stage is under way), something
 * to do, else nothing started. One rule to a line, so changing one does not mean rereading all.
 */
const DERIVATION: readonly [
  (live: readonly BoardTaskStatus[]) => boolean,
  BoardTaskStatus,
][] = [
  [(live) => live.every((s) => s === "done"), "done"],
  [(live) => live.every(reviewedOrDone), "in_review"],
  [(live) => live.includes("in_progress"), "in_progress"],
  [(live) => live.includes("blocked"), "blocked"],
  [(live) => live.some(reviewedOrDone), "in_progress"],
  [(live) => live.includes("todo"), "todo"],
  [() => true, "backlog"],
];

export class TaskGraph {
  readonly #tasks: Map<string, GraphTask>;
  readonly #edges: GraphEdge[] = [];
  /** Edges by the task that waits, in the order they were made. */
  readonly #out = new Map<string, GraphEdge[]>();
  /** Edges by the task waited for. */
  readonly #in = new Map<string, GraphEdge[]>();
  /** Subtasks by parent, oldest first (the order the tasks were given in, by number). */
  readonly #children = new Map<string, GraphTask[]>();

  constructor(tasks: Iterable<GraphTask>, edges: Iterable<GraphEdge>) {
    const all = [...tasks].sort((a, b) => a.number - b.number);
    this.#tasks = new Map(all.map((task) => [task.id, task]));
    for (const task of all)
      if (task.parentId !== null && this.#tasks.has(task.parentId))
        push(this.#children, task.parentId, task);
    for (const edge of edges) {
      // An edge to a task this graph was not given is not one it can answer for.
      if (!this.#tasks.has(edge.taskId) || !this.#tasks.has(edge.dependsOnId))
        continue;
      this.#edges.push(edge);
      push(this.#out, edge.taskId, edge);
      push(this.#in, edge.dependsOnId, edge);
    }
  }

  task(id: string): GraphTask | undefined {
    return this.#tasks.get(id);
  }

  /* ---------------------------------------------------------------- the tree */

  /** The task's own subtasks, oldest first. */
  childrenOf(id: string): GraphTask[] {
    return this.#children.get(id) ?? [];
  }

  /** Whether the task is a parent: it takes its status from its subtasks and does not run. */
  hasChildren(id: string): boolean {
    return this.childrenOf(id).length > 0;
  }

  /** Its parent, its parent's parent, and so on up. */
  ancestorsOf(id: string): GraphTask[] {
    const out: GraphTask[] = [];
    const seen = new Set<string>([id]);
    let parent = this.#tasks.get(id)?.parentId ?? null;
    while (parent !== null && !seen.has(parent)) {
      const task = this.#tasks.get(parent);
      if (task === undefined) break;
      out.push(task);
      seen.add(parent);
      parent = task.parentId;
    }
    return out;
  }

  /** Every task under it, at any depth. */
  descendantsOf(id: string): GraphTask[] {
    const out: GraphTask[] = [];
    const walk = (at: string): void => {
      for (const child of this.childrenOf(at)) {
        out.push(child);
        walk(child.id);
      }
    };
    walk(id);
    return out;
  }

  /**
   * The status a parent takes from its subtasks, or undefined for a task that has none. Cancelled
   * subtasks are dropped work and do not count; with none left, the parent is blocked for the user
   * to decide (it is not cancelled itself, which would cancel what waits for it in turn).
   */
  derive(id: string): Derived | undefined {
    const children = this.childrenOf(id);
    if (children.length === 0) return undefined;
    const live: BoardTaskStatus[] = children
      .map((child) => child.status)
      .filter((status) => status !== "cancelled");
    if (live.length === 0)
      return { status: "blocked", reason: "all_cancelled" };
    const status = DERIVATION.find(([holds]) => holds(live))![1];
    return { status, reason: "subtasks" };
  }

  /* ---------------------------------------------------------------- the edges */

  /** What the task itself waits for. */
  dependenciesOf(id: string): GraphEdge[] {
    return this.#out.get(id) ?? [];
  }

  /** What waits for the task itself. */
  dependentsOf(id: string): GraphEdge[] {
    return this.#in.get(id) ?? [];
  }

  /** What the task waits on: its own edges and its parents', each target once, its own first. */
  heldBy(id: string): HeldEdge[] {
    const out: HeldEdge[] = [];
    const seen = new Set<string>();
    for (const [owner, inherited] of [
      [id, false] as const,
      ...this.ancestorsOf(id).map((a) => [a.id, true] as const),
    ])
      for (const edge of this.dependenciesOf(owner)) {
        if (seen.has(edge.dependsOnId)) continue;
        seen.add(edge.dependsOnId);
        out.push({ ...edge, inherited });
      }
    return out;
  }

  /** Where one edge stands. A parent's status is its subtasks', so it answers for them. */
  stateOf(edge: GraphEdge): TaskDependencyState {
    const target = this.#tasks.get(edge.dependsOnId)!;
    if (target.status === "cancelled") return "cancelled";
    if (target.status === "done") return "resolved";
    if (target.status === "in_review" && !edge.requireDone) return "resolved";
    return "waiting";
  }

  /** Whether the task's work may start: what it and its parents wait for, all resolved. */
  gate(id: string): Gate {
    const waitingOn: GraphTask[] = [];
    const cancelled: GraphTask[] = [];
    for (const edge of this.heldBy(id)) {
      const state = this.stateOf(edge);
      const target = this.#tasks.get(edge.dependsOnId)!;
      if (state === "waiting") waitingOn.push(target);
      else if (state === "cancelled") cancelled.push(target);
    }
    if (cancelled.length > 0) return { state: "broken", cancelled, waitingOn };
    if (waitingOn.length > 0) return { state: "waiting", waitingOn };
    return { state: "resolved" };
  }

  /* ---------------------------------------------------------------- changes the graph allows */

  /**
   * Refuse an edge that cannot be: to the task itself, to a task that is not there, to one that
   * was cancelled (it would be broken from the start), or one that closes a cycle — then the
   * message says which, as `#1 → #2 → #1`. An edge that is already there is not new: changing its
   * `requireDone` is always allowed.
   */
  checkEdge(taskId: string, dependsOnId: string): void {
    const task = this.#tasks.get(taskId);
    const target = this.#tasks.get(dependsOnId);
    if (task === undefined) throw new Error(`no such task: ${taskId}`);
    if (target === undefined) throw new Error(`no such task: ${dependsOnId}`);
    if (taskId === dependsOnId)
      throw new Error(`${nameOf(task)} cannot wait for itself`);
    if (this.dependenciesOf(taskId).some((e) => e.dependsOnId === dependsOnId))
      return;
    if (target.status === "cancelled")
      throw new Error(
        `${nameOf(target)} is cancelled, so ${nameOf(task)} cannot wait for it`,
      );
    // The two cycles the tree makes by itself, said plainly.
    if (this.ancestorsOf(taskId).some((t) => t.id === dependsOnId))
      throw new Error(
        `${nameOf(task)} cannot wait for ${nameOf(target)}: it is part of it, and waiting for a parent is waiting for all of its subtasks, itself included`,
      );
    if (this.descendantsOf(taskId).some((t) => t.id === dependsOnId))
      throw new Error(
        `${nameOf(task)} cannot wait for ${nameOf(target)}, its own subtask: a subtask waits for what its parents wait for, so it would wait for itself`,
      );
    const after = new TaskGraph(this.#tasks.values(), [
      ...this.#edges,
      { taskId, dependsOnId, requireDone: false },
    ]);
    const cycle = after.#cycle(taskId);
    if (cycle !== undefined)
      throw new Error(
        `${nameOf(task)} cannot wait for ${nameOf(target)}: that would close a cycle, ${cycle}${
          this.hasChildren(dependsOnId) ||
          this.hasChildren(taskId) ||
          task.parentId !== null ||
          target.parentId !== null
            ? TREE_HINT
            : ""
        }`,
      );
  }

  /**
   * Refuse a parent that cannot be: one that is not there, the task itself or one of its own
   * subtasks (a task cannot be its own ancestor), or one that closes a cycle of waiting, since a
   * subtask inherits what its new parent waits for and anything waiting for the parent now waits
   * for it.
   */
  checkParent(taskId: string, parentId: string): void {
    const task = this.#tasks.get(taskId);
    const parent = this.#tasks.get(parentId);
    if (task === undefined) throw new Error(`no such task: ${taskId}`);
    if (parent === undefined) throw new Error(`no such task: ${parentId}`);
    if (task.parentId === parentId) return;
    if (
      taskId === parentId ||
      this.descendantsOf(taskId).some((t) => t.id === parentId)
    )
      throw new Error(
        `${nameOf(parent)} cannot be the parent of ${nameOf(task)}: a task cannot be its own ancestor`,
      );
    const after = new TaskGraph(
      [...this.#tasks.values()].map((t) =>
        t.id === taskId ? { ...t, parentId } : t,
      ),
      this.#edges,
    );
    const cycle = after.#cycle(taskId);
    if (cycle !== undefined)
      throw new Error(
        `${nameOf(task)} cannot be a subtask of ${nameOf(parent)}: that would close a cycle, ${cycle}${TREE_HINT}`,
      );
  }

  /**
   * The branch the task's worktree starts at when nobody named one, from what it waits for: only
   * one dependency, in the same project, a worktree of its own, and no subtasks on either side (a
   * parent has no branch of its own work). Asked when the worktree is made, not when the task is,
   * because by then the other task may be done and its branch merged away.
   */
  derivedBase(id: string): DerivedBase {
    const task = this.#tasks.get(id);
    const edges = this.dependenciesOf(id);
    if (task === undefined || edges.length !== 1 || this.hasChildren(id))
      return { kind: "none" };
    const target = this.#tasks.get(edges[0]!.dependsOnId)!;
    if (
      target.projectId === null ||
      target.projectId !== task.projectId ||
      target.workspaceMode !== "worktree" ||
      this.hasChildren(target.id)
    )
      return { kind: "none" };
    return target.status === "done"
      ? { kind: "head", task: target }
      : { kind: "branch", task: target, branch: branchOf(target) };
  }

  /* ---------------------------------------------------------------- inside */

  /**
   * What a task really waits for: the tasks that do the work, which is the edge's task, or the
   * subtasks at the bottom of it when it has some.
   */
  #waitsFor(id: string): string[] {
    const out = new Set<string>();
    for (const edge of this.heldBy(id)) {
      const below = this.descendantsOf(edge.dependsOnId).filter(
        (t) => !this.hasChildren(t.id),
      );
      if (below.length === 0) out.add(edge.dependsOnId);
      else for (const leaf of below) out.add(leaf.id);
    }
    return [...out];
  }

  /** A cycle of waiting, as `#1 → #2 → #1`, if there is one anywhere; looked for from `from` first. */
  #cycle(from: string): string | undefined {
    const done = new Set<string>();
    const path: string[] = [];
    const onPath = new Set<string>();
    const walk = (id: string): string[] | undefined => {
      if (onPath.has(id)) return [...path.slice(path.indexOf(id)), id];
      if (done.has(id)) return undefined;
      path.push(id);
      onPath.add(id);
      for (const next of this.#waitsFor(id)) {
        const found = walk(next);
        if (found !== undefined) return found;
      }
      path.pop();
      onPath.delete(id);
      done.add(id);
      return undefined;
    };
    for (const id of [from, ...this.#tasks.keys()]) {
      const found = walk(id);
      if (found !== undefined)
        return found.map((at) => `#${this.#tasks.get(at)!.number}`).join(" → ");
    }
    return undefined;
  }
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list === undefined) map.set(key, [value]);
  else list.push(value);
}
