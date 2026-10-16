/**
 * The task tools (REFACTOR.md §9, P3.1).
 *
 * What an agent in a group can do with the board: propose work, look at it, create it outright
 * when asked, change it, comment on it. The vocabulary is AXP's (`draft_task`, `create_task`, …)
 * and so is the discipline the descriptions carry, because a model reads the description and
 * nothing else:
 *
 * - a draft is a proposal that the user confirms; it does not create a task or wake an executor;
 * - `create_task` is for when the user explicitly asked for a task, not for routine discussion.
 *
 * The remote half of these tools (`list_assignees`, `list_places`, `assist_task`) arrives with P4:
 * there is no remote computer to name yet, and a tool that offered one would be lying.
 */
import type { HarnessTool, ToolResult } from "@eta/harness";
import type { SessionMeta } from "@eta/server";
import type { TaskCards } from "./cards";
import type { TaskRecord, TaskStore } from "./store";
import { defineTool, text, toKernelTool, toolError } from "@eta/harness";
import { Type } from "typebox";
import { toTaskDetail } from "./shapes";
import { isTaskStatus } from "./store";

export interface TaskToolsOptions {
  tasks: TaskStore;
  cards: TaskCards;
  /** Whose session these tools belong to: the group a draft lands in, the agent that asked. */
  meta: SessionMeta;
  /** How a task's shapes name an agent. */
  agentName: (agentId: string) => string | undefined;
}

/** One line per task: what the model can read without asking for the detail. */
function boardLines(
  list: readonly TaskRecord[],
  agentName: (agentId: string) => string | undefined,
): string {
  if (list.length === 0) return "任务板是空的。";
  return list
    .map((task) => {
      const who =
        task.createdByAgent === undefined
          ? "用户"
          : (agentName(task.createdByAgent) ?? task.createdByAgent);
      const assignee = task.assignee === "user" ? "待用户处理" : "未指派";
      return `#${task.number} [${task.status}] ${task.title} — ${assignee},由${who}创建`;
    })
    .join("\n");
}

export function taskTools(
  options: TaskToolsOptions,
): ReturnType<typeof toKernelTool>[] {
  const { tasks, cards, meta, agentName } = options;
  const groupId = typeof meta.groupId === "string" ? meta.groupId : undefined;
  const agentId = typeof meta.agentId === "string" ? meta.agentId : undefined;

  const draft = defineTool({
    name: "draft_task",
    label: "draft_task",
    description:
      "Propose executable work in this group as an editable task draft: title, goal, agreed decisions, acceptance criteria, and a plain-text source message range, copied into the description. This is the *board's* draft, not your own task list (TaskCreate/TaskUpdate are your private steps and never reach the user): the user reviews and confirms this one, and it becomes a card in this group. It does NOT create a board task or wake an executor by itself. Never silently create a task instead.",
    parameters: Type.Object({
      title: Type.String({ description: "Short title for this piece of work" }),
      goal: Type.String({ description: "What it should achieve" }),
      decided: Type.Optional(
        Type.String({ description: "What the group already decided" }),
      ),
      acceptance: Type.String({ description: "How it will be judged done" }),
      source: Type.Optional(
        Type.String({
          description:
            "Relevant message range as plain text, e.g. 第12–18条. Defaults to the message that woke you through the present.",
        }),
      ),
    }),
    execute: (args): ToolResult => {
      if (groupId === undefined) {
        return toolError("这个会话不属于任何群,没有地方提交草稿。");
      }
      const message = cards.draft({
        groupId,
        ...(agentId === undefined ? {} : { agentId }),
        draft: {
          title: args.title,
          goal: args.goal,
          ...(args.decided === undefined ? {} : { decided: args.decided }),
          acceptance: args.acceptance,
          ...(args.source === undefined ? {} : { source: args.source }),
        },
      });
      if (message === undefined) return toolError("草稿没有提交成功。");
      return text(`草稿已提交给用户确认:「${args.title}」`, {
        message_id: message.id,
      });
    },
  });

  const list = defineTool({
    name: "list_tasks",
    description:
      "List the task board's tasks (the user's and agents'), most recently updated first.",
    parameters: Type.Object({
      status: Type.Optional(
        Type.String({ description: "Only tasks in this status" }),
      ),
    }),
    execute: (args): ToolResult<{ tasks: unknown[] }> => {
      const all = tasks.list();
      const filtered =
        args.status === undefined
          ? all
          : all.filter((task) => task.status === args.status);
      return text(boardLines(filtered, agentName), {
        tasks: filtered.map((task) =>
          toTaskDetail(tasks.detail(task.id)!, { agentName }),
        ),
      });
    },
  });

  const get = defineTool({
    name: "get_task",
    description:
      "One task in full: its description, its timeline (comments, status changes) and its assignee.",
    parameters: Type.Object({
      task: Type.String({ description: "The task's id or number" }),
    }),
    execute: (args): ToolResult => {
      const found = tasks.find(args.task);
      if (found === undefined) return toolError(`没有这个任务:${args.task}`);
      const detail = toTaskDetail(tasks.detail(found.id)!, {
        agentName,
        comments: tasks.comments(found.id),
      });
      const timeline = detail.activity
        .map(
          (entry) =>
            `${entry.created_at} [${entry.kind}] ${entry.actor.kind}${entry.actor.agent_name === null ? "" : ` ${entry.actor.agent_name}`}${entry.body === null ? "" : `: ${entry.body}`}`,
        )
        .join("\n");
      return text(
        `#${detail.number} [${detail.status}] ${detail.title}\n\n${detail.description}\n\n时间线:\n${timeline}`,
        detail,
      );
    },
  });

  const create = defineTool({
    name: "create_task",
    description:
      "Create a task on the board. Assigned to the user, it waits for them. In group discussion prefer draft_task so the user can review; only create immediately when explicitly asked. The task links to the current group.",
    parameters: Type.Object({
      title: Type.String({ description: "Short title" }),
      description: Type.Optional(Type.String({ description: "What it is" })),
      status: Type.Optional(
        Type.String({
          description:
            "backlog, todo, in_progress, in_review, done, blocked or cancelled; todo by default",
        }),
      ),
      assignee: Type.Optional(
        Type.String({ description: "none (default) or user" }),
      ),
    }),
    execute: (args): ToolResult<unknown> => {
      const status = args.status;
      if (status !== undefined && !isTaskStatus(status)) {
        return toolError(`任务状态无效:${status}`);
      }
      if (
        args.assignee !== undefined &&
        args.assignee !== "user" &&
        args.assignee !== "none"
      ) {
        return toolError("指派只支持 none 或 user;远程电脑属于远程闭环(P4)。");
      }
      const task = tasks.create({
        title: args.title,
        ...(args.description === undefined
          ? {}
          : { description: args.description }),
        ...(status === undefined ? {} : { status }),
        ...(args.assignee === "user" ? { assignee: "user" as const } : {}),
        ...(agentId === undefined ? {} : { createdByAgent: agentId }),
        ...(groupId === undefined ? {} : { groupId }),
      });
      cards.sync(task.id);
      return text(`已建任务 #${task.number}「${task.title}」`, {
        task_id: task.id,
        number: task.number,
      });
    },
  });

  const update = defineTool({
    name: "update_task",
    description:
      "Change a task's title, description, status or assignee; only the fields given change.",
    parameters: Type.Object({
      task: Type.String({ description: "The task's id or number" }),
      title: Type.Optional(Type.String({})),
      description: Type.Optional(Type.String({})),
      status: Type.Optional(Type.String({})),
      assignee: Type.Optional(Type.String({ description: "none or user" })),
    }),
    execute: (args): ToolResult<unknown> => {
      const found = tasks.find(args.task);
      if (found === undefined) return toolError(`没有这个任务:${args.task}`);
      const status = args.status;
      if (status !== undefined && !isTaskStatus(status)) {
        return toolError(`任务状态无效:${status}`);
      }
      if (
        args.assignee !== undefined &&
        args.assignee !== "user" &&
        args.assignee !== "none"
      ) {
        return toolError("指派只支持 none 或 user。");
      }
      const updated = tasks.update(
        found.id,
        {
          ...(args.title === undefined ? {} : { title: args.title }),
          ...(args.description === undefined
            ? {}
            : { description: args.description }),
          ...(status === undefined ? {} : { status }),
          ...(args.assignee === undefined
            ? {}
            : {
                assignee:
                  args.assignee === "user"
                    ? ("user" as const)
                    : ("none" as const),
              }),
        },
        { kind: "agent", ...(agentId === undefined ? {} : { agentId }) },
      );
      if (updated === undefined) return toolError(`没有这个任务:${args.task}`);
      cards.sync(updated.id);
      return text(`#${updated.number} 现在是 [${updated.status}]`, {
        task_id: updated.id,
        status: updated.status,
      });
    },
  });

  const comment = defineTool({
    name: "comment_task",
    description: "Comment on a task.",
    parameters: Type.Object({
      task: Type.String({ description: "The task's id or number" }),
      body: Type.String({ description: "What to say" }),
    }),
    execute: (args): ToolResult<unknown> => {
      const found = tasks.find(args.task);
      if (found === undefined) return toolError(`没有这个任务:${args.task}`);
      tasks.comment(found.id, args.body, {
        kind: "agent",
        ...(agentId === undefined ? {} : { agentId }),
      });
      cards.sync(found.id);
      return text(`已在 #${found.number} 留言`, { task_id: found.id });
    },
  });

  const tools: HarnessTool<undefined, never, unknown>[] = [
    draft,
    list,
    get,
    create,
    update,
    comment,
  ] as unknown as HarnessTool<undefined, never, unknown>[];
  // The task tools need no environment: they read and write rows, not files.
  return tools.map((tool) => toKernelTool(tool, () => undefined));
}
