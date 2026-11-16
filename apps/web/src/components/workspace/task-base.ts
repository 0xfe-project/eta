import type { Task } from "@/queries/tasks";

// "Starts from" in the new-task form: where the new task's worktree starts. Left alone, the form
// sends no `base` and the host derives it when the run starts (`TaskGraph.derivedBase`): the branch
// of the one unfinished task it waits for, in the same project, else the project checkout's HEAD.
// The user can pick a prerequisite's branch instead (with two or more prerequisites, which one it
// goes on from), HEAD, or a branch or commit of their own.

/** What the user picked; `auto` is what the host derives. */
export type BaseChoice =
  | { kind: "auto" }
  | { kind: "task"; taskId: string }
  | { kind: "head" }
  | { kind: "custom"; value: string };

/** A choice the form offers, picked or derived: a prerequisite's branch, or HEAD. */
export type BaseTarget = { kind: "task"; task: Task } | { kind: "head" };

/** Its own `eta/task-<N>` branch, as the host names it. */
export const branchOf = (task: Pick<Task, "number">) =>
  `eta/task-${task.number}`;

/**
 * The prerequisites whose branch the new task could start from: in its project (when both are
 * known), in a worktree, not cancelled, and not a piece of work (one with subtasks has no branch of its own).
 */
export function baseCandidates(
  prerequisites: readonly Task[],
  all: readonly Task[],
  projectId: string | undefined,
  projectOf: (task: Task) => string | undefined,
): Task[] {
  return prerequisites.filter((task) => {
    const project = projectOf(task);
    if (
      project !== undefined &&
      projectId !== undefined &&
      project !== projectId
    )
      return false;
    // A task in the project's directory has no branch (a host older than the field says nothing).
    if (task.workspaceMode !== undefined && task.workspaceMode !== "worktree")
      return false;
    if (task.status === "cancelled") return false;
    if ((task.subtasks?.total ?? 0) > 0) return false;
    return !all.some((other) => other.parentId === task.id);
  });
}

/**
 * What the host would derive for a task waiting for `prerequisites`: the branch of the only one
 * when it is a candidate that is not done yet, else HEAD.
 */
export function derivedBase(
  prerequisites: readonly Task[],
  candidates: readonly Task[],
): BaseTarget {
  if (prerequisites.length !== 1) return { kind: "head" };
  const only = prerequisites[0]!;
  return candidates.includes(only) && only.status !== "done"
    ? { kind: "task", task: only }
    : { kind: "head" };
}

/** The choice as the form shows it: a pick that is no longer offered falls back to the derived one. */
export function shownBase(
  choice: BaseChoice,
  candidates: readonly Task[],
): BaseChoice {
  if (choice.kind === "task" && !candidates.some((t) => t.id === choice.taskId))
    return { kind: "auto" };
  return choice;
}

/**
 * What `tasks.create` is sent as each task's `base`: nothing for the derived one (or an empty
 * custom field), `#N` for a prerequisite's branch, the empty string for HEAD, the field as typed.
 */
export function baseArg(
  choice: BaseChoice,
  candidates: readonly Task[],
): string | undefined {
  const shown = shownBase(choice, candidates);
  switch (shown.kind) {
    case "auto":
      return undefined;
    case "head":
      return "";
    case "task": {
      const task = candidates.find((t) => t.id === shown.taskId)!;
      return `#${task.number}`;
    }
    case "custom": {
      const value = shown.value.trim();
      return value === "" ? undefined : value;
    }
  }
}
