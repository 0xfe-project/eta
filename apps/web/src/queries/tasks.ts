import type {
  BoardTaskDetail,
  BoardTaskStatus,
  BoardTaskView,
  TaskActivityView,
  TaskArgs,
  TaskResults,
  TaskRunStatus,
  TaskRunView,
} from "@eta/client-contracts";
import { useMemo } from "react";
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

/** Every task, most recently moved first (the order the host keeps). */
export function useTasks() {
  const { items, loaded, error } = useListTarget<BoardTaskView>("tasks");
  return { tasks: items, loaded, error };
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
