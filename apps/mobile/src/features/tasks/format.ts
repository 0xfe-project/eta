// How tasks read: their statuses, runs, people and times.

import type {
  BoardTaskDetail,
  BoardTaskStatus,
  BoardTaskView,
  TaskActivityView,
  TaskActor,
  TaskQueueReason,
  TaskRunStatus,
  TaskRunView,
} from "@eta/client-contracts";
import type { TextKey } from "../../i18n";
import type { IconName } from "../../ui/icons";
import { agentById, machineById } from "../../app/lists";
import { t } from "../../i18n";
import { ago, clock, moment, reason } from "../../ui/format";
import { WireError } from "../../wire/wire";

/** A task with what its own page reads: `tasks.<id>`'s two sections as one. */
export type TaskDetail = BoardTaskDetail & { activity: TaskActivityView[] };

/** 06d's order: the way work moves. */
export const STATUSES: BoardTaskStatus[] = [
  "backlog",
  "todo",
  "in_progress",
  "blocked",
  "in_review",
  "done",
  "cancelled",
];
/** 05's sections: what needs the user first. */
export const OPEN_STATUSES: BoardTaskStatus[] = [
  "in_review",
  "blocked",
  "in_progress",
  "todo",
];
/** 05's folds: the past and the someday. */
export const FOLDED_STATUSES: BoardTaskStatus[] = [
  "backlog",
  "done",
  "cancelled",
];

export const statusLabel = (status: BoardTaskStatus): string =>
  t(`tasks.status.${status}` as TextKey);

export const STATUS_ICONS: Record<BoardTaskStatus, IconName> = {
  backlog: "circleDashed",
  todo: "circle",
  in_progress: "circleHalf",
  blocked: "prohibit",
  in_review: "eye",
  done: "checkCircle",
  cancelled: "xCircle",
};

export const statusColor = (status: BoardTaskStatus) =>
  status === "blocked"
    ? ("state-error" as const)
    : status === "in_progress"
      ? ("foreground" as const)
      : ("muted-foreground" as const);

export const runLabel = (status: TaskRunStatus): string =>
  t(`tasks.run.${status}` as TextKey);

/** Whether a run has not ended. */
export const isActive = (status: TaskRunStatus | null | undefined): boolean =>
  status === "queued" || status === "starting" || status === "running";

/** Why a run waits; the machine reasons name the machine, so the user knows which to turn on. */
export function queueReason(
  reasonCode: TaskQueueReason,
  machineId: string | null,
): string {
  if (reasonCode === "task_busy") return t("tasks.queue.taskBusy");
  const machine = machineById(machineId)?.name ?? t("tasks.queue.thisMachine");
  return reasonCode === "machine_full"
    ? t("tasks.queue.machineFull", { machine })
    : t("tasks.queue.machineOffline", { machine });
}

/** Who did something to a task: me, an agent by its name, or the system. */
export function actorName(actor: TaskActor): string {
  if (actor.kind === "user") return t("tasks.me");
  if (actor.kind === "agent")
    return agentById(actor.agentId)?.name ?? t("tasks.deletedAgent");
  return "eta";
}

/** Who executes a task: the agent it was drafted for, else its maker. */
export function executor(task: BoardTaskView): TaskActor {
  return task.assigneeAgentId === null || task.assigneeAgentId === undefined
    ? task.createdBy
    : { kind: "agent", agentId: task.assigneeAgentId };
}

/** Who works in a run: the agent mentioned into it, or the executor. */
export const runActor = (task: BoardTaskView, run: TaskRunView): TaskActor =>
  run.agentId === null
    ? executor(task)
    : { kind: "agent", agentId: run.agentId };

/** The list's second line in a fold: 昨天, 3 天, 上周, 10/28. */
export function past(at: number, now = Date.now()): string {
  const days = Math.floor((now - at) / (24 * 60 * 60_000));
  if (days < 2) return ago(at, now);
  if (days < 7) return t("tasks.daysAgo", { count: days });
  if (days < 14) return t("tasks.lastWeek");
  return ago(at, now);
}

/** 06c's 更新于: 刚刚, 今天 9:12, 昨天 18:20. */
export function updated(at: number, now = Date.now()): string {
  if (now - at < 60_000) return t("common.justNow");
  return new Date(at).toDateString() === new Date(now).toDateString()
    ? t("tasks.today", { time: clock(at) })
    : moment(at, now);
}

/** A path as a person reads it: `~` for the machine's home, a bare home kept whole. */
export function shortPath(
  path: string,
  machineId: string | null | undefined,
): string {
  const home = machineById(machineId)?.home;
  return home && path.startsWith(`${home}/`)
    ? `~${path.slice(home.length)}`
    : path;
}

/** What a failed call says: the host's words, or plainly what happened to the call. */
export function failure(error: unknown): string {
  if (error instanceof WireError) {
    if (error.code === "disconnected") return t("common.lostConnection");
    if (error.code === "timeout") return t("tasks.error.timeout");
  }
  return reason(error);
}

/** A call that got no answer at all: it may have happened. */
export const unanswered = (error: unknown): boolean =>
  error instanceof WireError &&
  (error.code === "timeout" || error.code === "disconnected");
