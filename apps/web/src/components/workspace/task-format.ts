import type { AgentView, BoardTaskAssignee } from "@eta/client-contracts";
import type { TaskDetail, TaskStatus } from "@/queries/tasks";
import { translate } from "@/lib/i18n";
import { agentName } from "@/queries/agents";
import { when } from "./routine-format";

// How tasks read: their statuses, assignees and times.

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

export const assignees: { value: BoardTaskAssignee; label: string }[] = [
  {
    value: "none",
    get label() {
      return translate("tasks:assignee.unassigned");
    },
  },
  {
    value: "user",
    get label() {
      return translate("tasks:assignee.me");
    },
  },
];

export const assigneeLabel = (assignee: BoardTaskAssignee) =>
  assignees.find((a) => a.value === assignee)?.label ?? assignee;

/** "刚刚", "5 分钟前", "3 小时前", "10-11". */
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

/** "由 Josh 创建 · 今天 08:58". */
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
