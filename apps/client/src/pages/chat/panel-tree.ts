import type { BoardTaskView } from "@eta/client-contracts";
import { signal } from "nsh";
import { foldNext } from "../../components/motion";
import { subtasksOf } from "../tasks/status";

/**
 * The parents opened in the Context and Tasks tabs, shared by both and kept for as long as the
 * app runs: a parent starts folded, its subtasks under it. A parent shown only because one of its
 * subtasks is listed starts open (see `taskRoots`), until it is folded by hand.
 */
const chosen = signal<Record<string, boolean>>({});

export function parentOpen(id: string, revealed = false): boolean {
  return chosen()[id] ?? revealed;
}

export function setParentOpen(id: string, open: boolean): void {
  foldNext();
  chosen.set({ ...chosen(), [id]: open });
}

/**
 * The rows a list starts from: each listed task's topmost parent (an archived parent stops the
 * climb), once. A subtask is never a row of its own while its parent is on the board; it goes
 * where its parent goes. `revealed` holds the parents shown only because a subtask of theirs is
 * listed, not they themselves: those open, so the subtask that matched is in sight.
 */
export function taskRoots(listed: BoardTaskView[], all: BoardTaskView[]) {
  const byId = new Map(all.map((task) => [task.id, task]));
  const ids = new Set(listed.map((task) => task.id));
  const parentOf = (task: BoardTaskView) => {
    const parent = task.parentId ? byId.get(task.parentId) : undefined;
    return parent && !parent.archivedAt ? parent : undefined;
  };
  const roots = new Map<string, BoardTaskView>();
  const revealed = new Set<string>();
  for (const task of listed) {
    let top = task;
    for (let parent = parentOf(top); parent; parent = parentOf(top)) {
      if (!ids.has(parent.id)) revealed.add(parent.id);
      top = parent;
    }
    roots.set(top.id, top);
  }
  return { roots: [...roots.values()], revealed };
}

/** Every task under `task`, at any depth, cancelled ones left out like the parent's count. */
function descendants(task: BoardTaskView, all: BoardTaskView[]) {
  const found: BoardTaskView[] = [];
  const visit = (parent: BoardTaskView) => {
    for (const child of subtasksOf(all, parent)) {
      found.push(child);
      visit(child);
    }
  };
  visit(task);
  return found;
}

/** When anything in the task's tree last changed: a parent moves when any subtask does. */
export function latestChange(task: BoardTaskView, all: BoardTaskView[]) {
  return Math.max(
    task.updatedAt,
    ...descendants(task, all).map((child) => child.updatedAt),
  );
}

/**
 * How many subtasks under a parent wait on you (in review or blocked), counting only ones that do
 * work themselves: a subtask that is a parent too has its status from these.
 */
export function needingYou(task: BoardTaskView, all: BoardTaskView[]) {
  return descendants(task, all).filter(
    (child) =>
      !child.subtasks?.total &&
      (child.status === "in_review" || child.status === "blocked"),
  ).length;
}

/** A row of a folded list: a task, how deep it is, whether it has subtasks and shows them. */
export interface TreeRow {
  task: BoardTaskView;
  depth: number;
  parent: boolean;
  open: boolean;
}

/** `roots` with the subtasks of each open parent under it, at every depth. */
export function treeRows(
  roots: BoardTaskView[],
  revealed: Set<string>,
  all: BoardTaskView[],
): TreeRow[] {
  const rows: TreeRow[] = [];
  const visit = (task: BoardTaskView, depth: number) => {
    const children = subtasksOf(all, task);
    const open =
      children.length > 0 && parentOpen(task.id, revealed.has(task.id));
    rows.push({ task, depth, parent: children.length > 0, open });
    if (open) for (const child of children) visit(child, depth + 1);
  };
  for (const task of roots) visit(task, 0);
  return rows;
}
