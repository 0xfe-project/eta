import type {
  BoardTaskStatus,
  TaskDependencyState,
  TaskWorkspaceMode,
} from "@eta/client-contracts";
/**
 * The task graph: which task waits for which, and what follows from it.
 *
 * Every rule about dependencies is here and nowhere else: what an edge may be, when it is
 * resolved, whether a task may start, whether a new edge closes a cycle, and which branch a task
 * that builds on another starts from. It is pure: it is handed the tasks and the edges as they are
 * (`TaskBoard` reads them) and answers, so the board, the runner, the tools and Captain all ask the
 * same questions of the same answers instead of each checking for themselves.
 *
 * - **An edge** says a task does not start before another is resolved. A task can wait for many,
 *   and many can wait for one.
 * - **Resolved** is the other task in review or done; an edge with `requireDone` takes done only.
 * - **Broken** is an edge whose task was cancelled: it will never resolve on its own, so the task
 *   that waits for it needs the user (remove the edge, or cancel the task).
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
}

/** One edge: `taskId` waits for `dependsOnId`. */
export interface GraphEdge {
  taskId: string;
  dependsOnId: string;
  requireDone: boolean;
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

/** A task as a reader names it: `#12 "Title"`. */
export const nameOf = (task: Pick<GraphTask, "number" | "title">): string =>
  `#${task.number} "${task.title}"`;

/** The branch a task's worktree is made on. */
const branchOf = (task: Pick<GraphTask, "number">): string =>
  `eta/task-${task.number}`;

export class TaskGraph {
  readonly #tasks: Map<string, GraphTask>;
  /** Edges by the task that waits, in the order they were made. */
  readonly #out = new Map<string, GraphEdge[]>();
  /** Edges by the task waited for. */
  readonly #in = new Map<string, GraphEdge[]>();

  constructor(tasks: Iterable<GraphTask>, edges: Iterable<GraphEdge>) {
    this.#tasks = new Map([...tasks].map((task) => [task.id, task]));
    for (const edge of edges) {
      // An edge to a task this graph was not given is not one it can answer for.
      if (!this.#tasks.has(edge.taskId) || !this.#tasks.has(edge.dependsOnId))
        continue;
      push(this.#out, edge.taskId, edge);
      push(this.#in, edge.dependsOnId, edge);
    }
  }

  task(id: string): GraphTask | undefined {
    return this.#tasks.get(id);
  }

  /** What the task waits for. */
  dependenciesOf(id: string): GraphEdge[] {
    return this.#out.get(id) ?? [];
  }

  /** What waits for the task. */
  dependentsOf(id: string): GraphEdge[] {
    return this.#in.get(id) ?? [];
  }

  /** Where one edge stands. */
  stateOf(edge: GraphEdge): TaskDependencyState {
    const target = this.#tasks.get(edge.dependsOnId)!;
    if (target.status === "cancelled") return "cancelled";
    if (target.status === "done") return "resolved";
    if (target.status === "in_review" && !edge.requireDone) return "resolved";
    return "waiting";
  }

  /** Whether the task's work may start. */
  gate(id: string): Gate {
    const waitingOn: GraphTask[] = [];
    const cancelled: GraphTask[] = [];
    for (const edge of this.dependenciesOf(id)) {
      const state = this.stateOf(edge);
      const target = this.#tasks.get(edge.dependsOnId)!;
      if (state === "waiting") waitingOn.push(target);
      else if (state === "cancelled") cancelled.push(target);
    }
    if (cancelled.length > 0) return { state: "broken", cancelled, waitingOn };
    if (waitingOn.length > 0) return { state: "waiting", waitingOn };
    return { state: "resolved" };
  }

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
    const cycle = this.#pathFrom(dependsOnId, taskId);
    if (cycle !== undefined)
      throw new Error(
        `${nameOf(task)} cannot wait for ${nameOf(target)}: that would close a cycle, ${[
          task,
          ...cycle,
        ]
          .map((t) => `#${t.number}`)
          .join(" → ")}`,
      );
  }

  /**
   * The branch the task's worktree starts at when nobody named one, from what it waits for: only
   * one dependency, in the same project, a worktree of its own. Asked when the worktree is made,
   * not when the task is, because by then the other task may be done and its branch merged away.
   */
  derivedBase(id: string): DerivedBase {
    const task = this.#tasks.get(id);
    const edges = this.dependenciesOf(id);
    if (task === undefined || edges.length !== 1) return { kind: "none" };
    const target = this.#tasks.get(edges[0]!.dependsOnId)!;
    if (
      target.projectId === null ||
      target.projectId !== task.projectId ||
      target.workspaceMode !== "worktree"
    )
      return { kind: "none" };
    return target.status === "done"
      ? { kind: "head", task: target }
      : { kind: "branch", task: target, branch: branchOf(target) };
  }

  /** A path of waits from `from` to `to`, the tasks after `from` included, if there is one. */
  #pathFrom(from: string, to: string): GraphTask[] | undefined {
    const seen = new Set<string>();
    const walk = (id: string): string[] | undefined => {
      if (id === to) return [id];
      if (seen.has(id)) return undefined;
      seen.add(id);
      for (const edge of this.dependenciesOf(id)) {
        const rest = walk(edge.dependsOnId);
        if (rest !== undefined) return [id, ...rest];
      }
      return undefined;
    };
    return walk(from)?.map((id) => this.#tasks.get(id)!);
  }
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list === undefined) map.set(key, [value]);
  else list.push(value);
}
