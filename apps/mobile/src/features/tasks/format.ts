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
import { agentById, machineById } from "../../app/lists";
import { t } from "../../i18n";
import { ago, clock, moment, reason } from "../../ui/format";
import { WireError } from "../../wire/wire";

/** A task with what its own page reads: `tasks.<id>`'s two sections as one. */
export type TaskDetail = BoardTaskDetail & { activity: TaskActivityView[] };

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

/**
 * The tasks a cancel would block: those that wait for this one and have not started (their edge
 * is not resolved yet) and are not blocked already, as the web app counts them.
 */
export const blockedByCancel = (task: Pick<TaskDetail, "dependents">): number =>
  (task.dependents ?? []).filter(
    (edge) =>
      edge.state === "waiting" &&
      edge.status !== "done" &&
      edge.status !== "cancelled" &&
      edge.status !== "blocked",
  ).length;

/**
 * The tasks a parent's cancel takes with it, as the host picks them: everything under it, at any
 * depth, that is neither done nor cancelled.
 */
export function cancelledWith(
  id: string,
  tasks: readonly Pick<BoardTaskView, "id" | "parentId" | "status">[],
): number {
  const under: string[] = [id];
  let count = 0;
  for (let i = 0; i < under.length; i++)
    for (const task of tasks)
      if (task.parentId === under[i]) {
        under.push(task.id);
        if (task.status !== "done" && task.status !== "cancelled") count++;
      }
  return count;
}

/** What a cancel does to the tasks that wait, in words: none, one, or how many. */
export const cancelImpact = (dependents: number): string =>
  dependents === 1
    ? t("tasks.statusHint.cancelledDependent")
    : t("tasks.statusHint.cancelledDependents", { count: dependents });

export const runLabel = (status: TaskRunStatus): string =>
  t(`tasks.run.${status}` as TextKey);

/** Whether a run has not ended. */
export const isActive = (status: TaskRunStatus | null | undefined): boolean =>
  status === "queued" || status === "starting" || status === "running";

/**
 * Why a run waits; the machine reasons name the machine, so the user knows which to turn on, and
 * waiting for dependencies names the tasks (`waitingOn`, their numbers).
 */
export function queueReason(
  reasonCode: TaskQueueReason,
  machineId: string | null,
  waitingOn: readonly number[] = [],
): string {
  const machine = () =>
    machineById(machineId)?.name ?? t("tasks.queue.thisMachine");
  switch (reasonCode) {
    case "task_busy":
      return t("tasks.queue.taskBusy");
    case "waiting_deps":
      return t("tasks.queue.waitingDeps", {
        tasks:
          waitingOn.length === 0
            ? t("tasks.queue.theirDependencies")
            : waitingOn.map((n) => `#${n}`).join(", "),
      });
    case "machine_full":
      return t("tasks.queue.machineFull", { machine: machine() });
    case "machine_offline":
      return t("tasks.queue.machineOffline", { machine: machine() });
    default: {
      // A reason from a newer host than this app: its code, rather than a wrong reason.
      const unknown: never = reasonCode;
      return String(unknown);
    }
  }
}

/** The numbers of the tasks a task still waits for. A host older than dependencies sends none. */
export const waitingNumbers = (task: {
  dependsOn?: readonly { number: number; state: string }[];
}): number[] =>
  (task.dependsOn ?? [])
    .filter((edge) => edge.state === "waiting")
    .map((edge) => edge.number);

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

/** The list's second line in a fold: Yesterday, 3 days, Last week, 10/28. */
export function past(at: number, now = Date.now()): string {
  const days = Math.floor((now - at) / (24 * 60 * 60_000));
  if (days < 2) return ago(at, now);
  if (days < 7) return t("tasks.daysAgo", { count: days });
  if (days < 14) return t("tasks.lastWeek");
  return ago(at, now);
}

/** 06c's Updated at: Just now, Today 9:12, Yesterday 18:20. */
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

/**
 * A task's place in the task graph, in a few words: what its work still waits for (or that a
 * dependency was cancelled), else how far its subtasks are. Undefined outside the graph.
 */
export function graphLabel(task: {
  status: string;
  waitingOn?: readonly { number: number; state: string }[];
  subtasks?: { total: number; done: number } | null;
}): string | undefined {
  const open =
    task.status === "todo" ||
    task.status === "blocked" ||
    task.status === "backlog";
  const waits = open ? (task.waitingOn ?? []) : [];
  const named = (state: string) =>
    waits
      .filter((wait) => wait.state === state)
      .map((wait) => `#${wait.number}`)
      .join(", ");
  if (named("cancelled") !== "")
    return t("tasks.graph.cancelled", { tasks: named("cancelled") });
  if (named("waiting") !== "")
    return t("tasks.queue.waitingDeps", { tasks: named("waiting") });
  if (task.subtasks != null)
    return t("tasks.graph.subtasks", {
      done: task.subtasks.done,
      total: task.subtasks.total,
    });
  return undefined;
}
