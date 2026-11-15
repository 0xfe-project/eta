import type { AgentView, TaskQueueReason } from "@eta/client-contracts";
import type { RunStatus, TaskDetail, TaskStatus } from "@/queries/tasks";
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
export const numbersLabel = (numbers: readonly number[]): string =>
  numbers.map((n) => `#${n}`).join(translate("common:listSeparator"));

/** The numbers of the tasks a task still waits for, for the queue's words. */
export const waitingNumbers = (task: {
  dependsOn?: readonly { number: number; state: string }[];
}): number[] =>
  (task.dependsOn ?? [])
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
