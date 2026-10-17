import type {
  AssigneeInput,
  Place,
  RunStatus,
  Task,
  TaskDetail,
  TaskStatus,
} from "@/queries/tasks";
import { translate } from "@/lib/i18n";
import { when } from "./routine-format";

// How tasks read: their statuses, assignees and runs.

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
    return translate("tasks:runStatus.replied");
  },
  get failed() {
    return translate("common:status.failed");
  },
  get cancelled() {
    return translate("common:status.stopped");
  },
};

export const isActive = (
  status: RunStatus | null | undefined,
): status is "queued" | "starting" | "running" =>
  status === "queued" || status === "starting" || status === "running";

const runtimeLabels: Record<string, string> = {
  paseo: "Paseo",
  herdr: "Herdr",
};
const providerLabels: Record<string, string> = {
  claude: "Claude",
  codex: "Codex",
  devin: "Devin",
};

export const runtimeLabel = (runtime: string) =>
  runtimeLabels[runtime] ?? runtime;
export const providerLabel = (provider: string) =>
  providerLabels[provider] ?? provider;

/** "笔记本 · Paseo · Claude". */
export function remoteLabel(a: {
  computer_name?: string | null;
  runtime?: string | null;
  provider?: string | null;
}) {
  return [
    a.computer_name ?? translate("computers:labels.removedComputer"),
    a.runtime && runtimeLabel(a.runtime),
    a.provider && providerLabel(a.provider),
  ]
    .filter(Boolean)
    .join(" · ");
}

export function assigneeLabel(assignee: Task["assignee"]) {
  if (assignee.kind === "user") return translate("tasks:assignee.me");
  if (assignee.kind === "remote") return remoteLabel(assignee);
  return translate("tasks:assignee.unassigned");
}

/** A select's value for an assignee. */
export function assigneeKey(a: {
  kind?: string;
  computer_id?: string | null;
  runtime?: string | null;
  provider?: string | null;
}) {
  return a.kind === "remote"
    ? `remote:${a.computer_id}:${a.runtime}:${a.provider}`
    : (a.kind ?? "none");
}

export function assigneeFromKey(key: string): AssigneeInput {
  if (!key.startsWith("remote:")) return { kind: key as "none" | "user" };
  const [, computer_id, runtime, provider] = key.split(":");
  return {
    kind: "remote",
    computer_id,
    runtime: runtime as "paseo" | "herdr",
    provider,
  };
}

/** "刚刚", "5 分钟前", "3 小时前", "10-11". */
export function ago(iso: string) {
  const seconds = (Date.now() - new Date(iso).getTime()) / 1000;
  if (seconds < 60) return translate("common:time.justNow");
  if (seconds < 3600)
    return translate("common:time.minutesAgo", {
      count: Math.floor(seconds / 60),
    });
  if (seconds < 86_400)
    return translate("common:time.hoursAgo", {
      count: Math.floor(seconds / 3600),
    });
  const date = new Date(iso);
  return `${date.getMonth() + 1}-${String(date.getDate()).padStart(2, "0")}`;
}

/** "新 worktree（web，eta/12-fix）" or "工作区 web". */
export function placeLabel(place: Place | null | undefined) {
  if (!place) return null;
  if (place.kind === "worktree")
    return translate("tasks:location.worktreeSummary", {
      projectName: place.name ?? translate("tasks:location.projectFallback"),
      branchSuffix: place.branch
        ? translate("common:format.commaSuffix", { value: place.branch })
        : "",
    });
  return translate("tasks:location.workspaceSummary", {
    name: place.name ?? place.workspace_id,
  });
}

/** "由 Josh 创建 · 今天 08:58". */
export function createdBy(task: TaskDetail) {
  return translate("common:format.joinedValues", {
    first:
      task.created_by.kind === "agent"
        ? translate("tasks:activity.createdByAgent", {
            name:
              task.created_by.agent_name ?? translate("common:entities.agents"),
          })
        : translate("tasks:activity.createdByMe"),
    second: when(task.created_at),
  });
}

/** Whether a deliverable is a pull request on github.com. */
export const isPullURL = (url: string) =>
  /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+/.test(url);
