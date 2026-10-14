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
      return translate("待验收");
    },
  },
  {
    value: "in_progress",
    get label() {
      return translate("进行中");
    },
  },
  {
    value: "blocked",
    get label() {
      return translate("受阻");
    },
  },
  {
    value: "todo",
    get label() {
      return translate("待办");
    },
  },
  {
    value: "backlog",
    get label() {
      return translate("积压");
    },
  },
  {
    value: "done",
    get label() {
      return translate("已完成");
    },
  },
  {
    value: "cancelled",
    get label() {
      return translate("已取消");
    },
  },
];

export const statusLabel = (status: TaskStatus) =>
  statuses.find((s) => s.value === status)?.label ?? status;

export const runStatusLabels: Record<RunStatus, string> = {
  get queued() {
    return translate("排队中");
  },
  get starting() {
    return translate("启动中");
  },
  get running() {
    return translate("正在运行");
  },
  get completed() {
    return translate("已回复");
  },
  get failed() {
    return translate("失败");
  },
  get cancelled() {
    return translate("已停止");
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
    a.computer_name ?? translate("已移除的电脑"),
    a.runtime && runtimeLabel(a.runtime),
    a.provider && providerLabel(a.provider),
  ]
    .filter(Boolean)
    .join(" · ");
}

export function assigneeLabel(assignee: Task["assignee"]) {
  if (assignee.kind === "user") return translate("我");
  if (assignee.kind === "remote") return remoteLabel(assignee);
  return translate("未指派");
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
  if (seconds < 60) return translate("刚刚");
  if (seconds < 3600)
    return translate("{{value1}} 分钟前", {
      value1: Math.floor(seconds / 60),
      count: Math.floor(seconds / 60),
    });
  if (seconds < 86_400)
    return translate("{{value1}} 小时前", {
      value1: Math.floor(seconds / 3600),
      count: Math.floor(seconds / 3600),
    });
  const date = new Date(iso);
  return `${date.getMonth() + 1}-${String(date.getDate()).padStart(2, "0")}`;
}

/** "新 worktree（web，axp/12-fix）" or "工作区 web". */
export function placeLabel(place: Place | null | undefined) {
  if (!place) return null;
  if (place.kind === "worktree")
    return translate("新 worktree（从 {{value1}} 开{{value2}}）", {
      value1: place.name ?? translate("项目"),
      value2: place.branch
        ? translate("，{{value1}}", { value1: place.branch })
        : "",
    });
  return translate("工作区 {{value1}}", {
    value1: place.name ?? place.workspace_id,
  });
}

/** "由 Josh 创建 · 今天 08:58". */
export function createdBy(task: TaskDetail) {
  return translate("{{value1}} · {{value2}}", {
    value1:
      task.created_by.kind === "agent"
        ? translate("由 {{value1}} 创建", {
            value1: task.created_by.agent_name ?? translate("智能体"),
          })
        : translate("由我创建"),
    value2: when(task.created_at),
  });
}

/** Whether a deliverable is a pull request on github.com. */
export const isPullURL = (url: string) =>
  /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+/.test(url);
