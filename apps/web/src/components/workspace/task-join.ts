import type { TaskWorkspaceMode } from "@eta/client-contracts";
import type { SplitLine } from "./task-split";
import type { Task, TaskDetail } from "@/queries/tasks";

// Where a join starts. In a worktree project the host starts a task's worktree at the branch of
// the one task it waits for (`TaskGraph.derivedBase`); a task that waits for two or more has no
// such branch and starts at the project's current HEAD, so the work of the parallel step before
// it is not in its worktree. These rules only say when to tell the user so; they change neither
// the scheduling nor the base.

/** Two or more prerequisites: a join. */
const joins = (count: number) => count >= 2;

/**
 * The task's worktree, not made yet, will start at the project's HEAD although it waits for a
 * parallel step: it is a worktree task with no base of its own and two or more prerequisites.
 */
export function joinStartsAtHead(task: TaskDetail): boolean {
  return (
    task.subtasks == null &&
    task.status !== "done" &&
    task.status !== "cancelled" &&
    task.workspace.mode === "worktree" &&
    task.workspace.base === null &&
    task.workspace.path === null &&
    joins(task.dependsOn?.length ?? 0)
  );
}

/**
 * Where the form's new task will work, as far as the page can tell: its parent's mode (the host
 * gives a subtask its parent's), else that of the newest task in the same project (the host
 * chooses by whether the project is a git repository, which a project's tasks already show).
 * Undefined when nothing says.
 */
export function newTaskMode(
  parent: Task | undefined,
  projectId: string | undefined,
  all: readonly Task[],
  projectOf: (task: Task) => string | undefined,
): TaskWorkspaceMode | undefined {
  if (parent !== undefined) return parent.workspaceMode;
  if (projectId === undefined) return undefined;
  let newest: Task | undefined;
  for (const task of all)
    if (
      task.workspaceMode !== undefined &&
      projectOf(task) === projectId &&
      (newest === undefined || task.createdAt > newest.createdAt)
    )
      newest = task;
  return newest?.workspaceMode;
}

/** The form's one new task, waiting for `prerequisites` tasks, will start at HEAD. */
export const newTaskStartsAtHead = (
  mode: TaskWorkspaceMode | undefined,
  prerequisites: number,
): boolean => mode === "worktree" && joins(prerequisites);

/**
 * The steps of a split that wait for a parallel step, and so start at HEAD in a worktree project:
 * each by its number, from 1, in order.
 */
export function splitJoinSteps(
  mode: TaskWorkspaceMode | undefined,
  lines: readonly SplitLine[],
): number[] {
  if (mode !== "worktree") return [];
  const steps = new Set<number>();
  for (const line of lines) if (joins(line.after.length)) steps.add(line.step);
  return [...steps].sort((a, b) => a - b);
}
