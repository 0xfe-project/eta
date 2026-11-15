import type { Task } from "@/queries/tasks";
import {
  ancestorsOfTask,
  childrenOf,
  descendantsOfTask,
  edgeRefusal,
  hasCycle,
  planOf,
} from "./task-plan";

// What the one picker of tasks offers, for a dependency (what the task waits for) or a parent
// (what it belongs to): found by title or number, the tasks of the same piece of work first, those
// that cannot be picked greyed with why, and those of another project marked. The rules are the
// host's (`apps/eta/src/tasks/graph.ts`); this only reads them off the list first, so the user
// sees why before choosing, and the host still decides.

/** The id a task being made has here, before the host gives it one. */
export const NEW_TASK = "__new__";

/**
 * The task the picker is for: one that exists, or one being made (`id` absent), with what it is
 * being given in the form so far (its parent, what it waits for).
 */
export interface PickSubject {
  id?: string | undefined;
  parentId: string | null;
  /** What it waits for, as chosen so far (a new task's; an existing one has its own edges). */
  dependsOn?: readonly string[];
}

export type PickMode = "dependsOn" | "parent";

/** Why a task cannot be picked: it waits for this one (a cycle), or it is this one's line. */
export type PickRefusal = "cycle" | "tree" | "cancelled" | "self";

export interface PickOption {
  task: Task;
  /** In the same piece of work as the subject (the same top task). */
  same: boolean;
  refusal?: PickRefusal | undefined;
  /** In another project than the subject's: it may be picked, but no branch is taken from it. */
  otherProject: boolean;
}

/** The top of the tree a task is in (itself when it has no parent). */
function rootOf(id: string | null, all: readonly Task[]): string | null {
  if (id === null) return null;
  const task = all.find((t) => t.id === id);
  if (task === undefined) return id;
  return ancestorsOfTask(task, all).at(-1)?.id ?? task.id;
}

/**
 * The board with the subject in it as the form has it: a task being made is added, and an existing
 * one gets the parent and edges the form gives it.
 */
export function withSubject(
  subject: PickSubject,
  all: readonly Task[],
): Task[] {
  const id = subject.id ?? NEW_TASK;
  const byId = new Map(all.map((t) => [t.id, t]));
  const edges = (subject.dependsOn ?? []).flatMap((dep) => {
    const other = byId.get(dep);
    return other === undefined
      ? []
      : [
          {
            taskId: other.id,
            number: other.number,
            title: other.title,
            status: other.status,
            requireDone: false,
            state: "waiting" as const,
          },
        ];
  });
  const existing = byId.get(id);
  if (existing !== undefined)
    return all.map((t) =>
      t.id === id
        ? {
            ...t,
            parentId: subject.parentId,
            dependsOn: subject.dependsOn === undefined ? t.dependsOn : edges,
          }
        : t,
    );
  const made: Task = {
    id,
    number: 0,
    title: "",
    status: "todo",
    createdBy: { kind: "user", agentId: null },
    assigneeAgentId: null,
    conversationId: null,
    runStatus: null,
    dependsOn: edges,
    waitingOn: [],
    parentId: subject.parentId,
    subtasks: null,
    comments: 0,
    createdAt: 0,
    updatedAt: 0,
  };
  return [...all, made];
}

/** Whether putting the subject under `parentId` would make the board wait in a circle. */
function parentRefusal(
  subject: PickSubject,
  parentId: string,
  all: readonly Task[],
): PickRefusal | undefined {
  const board = withSubject({ ...subject, parentId }, all);
  return hasCycle(board) ? "cycle" : undefined;
}

/**
 * The options, in the order the picker lists them: the same piece of work first, then the rest;
 * within each, what may be picked before what may not. A parent is never the subject or under it,
 * nor a cancelled task; a dependency is never the subject.
 */
export function pickOptions(input: {
  mode: PickMode;
  subject: PickSubject;
  all: readonly Task[];
  /** What the user typed: words of the title, or a number (`12`, `#12`). */
  query?: string;
  /** A task's project (from its conversation); undefined when the page cannot tell. */
  projectOf: (task: Task) => string | undefined;
  /** The subject's project. */
  projectId: string | undefined;
}): PickOption[] {
  const { mode, subject, all, projectOf, projectId } = input;
  const id = subject.id ?? NEW_TASK;
  const board = withSubject(subject, all);
  const q = (input.query ?? "").trim().toLowerCase();
  const number = /^#?(\d+)$/.exec(q)?.[1];
  const below = new Set(
    subject.id === undefined
      ? []
      : descendantsOfTask(subject.id, all).map((t) => t.id),
  );
  const home = rootOf(subject.id === undefined ? subject.parentId : id, board);
  const options = all
    .filter((task) => task.id !== id)
    .filter((task) =>
      mode === "parent"
        ? !below.has(task.id) && task.status !== "cancelled"
        : true,
    )
    .filter(
      (task) =>
        q === "" ||
        task.title.toLowerCase().includes(q) ||
        (number !== undefined && String(task.number) === number),
    )
    .map((task): PickOption => {
      const refusal =
        mode === "parent"
          ? parentRefusal(subject, task.id, all)
          : (edgeRefusal(id, task.id, board) ?? undefined);
      const theirs = projectOf(task);
      return {
        task,
        same: home !== null && rootOf(task.id, all) === home,
        refusal,
        otherProject:
          projectId !== undefined &&
          theirs !== undefined &&
          theirs !== projectId,
      };
    });
  const rank = (o: PickOption) =>
    (o.same ? 0 : 2) + (o.refusal === undefined ? 0 : 1);
  return options.sort((a, b) => rank(a) - rank(b));
}

/**
 * The step a task would sit at among its parent's subtasks, waiting for `dependsOn`: what the form
 * says before it is made ("will be step 3"). Undefined without a parent.
 */
export function stepIfMade(
  subject: PickSubject,
  all: readonly Task[],
): number | undefined {
  if (subject.parentId === null) return undefined;
  const board = withSubject(subject, all);
  const id = subject.id ?? NEW_TASK;
  const siblings = childrenOf(subject.parentId, board).filter(
    (t) => t.status !== "cancelled",
  );
  return planOf(siblings).stepOf.get(id);
}
