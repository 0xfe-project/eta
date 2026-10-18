import type {
  BoardTaskView,
  TaskActivityView,
  TaskActor,
} from "@eta/client-contracts";
import type { KernelTool } from "@eta/core";
import type { ToolResult } from "@eta/harness";
/**
 * The task tools: what an agent in a conversation can do with the board.
 *
 * Registered on each (agent x conversation) session when it opens, so a tool knows which agent it
 * speaks for and which conversation a draft lands in or a task is linked to without being told.
 * They are thin: the rules are the board's (`board.ts`), these only read what a model sends and
 * say, in words, what happened. What a model reads is the description and nothing else, so the
 * descriptions carry the discipline: a draft is a proposal the user confirms, and `create_task`
 * is for when the user asked for a task.
 */
import type { AgentStore } from "../agents/store";
import type { SessionHooks } from "../session-hooks";
import type { TaskBoard } from "./board";
import type { TaskRecord } from "./store";
import { defineTool, text, toKernelTool, toolError } from "@eta/harness";
import { Type } from "typebox";

/** A failure the model can act on, from anything the board refused. */
function failure(error: unknown): ToolResult {
  return toolError(error instanceof Error ? error.message : String(error));
}

/** The task tools of every session that is an agent in a conversation, and of no other. */
export function taskSessionTools(deps: {
  board: TaskBoard;
  agents: AgentStore;
}): NonNullable<SessionHooks["sessionTools"]> {
  return ({ meta }) =>
    meta.agentId === undefined || meta.conversationId === undefined
      ? []
      : taskTools(deps, {
          agentId: meta.agentId,
          conversationId: meta.conversationId,
        });
}

function taskTools(
  deps: { board: TaskBoard; agents: AgentStore },
  who: { agentId: string; conversationId: string },
): KernelTool[] {
  const { board, agents } = deps;
  const actor: TaskActor = { kind: "agent", agentId: who.agentId };
  /** Who, in words: an agent by its name, the user and the system as themselves. */
  const whoIs = (by: TaskActor): string =>
    by.kind === "agent"
      ? (agents.get(by.agentId!)?.name ?? "a deleted agent")
      : by.kind === "user"
        ? "the user"
        : "the system";

  const taskOf = (idOrNumber: string): TaskRecord => {
    const task = board.find(idOrNumber);
    if (task === undefined) throw new Error(`no such task: ${idOrNumber}`);
    return task;
  };

  /** One line: what a model can read without asking for the task. */
  const line = (task: BoardTaskView): string =>
    `#${task.number} [${task.status}] ${task.title} — ` +
    `${task.assignee === "user" ? "waiting on the user" : "unassigned"}, ` +
    `created by ${whoIs(task.createdBy)}`;

  const entry = (activity: TaskActivityView): string => {
    const { data } = activity;
    const said =
      activity.body ??
      (activity.kind === "status" ||
      activity.kind === "assignee" ||
      activity.kind === "title"
        ? `${String(data.from)} -> ${String(data.to)}`
        : activity.kind === "artifact"
          ? `"${String(data.title)}" version ${String(data.version)}`
          : "");
    return (
      `${new Date(activity.createdAt).toISOString()} [${activity.kind}] ` +
      `${whoIs(activity.actor)}${said === "" ? "" : `: ${said}`}`
    );
  };

  const draft = defineTool({
    name: "draft_task",
    label: "draft_task",
    description:
      "Propose executable work in this conversation as an editable task draft: a title, the goal, " +
      "what has already been decided, how it will be judged done, and where in the conversation it " +
      "came from. This is the board's draft, not your own step list: the user reviews it as a card " +
      "in the conversation and confirms it, and only then is a task made on the board. A draft " +
      "creates no task and wakes nobody. In a discussion, prefer it to create_task.",
    parameters: Type.Object({
      title: Type.String({
        description: "A short title for this piece of work",
      }),
      goal: Type.String({ description: "What it should achieve" }),
      decided: Type.Optional(
        Type.String({
          description: "What the conversation has already decided",
        }),
      ),
      acceptance: Type.String({ description: "How it will be judged done" }),
      source: Type.Optional(
        Type.String({
          description:
            "The messages it came from, as plain text, e.g. 第 12–18 条. Defaults to the message " +
            "that woke you through the present.",
        }),
      ),
    }),
    execute(args) {
      try {
        const row = board.draft({
          conversationId: who.conversationId,
          agentId: who.agentId,
          draft: args,
        });
        return text(`Drafted "${args.title}" for the user to confirm.`, {
          messageId: row.id,
        });
      } catch (error) {
        return failure(error);
      }
    },
  });

  const list = defineTool({
    name: "list_tasks",
    label: "list_tasks",
    description:
      "List the tasks on the board, the user's and the agents', the one touched last first.",
    parameters: Type.Object({
      status: Type.Optional(
        Type.String({ description: "Only the tasks in this status" }),
      ),
    }),
    execute(args) {
      const tasks = board
        .list()
        .filter(
          (task) => args.status === undefined || task.status === args.status,
        );
      return text(
        tasks.length === 0
          ? "The board has no such tasks."
          : tasks.map(line).join("\n"),
        { tasks: tasks.map((task) => ({ id: task.id, number: task.number })) },
      );
    },
  });

  const get = defineTool({
    name: "get_task",
    label: "get_task",
    description:
      "One task in full: its description, who it is assigned to and its timeline (comments, " +
      "status changes, published artifacts).",
    parameters: Type.Object({
      task: Type.String({ description: "The task's number (12 or #12) or id" }),
    }),
    execute(args) {
      try {
        const task = taskOf(args.task);
        const timeline = board.activity(task.id).map(entry).join("\n");
        return text(
          `${line(task)}\n\n${task.description}\n\nTimeline:\n${timeline}`,
          { id: task.id, number: task.number },
        );
      } catch (error) {
        return failure(error);
      }
    },
  });

  const create = defineTool({
    name: "create_task",
    label: "create_task",
    description:
      "Create a task on the board at once, linked to this conversation. Only when the user " +
      "explicitly asked for a task: otherwise propose it with draft_task and let them decide. " +
      "Assigned to `user`, the task waits for them.",
    parameters: Type.Object({
      title: Type.String({ description: "A short title" }),
      description: Type.Optional(Type.String({ description: "What it is" })),
      status: Type.Optional(
        Type.String({
          description:
            "backlog, todo, in_progress, in_review, done, blocked or cancelled; todo by default",
        }),
      ),
      assignee: Type.Optional(
        Type.String({ description: "none (the default) or user" }),
      ),
    }),
    execute(args) {
      try {
        const task = board.create(
          { ...args, conversationId: who.conversationId },
          actor,
        );
        return text(`Created task #${task.number} "${task.title}".`, {
          id: task.id,
          number: task.number,
        });
      } catch (error) {
        return failure(error);
      }
    },
  });

  const update = defineTool({
    name: "update_task",
    label: "update_task",
    description:
      "Change a task's title, description, status or assignee. Only the fields you give change.",
    parameters: Type.Object({
      task: Type.String({ description: "The task's number (12 or #12) or id" }),
      title: Type.Optional(Type.String()),
      description: Type.Optional(Type.String()),
      status: Type.Optional(
        Type.String({
          description:
            "backlog, todo, in_progress, in_review, done, blocked or cancelled",
        }),
      ),
      assignee: Type.Optional(Type.String({ description: "none or user" })),
    }),
    execute(args) {
      try {
        const { task: which, ...fields } = args;
        const task = board.update(taskOf(which).id, fields, actor);
        return text(
          `#${task.number} is now [${task.status}] "${task.title}".`,
          {
            id: task.id,
            status: task.status,
          },
        );
      } catch (error) {
        return failure(error);
      }
    },
  });

  const comment = defineTool({
    name: "comment_task",
    label: "comment_task",
    description:
      "Comment on a task. The comment is on its timeline and in its card.",
    parameters: Type.Object({
      task: Type.String({ description: "The task's number (12 or #12) or id" }),
      body: Type.String({ description: "What to say" }),
    }),
    execute(args) {
      try {
        const task = taskOf(args.task);
        board.comment(task.id, args.body, actor);
        return text(`Commented on #${task.number}.`, { id: task.id });
      } catch (error) {
        return failure(error);
      }
    },
  });

  // The task tools read and write rows, not files: they need no execution environment.
  const none = (): undefined => undefined;
  return [
    toKernelTool(draft, none),
    toKernelTool(list, none),
    toKernelTool(get, none),
    toKernelTool(create, none),
    toKernelTool(update, none),
    toKernelTool(comment, none),
  ] as KernelTool[];
}
