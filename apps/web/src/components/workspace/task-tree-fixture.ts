import type {
  BoardTaskStatus,
  TaskDependencyState,
} from "@eta/client-contracts";
import type { Task } from "@/queries/tasks";

// A board as the host lists it: each task's own edges (`dependsOn`) with where they stand, and
// what its work still waits for (`waitingOn`), worked out here the way the host does.

interface Spec {
  number: number;
  title?: string;
  status?: BoardTaskStatus;
  parent?: number;
  after?: (number | [number, "done"])[];
  agent?: string;
}

const resolved = (
  status: BoardTaskStatus,
  requireDone: boolean,
): TaskDependencyState =>
  status === "cancelled"
    ? "cancelled"
    : status === "done" || (status === "in_review" && !requireDone)
      ? "resolved"
      : "waiting";

export function board(specs: Spec[]): Task[] {
  const byNumber = new Map(specs.map((s) => [s.number, s]));
  const id = (n: number) => `t${n}`;
  const edges = (s: Spec) =>
    (s.after ?? []).map((a) => {
      const [n, done] = Array.isArray(a) ? [a[0], true] : [a, false];
      const target = byNumber.get(n)!;
      const status = target.status ?? "todo";
      return {
        taskId: id(n),
        number: n,
        title: target.title ?? `task ${n}`,
        status,
        requireDone: done,
        state: resolved(status, done),
      };
    });
  return specs.map((s) => {
    const own = edges(s);
    const inherited =
      s.parent === undefined
        ? []
        : edges(byNumber.get(s.parent)!).map((e) => ({ ...e, via: s.parent! }));
    const waitingOn = [...own.map((e) => ({ ...e, via: null })), ...inherited]
      .filter((e) => e.state !== "resolved")
      .map(({ taskId, number, title, status, state, via }) => ({
        taskId,
        number,
        title,
        status,
        state: state as "waiting" | "cancelled",
        via,
      }));
    return {
      id: id(s.number),
      number: s.number,
      title: s.title ?? `task ${s.number}`,
      status: s.status ?? "todo",
      createdBy: { kind: "agent", agentId: s.agent ?? "ada" },
      assigneeAgentId: null,
      conversationId: null,
      runStatus: null,
      dependsOn: own,
      waitingOn,
      parentId: s.parent === undefined ? null : id(s.parent),
      subtasks: specs.some((c) => c.parent === s.number)
        ? {
            total: specs.filter(
              (c) => c.parent === s.number && c.status !== "cancelled",
            ).length,
            done: specs.filter(
              (c) => c.parent === s.number && c.status === "done",
            ).length,
          }
        : null,
      comments: 0,
      createdAt: s.number,
      updatedAt: s.number,
    } satisfies Task;
  });
}

/** The design's tree: Release v1.0 with five subtasks in three steps, and three tasks of their own. */
export const release = () =>
  board([
    { number: 4, title: "发布 v1.0", status: "in_progress" },
    { number: 5, title: "整理变更日志", status: "done", parent: 4 },
    { number: 6, title: "更新用户文档", status: "done", parent: 4 },
    {
      number: 7,
      title: "打包桌面安装包",
      status: "in_review",
      parent: 4,
      after: [5, 6],
    },
    {
      number: 8,
      title: "跑回归测试",
      status: "in_progress",
      parent: 4,
      after: [5, 6],
    },
    { number: 9, title: "发布公告", status: "todo", parent: 4, after: [8, 7] },
    { number: 2, title: "实现登录接口", status: "in_progress" },
    { number: 3, title: "接入前端登录页", status: "todo", after: [2] },
    { number: 10, title: "导出旧库快照", status: "cancelled" },
    {
      number: 11,
      title: "迁移旧用户数据",
      status: "blocked",
      after: [10],
      agent: "bo",
    },
  ]);
