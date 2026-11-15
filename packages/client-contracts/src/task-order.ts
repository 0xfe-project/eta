/**
 * The one rule every task list shares on top of its own: within one status, a task whose run is
 * going comes before a task whose run waits in the queue, however recently the waiting one moved.
 *
 * A list keeps whatever order it already has — grouped by status, newest first, oldest first,
 * waiting tasks before the rest — and `runningFirst` only reorders tasks of the same status among
 * the places they already hold. Places that held an `in_review` task still hold one afterwards, so
 * the order between statuses is the list's own and never changes; inside a status the running
 * tasks take its first places, the queued ones the next, the rest the last, each in the order the
 * list had them. Web, mobile and the TUI all import it from here.
 */
import type { BoardTaskStatus, TaskRunStatus } from "./tasks";

/** What the rule reads of a task. */
export interface TaskRunFacts {
  status: BoardTaskStatus;
  runStatus: TaskRunStatus | null;
}

/** 0 while the newest run starts or runs, 1 while it is queued, 2 otherwise (none, or over). */
export function taskRunRank(runStatus: TaskRunStatus | null): 0 | 1 | 2 {
  if (runStatus === "running" || runStatus === "starting") return 0;
  if (runStatus === "queued") return 1;
  return 2;
}

/** Running before queued before the rest; 0 between two of one rank, for the list to decide. */
export function compareTaskRuns(a: TaskRunFacts, b: TaskRunFacts): number {
  return taskRunRank(a.runStatus) - taskRunRank(b.runStatus);
}

/**
 * The list, already in its own order, with running tasks before queued ones in every status (see
 * the top of this file). `taskOf` reads the task out of an item, or returns undefined for an item
 * that is not one (a question in a mixed list), which keeps its place.
 */
export function runningFirst<T extends TaskRunFacts>(items: readonly T[]): T[];
export function runningFirst<T>(
  items: readonly T[],
  taskOf: (item: T) => TaskRunFacts | undefined,
): T[];
export function runningFirst<T>(
  items: readonly T[],
  taskOf: (item: T) => TaskRunFacts | undefined = (item) =>
    item as unknown as TaskRunFacts,
): T[] {
  const places = new Map<BoardTaskStatus, number[]>();
  items.forEach((item, index) => {
    const task = taskOf(item);
    if (task === undefined) return;
    const held = places.get(task.status);
    if (held === undefined) places.set(task.status, [index]);
    else held.push(index);
  });
  const ordered = [...items];
  for (const held of places.values()) {
    // `sort` is stable: one rank keeps the list's order.
    const tasks = held
      .map((index) => items[index] as T)
      .sort((a, b) =>
        compareTaskRuns(taskOf(a) as TaskRunFacts, taskOf(b) as TaskRunFacts),
      );
    held.forEach((index, k) => {
      ordered[index] = tasks[k] as T;
    });
  }
  return ordered;
}
