import type {
  BoardTaskDetail,
  BoardTaskStatus,
  BoardTaskView,
  TaskActivityView,
  TaskArgs,
  TaskBoardSettings,
  TaskResults,
  TaskRunStatus,
  TaskRunView,
} from "@eta/client-contracts";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { getWire } from "@/lib/wire";
import { rememberRows } from "@/queries/conversations";
import {
  useListTarget,
  useTarget,
  useTargetMissing,
  useWireMutation,
} from "@/queries/wire";

// The task board on the wire: the `tasks` target (one eager `list` of every task) and one
// `tasks.<id>` target per task (its `task` and its `activity`). Nothing polls: a comment, an
// agent's status change or a published artifact arrives as state.

export type Task = BoardTaskView;
export type TaskStatus = BoardTaskStatus;
export type TaskActivity = TaskActivityView;
export type TaskRun = TaskRunView;
export type RunStatus = TaskRunStatus;
/** A task with its history, as its own page needs it. */
export type TaskDetail = BoardTaskDetail & { activity: TaskActivityView[] };

/**
 * The board: every task not archived, most recently moved first (the order the host keeps). What
 * shows tasks to work on reads this; what finds a task it was given (a card, a `#N`, a parent)
 * reads `useAllTasks`.
 */
export function useTasks() {
  const { items, loaded, error } = useListTarget<BoardTaskView>("tasks");
  return { tasks: items, loaded, error };
}

const NO_TASKS: readonly BoardTaskView[] = [];

/** The archived tasks, the one archived last first. Empty from a host that has none to say. */
export function useArchivedTasks() {
  const archived = useTarget("tasks")?.sections.archived as
    | readonly BoardTaskView[]
    | undefined;
  return archived ?? NO_TASKS;
}

/** Every task, archived or not: for finding a task by id or number, and for what counts them all. */
export function useAllTasks() {
  const { tasks, loaded, error } = useTasks();
  const archived = useArchivedTasks();
  const all = useMemo(
    () => (archived.length === 0 ? tasks : [...tasks, ...archived]),
    [tasks, archived],
  );
  return { tasks: all, loaded, error };
}

/** Whether a task is archived: put away from the board, still itself everywhere else. */
export const isArchived = (task: Pick<BoardTaskView, "archivedAt">): boolean =>
  task.archivedAt !== null && task.archivedAt !== undefined;

const DEFAULT_SETTINGS: TaskBoardSettings = { archiveAfterDays: 7 };

/** The board's settings: how soon a quiet done task is archived. */
export function useBoardSettings(): TaskBoardSettings {
  const settings = useTarget("tasks")?.sections.settings as
    | TaskBoardSettings
    | undefined;
  return settings ?? DEFAULT_SETTINGS;
}

export function useSetBoardSettings() {
  return useWireMutation<TaskArgs["setSettings"], TaskResults["setSettings"]>(
    "tasks",
    "setSettings",
  );
}

/** Put a task away (with its subtasks); `stopRuns` stops what runs first. */
export function useArchiveTask() {
  return useWireMutation<TaskArgs["archive"], TaskResults["archive"]>(
    "tasks",
    "archive",
  );
}

/** Bring tasks back to the board. */
export function useUnarchiveTasks() {
  return useWireMutation<TaskArgs["unarchive"], TaskResults["unarchive"]>(
    "tasks",
    "unarchive",
  );
}

/**
 * One task. `missing` is a task the board does not have (deleted, or never was): the host answers
 * a subscription to `tasks.<id>` with `target:missing`, and says it again when the task is deleted
 * while its page is open, so there is nothing to infer from the list.
 */
export function useTask(id: string | null) {
  const { error } = useTasks();
  const target = id === null ? undefined : `tasks.${id}`;
  const state = useTarget(target);
  const missing = useTargetMissing(target);
  const detail = state?.sections.task as BoardTaskDetail | undefined;
  const activity = state?.sections.activity as TaskActivityView[] | undefined;
  const task = useMemo<TaskDetail | undefined>(
    () =>
      missing || detail === undefined || activity === undefined
        ? undefined
        : { ...detail, activity },
    [missing, detail, activity],
  );
  return { task, missing, error };
}

/**
 * The user's own tasks, from the form: one, or a piece of work split into several, made in one
 * write. The call is the confirmation; nothing else makes tasks from the page.
 */
export function useCreateTasks() {
  return useWireMutation<TaskArgs["create"], TaskResults["create"]>(
    "tasks",
    "create",
  );
}

/**
 * Where tasks made under `parent`, else in `conversationId`, would work: a worktree or the
 * project's directory. Undefined while it is asked, or when it cannot be told.
 */
export function useNewTaskWorkspace(
  where: TaskArgs["workspaceFor"],
): TaskResults["workspaceFor"]["mode"] | undefined {
  const { parent, conversationId } = where;
  const query = useQuery({
    queryKey: [
      "wire",
      "tasks",
      "workspaceFor",
      parent ?? null,
      conversationId ?? null,
    ],
    queryFn: async () =>
      await getWire().call<TaskResults["workspaceFor"]>(
        "tasks",
        "workspaceFor",
        parent === undefined ? { conversationId } : { parent },
      ),
    enabled: parent !== undefined || conversationId !== undefined,
    retry: false,
  });
  return query.data?.mode;
}

/** Stop a run: a queued one never starts, a going one ends `interrupted`. */
export function useInterruptRun() {
  return useWireMutation<TaskArgs["interrupt"], TaskResults["interrupt"]>(
    "tasks",
    "interrupt",
  );
}

/** A new run of the task, in a fresh session. */
export function useRerunTask() {
  return useWireMutation<TaskArgs["rerun"], TaskResults["rerun"]>(
    "tasks",
    "rerun",
  );
}

export function useUpdateTask() {
  return useWireMutation<TaskArgs["update"], TaskResults["update"]>(
    "tasks",
    "update",
  );
}

/** Make a task wait for another, or change whether only done resolves the edge. */
export function useAddDependency() {
  return useWireMutation<
    TaskArgs["addDependency"],
    TaskResults["addDependency"]
  >("tasks", "addDependency");
}

export function useRemoveDependency() {
  return useWireMutation<
    TaskArgs["removeDependency"],
    TaskResults["removeDependency"]
  >("tasks", "removeDependency");
}

/** Make a task a subtask of another, or (null) of none. */
export function useSetParent() {
  return useWireMutation<TaskArgs["setParent"], TaskResults["setParent"]>(
    "tasks",
    "setParent",
  );
}

export function useCommentTask() {
  return useWireMutation<TaskArgs["comment"], TaskResults["comment"]>(
    "tasks",
    "comment",
  );
}

export function useDeleteTask() {
  return useWireMutation<TaskArgs["delete"], TaskResults["delete"]>(
    "tasks",
    "delete",
  );
}

/** Link a task to a conversation, or (null) unlink it. */
export function useLinkTask() {
  return useWireMutation<TaskArgs["link"], TaskResults["link"]>(
    "tasks",
    "link",
  );
}

/**
 * Turn an agent's draft row into a task. The row becomes the task's card; the reply carries it, so
 * the timeline shows the card before the next push.
 */
export function useConfirmTaskDraft() {
  return useWireMutation<TaskArgs["confirmDraft"], TaskResults["confirmDraft"]>(
    "tasks",
    "confirmDraft",
    {
      onSuccess: (result, args) =>
        rememberRows(args.conversationId, [result.message]),
    },
  );
}
