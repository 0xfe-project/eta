import type {
  AssigneeInput,
  AssigneeOption,
  Place,
  RunStatus,
  Task,
  TaskDetail,
  TaskStatus,
} from "@/queries/tasks";
import { when } from "./routine-format";

// How tasks read: their statuses, assignees and runs.

/** The board's order: what needs attention first. */
export const statuses: { value: TaskStatus; label: string }[] = [
  { value: "in_review", label: "待验收" },
  { value: "in_progress", label: "进行中" },
  { value: "blocked", label: "受阻" },
  { value: "todo", label: "待办" },
  { value: "backlog", label: "积压" },
  { value: "done", label: "已完成" },
  { value: "cancelled", label: "已取消" },
];

export const statusLabel = (status: TaskStatus) =>
  statuses.find((s) => s.value === status)?.label ?? status;

export const runStatusLabels: Record<RunStatus, string> = {
  queued: "排队中",
  starting: "启动中",
  running: "正在运行",
  completed: "已回复",
  failed: "失败",
  cancelled: "已停止",
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
    a.computer_name ?? "已移除的电脑",
    a.runtime && runtimeLabel(a.runtime),
    a.provider && providerLabel(a.provider),
  ]
    .filter(Boolean)
    .join(" · ");
}

export function assigneeLabel(assignee: Task["assignee"]) {
  if (assignee.kind === "user") return "我";
  if (assignee.kind === "remote") return remoteLabel(assignee);
  return "未指派";
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

/** The assignee options: nobody, the user, then every remote agent. */
export function assigneeOptions(remote: AssigneeOption[]) {
  return [
    { key: "none", label: "未指派" },
    { key: "user", label: "我" },
    ...remote.map((option) => ({
      key: assigneeKey({ kind: "remote", ...option }),
      label: remoteLabel(option) + (option.online ? "" : "（离线）"),
    })),
  ];
}

/** "刚刚", "5 分钟前", "3 小时前", "10-11". */
export function ago(iso: string) {
  const seconds = (Date.now() - new Date(iso).getTime()) / 1000;
  if (seconds < 60) return "刚刚";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} 小时前`;
  const date = new Date(iso);
  return `${date.getMonth() + 1}-${String(date.getDate()).padStart(2, "0")}`;
}

/** "新 worktree（web，axp/12-fix）" or "工作区 web". */
export function placeLabel(place: Place | null | undefined) {
  if (!place) return null;
  if (place.kind === "worktree")
    return `新 worktree（从 ${place.name ?? "项目"} 开${place.branch ? `，${place.branch}` : ""}）`;
  return `工作区 ${place.name ?? place.workspace_id}`;
}

/** "由 Josh 创建 · 今天 08:58". */
export function createdBy(task: TaskDetail) {
  return `${
    task.created_by.kind === "agent"
      ? `由 ${task.created_by.agent_name ?? "智能体"} 创建`
      : "由我创建"
  } · ${when(task.created_at)}`;
}

/** Whether a deliverable is a pull request on github.com. */
export const isPullURL = (url: string) =>
  /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+/.test(url);
