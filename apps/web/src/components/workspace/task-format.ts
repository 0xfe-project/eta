import type { AgentView, TaskQueueReason } from "@eta/client-contracts";
import type { RunStatus, Task, TaskDetail, TaskStatus } from "@/queries/tasks";
import { translate } from "@/lib/i18n";
import { agentName } from "@/queries/agents";
import { when } from "./routine-format";

// How tasks read: their statuses, runs and times.

/** The board's order: what needs attention first. */
export const statuses: { value: TaskStatus; label: string }[] = [
  {
    value: "in_review",
    get label() {
      return translate("tasks:status.inReview");
    },
  },
  {
    value: "in_progress",
    get label() {
      return translate("tasks:status.inProgress");
    },
  },
  {
    value: "blocked",
    get label() {
      return translate("tasks:status.blocked");
    },
  },
  {
    value: "todo",
    get label() {
      return translate("tasks:status.todo");
    },
  },
  {
    value: "backlog",
    get label() {
      return translate("tasks:status.backlog");
    },
  },
  {
    value: "done",
    get label() {
      return translate("tasks:status.done");
    },
  },
  {
    value: "cancelled",
    get label() {
      return translate("tasks:status.cancelled");
    },
  },
];

export const statusLabel = (status: TaskStatus) =>
  statuses.find((s) => s.value === status)?.label ?? status;

/**
 * A status's colours: its words on a label (`ink`, a step deeper than the mark in the light theme,
 * so 12px text keeps 4.5:1 on the tint), the mark (`text`), a label's tint and a control's border.
 */
const tones = {
  backlog: {
    ink: "text-muted-ink",
    text: "text-muted-foreground",
    tint: "bg-muted-foreground/10 dark:bg-muted-foreground/15",
    border: "border-muted-foreground/40",
  },
  todo: {
    ink: "text-foreground",
    text: "text-foreground",
    tint: "bg-foreground/6 dark:bg-foreground/8",
    border: "border-foreground/40",
  },
  in_progress: {
    ink: "text-state-info-ink",
    text: "text-state-info",
    tint: "bg-state-info/10 dark:bg-state-info/16",
    border: "border-state-info",
  },
  in_review: {
    ink: "text-state-warning-ink",
    text: "text-state-warning",
    tint: "bg-state-warning/13 dark:bg-state-warning/16",
    border: "border-state-warning",
  },
  done: {
    ink: "text-state-success-ink",
    text: "text-state-success",
    tint: "bg-state-success/10 dark:bg-state-success/15",
    border: "border-state-success",
  },
  blocked: {
    ink: "text-state-error-ink",
    text: "text-state-error",
    tint: "bg-state-error/9 dark:bg-state-error/16",
    border: "border-state-error",
  },
  cancelled: {
    ink: "text-muted-ink",
    text: "text-muted-foreground",
    tint: "bg-muted-foreground/10 dark:bg-muted-foreground/15",
    border: "border-muted-foreground/40",
  },
} satisfies Record<
  TaskStatus,
  { ink: string; text: string; tint: string; border: string }
>;

export const statusTone = (status: TaskStatus) => tones[status] ?? tones.todo;

/** Whether a task's menu offers to cancel it with its subtasks: a parent that is not cancelled. */
export const canCancelTree = (task: Pick<TaskDetail, "subtasks" | "status">) =>
  task.subtasks != null && task.status !== "cancelled";

/**
 * The tasks a parent's cancel takes with it, as the host picks them: everything under it, at any
 * depth, that is neither done nor cancelled.
 */
export function cancelledWith(
  id: string,
  tasks: readonly Pick<Task, "id" | "parentId" | "status">[],
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

/**
 * The tasks a cancel would block: those that wait for this one and have not started (their edge
 * is not resolved yet) and are not blocked already. A run queued behind a cancelled task is not
 * started; it is blocked.
 */
export function blockedByCancel(task: Pick<TaskDetail, "dependents">) {
  return (task.dependents ?? []).filter(
    (edge) =>
      edge.state === "waiting" &&
      edge.status !== "done" &&
      edge.status !== "cancelled" &&
      // Already blocked: a cancel changes nothing for it.
      edge.status !== "blocked",
  ).length;
}

export const runStatusLabels: Record<RunStatus, string> = {
  get queued() {
    return translate("tasks:runStatus.queued");
  },
  get starting() {
    return translate("common:status.starting");
  },
  get running() {
    return translate("tasks:runStatus.running");
  },
  get completed() {
    return translate("tasks:runStatus.completed");
  },
  get failed() {
    return translate("common:status.failed");
  },
  get interrupted() {
    return translate("common:status.stopped");
  },
};

/** "#12、#13" (or "#12, #13"): tasks named by their numbers. */
const numbersLabel = (numbers: readonly number[]): string =>
  numbers.map((n) => `#${n}`).join(translate("common:listSeparator"));

/** The numbers of the tasks a task still waits for, for the queue's words. */
export const waitingNumbers = (task: {
  dependsOn?: readonly { number: number; state: string }[];
  /** What its work waits for, its parents' edges included; a host older than subtasks has none. */
  waitingOn?: readonly { number: number; state: string }[];
}): number[] =>
  (task.waitingOn ?? task.dependsOn ?? [])
    .filter((edge) => edge.state === "waiting")
    .map((edge) => edge.number);

/**
 * Why a run waits. The two machine reasons name the machine, so the person knows which one to
 * turn on or whose limit to raise; `machine` is undefined only when the run's machine is unknown.
 * Waiting for dependencies names the tasks (`waitingOn`, numbers), so the person knows whom.
 */
export function queueReasonLabel(
  reason: TaskQueueReason,
  machine: string | undefined,
  waitingOn: readonly number[] = [],
): string {
  const named = machine ?? translate("tasks:queueReason.thisMachine");
  switch (reason) {
    case "task_busy":
      return translate("tasks:queueReason.taskBusy");
    case "waiting_deps":
      return waitingOn.length === 0
        ? translate("tasks:queueReason.waitingDepsUnknown")
        : translate("tasks:queueReason.waitingDeps", {
            tasks: numbersLabel(waitingOn),
          });
    case "machine_full":
      return translate("tasks:queueReason.machineFull", { machine: named });
    case "machine_offline":
      return translate("tasks:queueReason.machineOffline", { machine: named });
    default: {
      // A reason this client does not know yet, from a newer host: say nothing wrong.
      const unknown: never = reason;
      return String(unknown);
    }
  }
}

/** Whether a run has not ended. */
export const isActive = (
  status: RunStatus | null | undefined,
): status is "queued" | "starting" | "running" =>
  status === "queued" || status === "starting" || status === "running";

/** Where the executor works: "git worktree · eta/task-12", or the project's directory. */
export function workspaceLabel(workspace: TaskDetail["workspace"]) {
  return workspace.mode === "worktree"
    ? translate("tasks:workspace.worktree")
    : translate("tasks:workspace.local");
}

/** "just now", "5 minutes ago", "3 hours ago", "10-11". */
export function ago(at: string | number) {
  const date = new Date(at);
  const seconds = (Date.now() - date.getTime()) / 1000;
  if (seconds < 60) return translate("common:time.justNow");
  if (seconds < 3600)
    return translate("common:time.minutesAgo", {
      count: Math.floor(seconds / 60),
    });
  if (seconds < 86_400)
    return translate("common:time.hoursAgo", {
      count: Math.floor(seconds / 3600),
    });
  return `${date.getMonth() + 1}-${String(date.getDate()).padStart(2, "0")}`;
}

/** Who did something to a task: me, an agent by its name, or the system. */
export function actorName(
  actor: TaskDetail["createdBy"] | TaskDetail["activity"][number]["actor"],
  agents: readonly Pick<AgentView, "id" | "name">[],
) {
  if (actor.kind === "user") return translate("tasks:assignee.me");
  if (actor.kind === "agent") return agentName(agents, actor.agentId);
  return "eta";
}

/** "Created by Josh · today 08:58". */
export function createdBy(
  task: TaskDetail,
  agents: readonly Pick<AgentView, "id" | "name">[],
) {
  return translate("common:format.joinedValues", {
    first:
      task.createdBy.kind === "agent"
        ? translate("tasks:activity.createdByAgent", {
            name: agentName(agents, task.createdBy.agentId),
          })
        : translate("tasks:activity.createdByMe"),
    second: when(task.createdAt),
  });
}
