import type {
  BoardTaskView,
  TaskActivityView,
  TaskActor,
  TaskWorkspaceMode,
} from "@eta/client-contracts";
import type { KernelTool } from "@eta/core";
import type { ToolResult } from "@eta/harness";
/**
 * The task tools: what an agent can do with the board.
 *
 * Registered on each session when it opens, so a tool knows which agent it speaks for and where
 * without being told. An agent in a conversation proposes work (`draft_task`) or, when asked to,
 * makes it (`create_task`); the agent that made a task executes it, in a session of its own
 * (`task-run:` in `run-key.ts`), and that session reports with `comment_task` and `finish_task`.
 * The tools are thin: the rules are the board's (`board.ts`), these only read what a model sends
 * and say, in words, what happened. What a model reads is the description and nothing else, so the
 * descriptions carry the discipline, and `draft_task` leads with the conditions that oblige a
 * model to use it rather than with what it is: work that leaves the conversation goes to the
 * board, where the user confirms it, and `create_task` is for when the user asked for a task.
 */
import type { AgentStore } from "../agents/store";
import type { SessionHooks } from "../session-hooks";
import type { TaskBoard } from "./board";
import type { TaskRunner } from "./runner";
import type { TaskRecord } from "./store";
import { TASK_WORKSPACE_MODES } from "@eta/client-contracts";
import { defineTool, text, toKernelTool, toolError } from "@eta/harness";
import { Type } from "typebox";
import { runIdOf } from "./run-key";

/** A failure the model can act on, from anything the board refused. */
function failure(error: unknown): ToolResult {
  return toolError(error instanceof Error ? error.message : String(error));
}

/** What the tools need to know about the places tasks run in. */
export interface WorkspaceChoice {
  /**
   * The workspace a task proposed in a conversation gets: what the agent asked for, or, when it
   * did not say, a worktree for a project that is a git repository and the directory itself for
   * one that is not. Refuses a worktree in a project that has no repository.
   */
  (
    conversationId: string,
    requested: TaskWorkspaceMode | undefined,
  ): Promise<TaskWorkspaceMode>;
}

export interface TaskToolDeps {
  board: TaskBoard;
  agents: AgentStore;
  runner: TaskRunner;
  workspaceFor: WorkspaceChoice;
}

/** The task tools of every session that is an agent in a conversation, or the executor of a task. */
export function taskSessionTools(
  deps: TaskToolDeps,
): NonNullable<SessionHooks["sessionTools"]> {
  return ({ meta }) => {
    if (meta.agentId === undefined || meta.conversationId === undefined)
      return [];
    const runId = runIdOf(meta.conversationId);
    return runId === undefined
      ? conversationTools(deps, {
          agentId: meta.agentId,
          conversationId: meta.conversationId,
        })
      : runTools(deps, { agentId: meta.agentId, runId });
  };
}

const workspaceParameter = Type.Optional(
  Type.Union(
    TASK_WORKSPACE_MODES.map((mode) => Type.Literal(mode)),
    {
      description:
        "Where the executor works: `worktree` (a git worktree of the project on its own branch, " +
        "kept after the run; the default for a git project) or `local` (the project directory " +
        "itself; the only choice when the project is not a git repository)",
    },
  ),
);

/** The reading tools every task session has, and the helpers they share. */
function reading(deps: TaskToolDeps) {
  const { board, agents } = deps;
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
    `${task.runStatus === null ? "never run" : `run ${task.runStatus}`}, ` +
    `created by ${whoIs(task.createdBy)}`;

  const entry = (activity: TaskActivityView): string => {
    const { data } = activity;
    const said =
      activity.body ??
      (activity.kind === "status" || activity.kind === "title"
        ? `${String(data.from)} -> ${String(data.to)}`
        : activity.kind === "artifact"
          ? `"${String(data.title)}" version ${String(data.version)}`
          : "");
    return (
      `${new Date(activity.createdAt).toISOString()} [${activity.kind}] ` +
      `${whoIs(activity.actor)}${said === "" ? "" : `: ${said}`}`
    );
  };

  const list = defineTool({
    name: "list_tasks",
    label: "list_tasks",
    description: "List the tasks on the board, the one touched last first.",
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
      "One task in full: its description, where it is worked on, its runs and its timeline " +
      "(comments, status changes, published artifacts).",
    parameters: Type.Object({
      task: Type.String({ description: "The task's number (12 or #12) or id" }),
    }),
    execute(args) {
      try {
        const record = taskOf(args.task);
        const task = board.detail(record.id)!;
        const timeline = board.activity(task.id).map(entry).join("\n");
        const where =
          task.workspace.mode === "worktree"
            ? `a git worktree${task.workspace.path === null ? "" : ` at ${task.workspace.path}`} on branch eta/task-${task.number}`
            : "the project directory";
        const runs = task.runs
          .map(
            (run) =>
              `${new Date(run.createdAt).toISOString()} ${run.status}${run.error === null ? "" : ` (${run.error})`}`,
          )
          .join("\n");
        return text(
          `${line(task)}\nWorks in ${where}.\n\n${task.description}\n\nRuns:\n${runs === "" ? "(none)" : runs}\n\nTimeline:\n${timeline}`,
          { id: task.id, number: task.number },
        );
      } catch (error) {
        return failure(error);
      }
    },
  });

  return { whoIs, taskOf, list, get };
}

function conversationTools(
  deps: TaskToolDeps,
  who: { agentId: string; conversationId: string },
): KernelTool[] {
  const { board, workspaceFor } = deps;
  const actor: TaskActor = { kind: "agent", agentId: who.agentId };
  const { taskOf, list, get } = reading(deps);

  // Debt, not settled here: `DEFAULT_SYSTEM_PROMPT` (packages/eta-harness/src/prompts/base.ts)
  // points the other way — "the moment you feel something is bigger than one step, you open the
  // todo" sends work that has outgrown a reply to the session's own list instead of to the board,
  // which is where the user can see it. Fixing that means touching the base prompt, so it waits
  // for its own change. It is easy to miss because the two things are called the same word: the
  // session's todo items are `Task` in `client-contracts/src/data.ts`, and the board's are `Task`
  // in `client-contracts/src/tasks.ts`, whose own comment says the two "have nothing in common
  // but the word".
  const draft = defineTool({
    name: "draft_task",
    label: "draft_task",
    description:
      "Work that leaves this conversation. Do not do it in chat if it will change files in the " +
      "repo, run a build or tests, need the user to accept a result, or take more than a couple of " +
      "tool rounds — draft it; the user decides. What stays in chat: reading, looking things up, " +
      "explaining, asking, taking a position, checking a command or two. `mention` is handing work " +
      "to a person; this tool hands it to the board. A draft is not your step list: it is the " +
      "board's proposal. The user edits and confirms it, then you do it yourself in a fresh " +
      "session that cannot see this conversation — so write the goal and acceptance for a reader " +
      "who knows nothing else, and put what you have established in `decided`. In a discussion, " +
      "prefer it to `create_task`.",
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
      workspace: workspaceParameter,
    }),
    async execute(args) {
      try {
        const workspace = await workspaceFor(
          who.conversationId,
          args.workspace,
        );
        const row = board.draft({
          conversationId: who.conversationId,
          agentId: who.agentId,
          draft: { ...args, workspace },
        });
        return text(
          `Drafted "${args.title}" for the user to confirm; it will run in ${workspace === "worktree" ? "a git worktree" : "the project directory"}.`,
          { messageId: row.id },
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
      "Create a task on the board at once, linked to this conversation, and start on it: you " +
      "execute the tasks you make, in a fresh session of your own that does not see this " +
      "conversation. Only when the user explicitly asked for a task: otherwise propose it with " +
      "`draft_task` and let the user decide.",
    parameters: Type.Object({
      title: Type.String({ description: "A short title" }),
      description: Type.Optional(
        Type.String({
          description:
            "What it is: the goal, what is decided and how it will be judged done, for a reader who knows nothing else",
        }),
      ),
      status: Type.Optional(
        Type.String({
          description:
            "backlog (made, not started), todo, in_progress, in_review, done, blocked or cancelled; todo by default",
        }),
      ),
      workspace: workspaceParameter,
    }),
    async execute(args) {
      try {
        const workspace = await workspaceFor(
          who.conversationId,
          args.workspace,
        );
        const task = board.create(
          { ...args, workspace, conversationId: who.conversationId },
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
      "Change a task's title, description or status. Only the fields you give change. Moving a " +
      "task to done or cancelled stops its runs.",
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
    }),
    execute(args) {
      try {
        const { task: which, ...fields } = args;
        const task = board.update(taskOf(which).id, fields, actor);
        return text(
          `#${task.number} is now [${task.status}] "${task.title}".`,
          { id: task.id, status: task.status },
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
      "Comment on a task. The comment is on its timeline and in its card, and if a run is " +
      "working on the task it reads the comment and carries on with it.",
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

/** The executor's tools: read the board, say how it is going, and finish. */
function runTools(
  deps: TaskToolDeps,
  who: { agentId: string; runId: string },
): KernelTool[] {
  const { board, runner } = deps;
  const actor: TaskActor = { kind: "agent", agentId: who.agentId };
  const { taskOf, list, get } = reading(deps);

  const taskOfRun = (): TaskRecord => {
    const run = runner.runOf(who.runId);
    if (run === undefined) throw new Error("this run is gone");
    return taskOf(run.taskId);
  };

  const update = defineTool({
    name: "update_task",
    label: "update_task",
    description:
      "Change this task's title, description or status while you work (for example to blocked " +
      "when you wait on something). Only the fields you give change. Moving it to review is " +
      "finish_task's job, and done or cancelled is the user's call.",
    parameters: Type.Object({
      title: Type.Optional(Type.String()),
      description: Type.Optional(Type.String()),
      status: Type.Optional(
        Type.String({
          description: "backlog, todo, in_progress or blocked",
        }),
      ),
    }),
    execute(args) {
      try {
        if (
          args.status === "done" ||
          args.status === "cancelled" ||
          args.status === "in_review"
        )
          throw new Error(
            args.status === "in_review"
              ? "use finish_task to move the task to review"
              : `moving the task to ${args.status} is for the user to decide`,
          );
        const task = board.update(taskOfRun().id, args, actor);
        return text(
          `#${task.number} is now [${task.status}] "${task.title}".`,
          { id: task.id, status: task.status },
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
      "Post a comment on this task: a progress note or a question for the user. It is on the " +
      "task's timeline. It does not end your run; finish_task does.",
    parameters: Type.Object({
      body: Type.String({ description: "What to say" }),
    }),
    execute(args) {
      try {
        const task = taskOfRun();
        // Your own comment is not sent back to you.
        board.comment(task.id, args.body, actor, { deliver: false });
        return text(`Commented on #${task.number}.`, { id: task.id });
      } catch (error) {
        return failure(error);
      }
    },
  });

  const finish = defineTool({
    name: "finish_task",
    label: "finish_task",
    description:
      "Say that you are done with this task, or that you cannot go on without the user. The " +
      "summary becomes a comment on the task and is posted in the conversation the task came " +
      "from, in your name, and the task moves to review for the user to accept. Say what you " +
      "did, the result (the branch, files, anything to look at) and what the user should check. " +
      "Call it when you are done: a run that stops without it is reminded once, then fails.",
    parameters: Type.Object({
      summary: Type.String({
        description: "What you did, the result, and what to check",
      }),
      status: Type.Optional(
        Type.Union([Type.Literal("in_review"), Type.Literal("blocked")], {
          description:
            "in_review (the default) when the work is done; blocked when you cannot go on without the user",
        }),
      ),
    }),
    execute(args) {
      try {
        return text(
          runner.submit(who.runId, {
            summary: args.summary,
            status: args.status ?? "in_review",
          }),
        );
      } catch (error) {
        return failure(error);
      }
    },
  });

  const none = (): undefined => undefined;
  return [
    toKernelTool(list, none),
    toKernelTool(get, none),
    toKernelTool(update, none),
    toKernelTool(comment, none),
    toKernelTool(finish, none),
  ] as KernelTool[];
}
