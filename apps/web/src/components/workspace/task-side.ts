import type { Task } from "@/queries/tasks";
import { childrenOf, isWaiting } from "./task-plan";

// How the side panel sorts a conversation's tasks: what needs the user first (stuck, then waiting
// for review), then what is going, then what waits for other tasks; the rest after, by status.
// And the context tab's short list: the pieces of work, with the subtasks going on under them.

export interface SideGroups {
  needYou: Task[];
  going: Task[];
  waiting: Task[];
  /** Everything else, in the list's order (by status sections where it is shown). */
  rest: Task[];
}

const newest = (a: Task, b: Task) => b.updatedAt - a.updatedAt;

/** Whether a task waits for others, or for a machine, before it starts. */
const waitsToStart = (task: Task) =>
  isWaiting(task) || (task.status === "todo" && task.runStatus === "queued");

export function sideGroups(tasks: readonly Task[]): SideGroups {
  const needYou = tasks
    .filter((t) => t.status === "blocked" || t.status === "in_review")
    .sort(
      (a, b) =>
        Number(a.status !== "blocked") - Number(b.status !== "blocked") ||
        newest(a, b),
    );
  const going = tasks.filter((t) => t.status === "in_progress").sort(newest);
  const waiting = tasks.filter(waitsToStart).sort(newest);
  const taken = new Set([...needYou, ...going, ...waiting].map((t) => t.id));
  return {
    needYou,
    going,
    waiting,
    rest: tasks.filter((t) => !taken.has(t.id)),
  };
}

/** A row of the context tab's list: a task, and how deep it sits under a piece of work. */
export interface ContextRow {
  task: Task;
  depth: 0 | 1;
}

const going = new Set(["in_progress", "in_review", "blocked"]);

/**
 * The context tab's tasks: the open ones that are not under another open one, each piece of work
 * followed by its subtasks that are going on now (running, in review, stuck), indented. The rest of
 * its subtasks are its bar.
 */
export function contextRows(
  open: readonly Task[],
  all: readonly Task[],
): ContextRow[] {
  const ids = new Set(open.map((t) => t.id));
  const rows: ContextRow[] = [];
  for (const task of open) {
    if (task.parentId != null && ids.has(task.parentId)) continue;
    rows.push({ task, depth: 0 });
    if (task.subtasks == null) continue;
    for (const child of childrenOf(task.id, all))
      if (going.has(child.status)) rows.push({ task: child, depth: 1 });
  }
  return rows;
}
