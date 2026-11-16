import type { Task, TaskDetail } from "@/queries/tasks";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { isArchived, useArchiveTask, useUnarchiveTasks } from "@/queries/tasks";
import { wireErrorMessage } from "@/queries/wire";
import { isActive } from "./task-format";
import { descendantsOf } from "./task-plan";

const showError = (error: Error) => toast.error(wireErrorMessage(error));

/** What a task's menu needs to archive or restore it, and the question it may ask first. */
export interface ArchiveAction {
  task: TaskDetail | undefined;
  /** The menu item's words: archive, or restore. */
  label: string;
  /** The menu item was chosen. */
  run: () => void;
  /** A run of it, or of a task under it, has not ended: archiving stops it. */
  running: boolean;
  /** How many tasks under it go with it. */
  below: number;
  asking: boolean;
  setAsking: (asking: boolean) => void;
  pending: boolean;
  /** The question was answered yes. */
  confirm: () => void;
}

/**
 * Archive or restore a task from its menu. A finished task goes at once; one that is not finished
 * asks first, saying it keeps its status; one with a run going (its own, or under it) asks whether
 * to stop that run, which archiving it does (`ArchiveDialog` asks).
 */
export function useArchiveAction(
  task: TaskDetail | undefined,
  all: readonly Task[],
): ArchiveAction {
  const { t } = useTranslation(["tasks"] as const);
  const archive = useArchiveTask();
  const unarchive = useUnarchiveTasks();
  const [asking, setAsking] = useState(false);
  const below = task === undefined ? [] : descendantsOf(task.id, all);
  const running =
    task !== undefined &&
    (task.runs.some((run) => isActive(run.status)) ||
      below.some((child) => isActive(child.runStatus)));
  const finished = task?.status === "done" || task?.status === "cancelled";
  const archived = task !== undefined && isArchived(task);
  const confirm = () => {
    if (task === undefined) return;
    archive.mutate(
      { taskId: task.id, ...(running ? { stopRuns: true } : {}) },
      {
        onSuccess: () => {
          setAsking(false);
          toast.success(t("archive.archivedToast", { number: task.number }));
        },
        onError: showError,
      },
    );
  };
  const run = () => {
    if (task === undefined) return;
    if (archived)
      unarchive.mutate(
        { taskId: task.id },
        {
          onSuccess: () =>
            toast.success(
              t("archive.restoredToast", { count: 1, number: task.number }),
            ),
          onError: showError,
        },
      );
    else if (finished && !running) confirm();
    else setAsking(true);
  };
  return {
    task,
    label: archived ? t("archive.unarchive") : t("archive.archive"),
    run,
    running,
    below: below.length,
    asking,
    setAsking,
    pending: archive.isPending,
    confirm,
  };
}
