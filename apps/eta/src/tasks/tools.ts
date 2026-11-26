import type {
  BoardTaskView,
  TaskActivityView,
  TaskActor,
  TaskDependencyView,
  TaskRefView,
  TaskWorkspaceMode,
} from "@eta/client-contracts";
import type { KernelTool } from "@eta/core";
import type { ToolResult } from "@eta/harness";
/**
 * The task tools: what an agent can do with the board.
 *
 * Registered on each session when it opens, so a tool knows which agent it speaks for and where
 * without being told. An agent in a conversation proposes work (`draft_task`) or, when asked to,
 * makes it (`create_task`); the task's executor (its `assignee`, or the maker when none is set)
 * executes it, in a session of its own (`task:` in `session-owner.ts`), and that session reports
 * with `comment_task` and `finish_task`. An agent the user mentions on a task answers in a session
 * of its own on it, with `comment_task` only.
 * Which run of the task that session is working on is asked when a tool is called, not when the
 * session opened: a session outlives its runs, since a comment that arrives later wakes another one
 * in the same session.
 * The tools are thin: the rules are the board's (`board.ts`), these only read what a model sends
 * and say, in words, what happened. What a model reads is the description and nothing else, so the
 * descriptions carry the discipline, and `draft_task` leads with the conditions that oblige a
 * model to use it rather than with what it is: work that leaves the conversation goes to the
 * board, where the user confirms it, and `create_task` is for when the user asked for a task.
 */
import type { AgentStore } from "../agents/store";
import type { SessionHooks } from "../session-hooks";
import type { TaskAsks } from "./asks";
import type { TaskBoard } from "./board";
import type { TaskRunner } from "./runner";
import type { RunRecord } from "./runs";
import type { TaskRecord } from "./store";
import {
  archivedEntry,
  dependencyEntry,
  parentEntry,
  subtaskEntry,
  TASK_DRAFT_STATUSES,
  TASK_WORKSPACE_MODES,
  unarchivedEntry,
} from "@eta/client-contracts";
import { defineTool, text, toKernelTool, toolError } from "@eta/harness";
import { Type } from "typebox";
import { taskOf } from "../session-owner";
import { ARCHIVED_RULE, archivedNote, archivedSaid } from "./archived";
import { executorOf } from "./store";

/** A failure the model can act on, from anything the board refused. */
function failure(error: unknown): ToolResult {
  return toolError(error instanceof Error ? error.message : String(error));
}

function normalizeAssignee(assignee: string | undefined): string | undefined {
  const trimmed = assignee?.trim() ?? "";
  return trimmed === "" ? undefined : trimmed;
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
  /** Where the executor's questions go to the agent that made the task first. */
  asks?: Pick<TaskAsks, "answer" | "escalate">;
  workspaceFor: WorkspaceChoice;
  captain?: {
    isCaptain: (agentId: string) => boolean;
  };
}

/** The task tools of every session that is an agent in a conversation, or the executor of a task. */
export function taskSessionTools(
  deps: TaskToolDeps,
): NonNullable<SessionHooks["sessionTools"]> {
  return ({ meta }) => {
    if (meta.agentId === undefined || meta.conversationId === undefined)
      return [];
    if (deps.captain?.isCaptain(meta.agentId)) return [];
    const taskId = taskOf(
      meta.conversationId,
      (runId) => deps.runner.runOf(runId)?.taskId,
    );
    if (taskId === undefined)
      return conversationTools(deps, {
        agentId: meta.agentId,
        conversationId: meta.conversationId,
      });
    // A session of the task that is not its executor's is an agent mentioned on it: the
    // executor is the assignee when one was named, which is not always the maker.
    const task = deps.board.find(taskId);
    const executor = task === undefined ? undefined : executorOf(task);
    return executor === meta.agentId
      ? runTools(deps, { agentId: meta.agentId, taskId })
      : mentionedTools(deps, {
          agentId: meta.agentId,
          taskId,
          maker: task?.createdBy.agentId === meta.agentId,
        });
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

/** What a task waits for, as a model names it; the board checks it (`graph.ts` says what is refused). */
const dependsOnParameter = Type.Optional(
  Type.Array(
    Type.Object({
      task: Type.String({
        description: "The task waited for: its number (12 or #12) or id",
      }),
      requireDone: Type.Optional(
        Type.Boolean({
          description:
            "Only done resolves it. By default the other task in review is enough to start.",
        }),
      ),
    }),
    {
      description:
        "Tasks this one waits for: its work starts only once every one of them is in review or " +
        "done (done only, with requireDone). Use it to order work that builds on other work; " +
        "independent tasks run in parallel. With exactly one dependency in the same project and " +
        "no base, the worktree starts from that task's branch. A cycle, or a cancelled task, is " +
        "refused.",
    },
  ),
);

/** The task a new one is part of, as a model names it. */
const parentParameter = Type.Optional(
  Type.String({
    description:
      "The task this one is a subtask of: its number (12 or #12) or id. A task with subtasks " +
      "does not run itself; its status comes from them, and waiting for it is waiting for all of " +
      "them. A subtask waits for what its parent waits for. Use it to split work into stages: a " +
      "stage is a parent task, and a stage that depends on another holds all its subtasks back. " +
      "Make a stage's parent task with status backlog, then its subtasks under it: a parent made " +
      "todo starts running at once, before it has subtasks; made backlog, it takes its status " +
      "from them as they come.",
  }),
);

/** One edge in words: `#12 [in_review] Title (resolved, done required)`. */
const edgeLine = (edge: TaskDependencyView): string =>
  `#${edge.number} [${edge.status}] ${edge.title} (${edge.state}${edge.requireDone ? ", done required" : ""})`;

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

  const nameOf = (agentId: string): string =>
    agents.get(agentId)?.name ?? "a deleted agent";

  /** Who archived the task and when, in words; undefined when it is not archived. */
  const archived = (task: BoardTaskView): string | undefined =>
    archivedSaid(task, board.activity(task.id), nameOf);

  /** The note the tools that write on a task add for an archived one (`archived.ts`). */
  const note = () => archivedNote(board, nameOf);

  /** One line: what a model can read without asking for the task. */
  const line = (task: BoardTaskView): string => {
    const waits = task.waitingOn ?? [];
    const parent =
      task.parentId == null ? undefined : board.find(task.parentId);
    const away = archived(task);
    return (
      `#${task.number} [${task.status}]${away === undefined ? "" : " [archived]"} ${task.title} — ` +
      `${task.runStatus === null ? "never run" : `run ${task.runStatus}`}, ` +
      `created by ${whoIs(task.createdBy)}${
        task.assigneeAgentId === null
          ? ""
          : `, assigned to ${nameOf(task.assigneeAgentId)}`
      }${parent === undefined ? "" : `; subtask of #${parent.number}`}${
        task.subtasks == null
          ? ""
          : `; subtasks ${task.subtasks.done}/${task.subtasks.total} done`
      }${
        waits.length === 0
          ? ""
          : `; waits for ${waits.map((edge) => `#${edge.number}${edge.state === "cancelled" ? " (cancelled)" : ""}${edge.via === null ? "" : ` (via #${edge.via})`}`).join(", ")}`
      }${away === undefined ? "" : `; archived: ${away}`}`
    );
  };

  /** A `dependency` entry in words: the host writes only its data, and a model reads English. */
  const dependencySaid = (data: TaskActivityView["data"]): string | null => {
    const read = dependencyEntry(data);
    if (read === undefined) return null;
    const other = `#${read.number} "${read.title}"`;
    switch (read.action) {
      case "added":
        return `Waits for ${other}${read.requireDone ? " (only done resolves it)" : ""}.`;
      case "required":
        return read.requireDone
          ? `Waits for ${other} to be done, not only in review.`
          : `Waits for ${other} to be in review or done.`;
      case "removed":
        return `No longer waits for ${other}.`;
      case "deleted":
        return `${other} was deleted, so this task no longer waits for it.`;
      case "blocked":
        return `${other} was cancelled, and this task waits for it, so it will not start on its own. Remove the dependency to let it start, or cancel this task.`;
      case "unblocked":
        return "No dependency of this task is cancelled any more, so it goes back to todo and its work starts once what it waits for is resolved.";
    }
  };

  /** A `parent` or `subtask` entry in words, from its data, like `dependencySaid`. */
  const treeSaid = (activity: TaskActivityView): string | null => {
    const named = (ref: { number: number; title: string }) =>
      `#${ref.number} "${ref.title}"`;
    if (activity.kind === "parent") {
      const read = parentEntry(activity.data);
      if (read === undefined) return null;
      if (read.to !== null) return `A subtask of ${named(read.to)}.`;
      return read.deleted
        ? `${named(read.from!)} was deleted, so this task is no longer a subtask of it.`
        : `No longer a subtask of ${named(read.from!)}.`;
    }
    if (activity.kind !== "subtask") return null;
    const read = subtaskEntry(activity.data);
    if (read === undefined) return null;
    switch (read.action) {
      case "added":
        return `${named(read.task)} is a subtask of this task.`;
      case "removed":
        return `${named(read.task)} is no longer a subtask of this task.`;
      case "deleted":
        return `Subtask ${named(read.task)} was deleted.`;
      case "all_cancelled":
        return "Every subtask of this task is cancelled, so there is nothing left to work on. Add a subtask, or decide what becomes of this task.";
    }
  };

  /** An `archived` or `unarchived` entry in words, from its data, like `dependencySaid`. */
  const archiveSaid = (activity: TaskActivityView): string | null => {
    if (activity.kind === "archived") {
      const read = archivedEntry(activity.data);
      const why =
        read.reason === "stale"
          ? `done or cancelled and quiet for ${read.days ?? "?"} days`
          : "put away by hand";
      return `Archived (${why})${read.with === null ? "" : ` with #${read.with.number}`}: off the board's lists until something new happens on it.`;
    }
    if (activity.kind !== "unarchived") return null;
    const read = unarchivedEntry(activity.data);
    return read.cause === "manual"
      ? `Back on the board${read.with === null ? "" : ` with #${read.with.number}`}.`
      : `Back on the board: something new happened on it (${read.cause}).`;
  };

  const entry = (activity: TaskActivityView): string => {
    const { data } = activity;
    const said =
      (activity.kind === "dependency"
        ? dependencySaid(data)
        : (treeSaid(activity) ?? archiveSaid(activity))) ??
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
    description:
      "List the tasks on the board, the one touched last first. Archived tasks (put away, usually done long ago) are left out unless `archived` asks for them; " +
      "each archived one is marked [archived] and says who archived it and when.",
    parameters: Type.Object({
      status: Type.Optional(
        Type.String({ description: "Only the tasks in this status" }),
      ),
      archived: Type.Optional(
        Type.Union([Type.Literal("only"), Type.Literal("include")], {
          description:
            "`include` lists archived tasks too, `only` lists them alone",
        }),
      ),
    }),
    execute(args) {
      const tasks = board
        .list({ archived: args.archived })
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
      "(comments, status changes, published artifacts), and whether it is archived, by whom and when.",
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
        const ref = (t: TaskRefView): string =>
          `#${t.number} [${t.status}] ${t.title}`;
        const graph = [
          (task.ancestors ?? []).length === 0
            ? undefined
            : `Part of: ${task.ancestors!.map(ref).join(" › ")}`,
          (task.children ?? []).length === 0
            ? undefined
            : `Subtasks (its status comes from them):\n${task.children!.map(ref).join("\n")}`,
          (task.dependsOn ?? []).length === 0
            ? undefined
            : `Waits for:\n${task.dependsOn!.map(edgeLine).join("\n")}`,
          (task.dependents ?? []).length === 0
            ? undefined
            : `Waited for by:\n${task.dependents!.map(edgeLine).join("\n")}`,
        ].filter((part) => part !== undefined);
        const away = archived(task);
        const archivedPart =
          away === undefined
            ? ""
            : `\nArchived: ${away}. Changing or commenting on it brings it back onto the board.`;
        return text(
          `${line(task)}${archivedPart}\nWorks in ${where}.\n\n${task.description}\n\n${graph.length === 0 ? "" : `${graph.join("\n\n")}\n\n`}Runs:\n${runs === "" ? "(none)" : runs}\n\nTimeline:\n${timeline}`,
          { id: task.id, number: task.number },
        );
      } catch (error) {
        return failure(error);
      }
    },
  });

  return { whoIs, taskOf, nameOf, list, get, note };
}

function conversationTools(
  deps: TaskToolDeps,
  who: { agentId: string; conversationId: string },
): KernelTool[] {
  const { board, workspaceFor } = deps;
  const actor: TaskActor = { kind: "agent", agentId: who.agentId };
  const { taskOf, nameOf, list, get, note } = reading(deps);
  const archivedNotice = note();

  // The debt this comment used to record is paid on the prompt side. The session's own list is
  // now "steps" (`create_step` / `update_step` / `list_steps` / `get_step`), the base prompt says
  // a step stays in this session, and the platform block tells a model that work which changes
  // files, runs a build or tests, or needs the user to accept a result is proposed here instead of
  // being kept as a step. The kernel type is still `Task`: those names are what the journal writes
  // to disk, so they are not ours to rename.
  const draft = defineTool({
    name: "draft_task",
    label: "draft_task",
    description:
      "Work that leaves this conversation. Do not do it in chat if it will change files in the " +
      "repo, run a build or tests, need the user to accept a result, or take more than a couple of " +
      "tool rounds — draft it; the user decides. What stays in chat: reading, looking things up, " +
      "explaining, asking, taking a position, checking a command or two. `mention` is handing work " +
      "to a person; this tool hands it to the board. A draft is not your step list: it is the " +
      "board's proposal. The user edits and confirms it, then the executor (you, or `assignee` if " +
      "specified) runs it in a fresh session that cannot see this conversation — so write the goal " +
      "and acceptance for a reader " +
      "who knows nothing else, and put what you have established in `decided`. This is how work " +
      "leaves a conversation: `create_task` is for when the user named a task themselves. " +
      "By default a confirmed draft starts at once; give `status: backlog` for work to plan now " +
      "and leave for the user to start, which puts it on the board without running it.",
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
            "The messages it came from, as plain text, e.g. messages 12–18. Defaults to the message " +
            "that woke you through the present.",
        }),
      ),
      status: Type.Optional(
        Type.Union(
          TASK_DRAFT_STATUSES.map((status) => Type.Literal(status)),
          {
            description:
              "Where the task goes once the user confirms it: `todo` (the default) starts it at " +
              "once; `backlog` only puts it on the board, for work that is planned now and waits " +
              "for the user to start it by moving it to todo. The user can change it on the card.",
          },
        ),
      ),
      workspace: workspaceParameter,
      base: Type.Optional(
        Type.String({
          description:
            "A branch name, a commit, or `#N` naming another task, that the task's worktree " +
            "starts at. Write it whenever the work does not belong to the project checkout's " +
            "current line: an executor in an isolated session cannot guess it. Absent is the " +
            "project checkout's HEAD.",
        }),
      ),
      assignee: Type.Optional(
        Type.String({
          description:
            "The agent this work is for, when it is not you: its name or its id. In a group, it " +
            "must name a member of that group (never Captain), and is resolved to the agent's " +
            "registry id when written; absent is you, the proposer, which executes it itself.",
        }),
      ),
      dependsOn: dependsOnParameter,
      parent: parentParameter,
    }),
    async execute(args) {
      try {
        const workspace = await workspaceFor(
          who.conversationId,
          args.workspace,
        );
        const { base, assignee: rawAssignee, ...rest } = args;
        const assignee = normalizeAssignee(rawAssignee);
        const row = board.draft({
          conversationId: who.conversationId,
          agentId: who.agentId,
          draft: {
            ...rest,
            workspace,
            base,
            assignee,
          },
        });
        const later = args.status === "backlog";
        const resolvedAssignee =
          typeof row.data.assignee === "string"
            ? nameOf(row.data.assignee)
            : assignee;
        return text(
          `Drafted "${args.title}" for the user to confirm${later ? "; once confirmed it waits in the backlog until the user starts it, and" : ";"} it will run in ${workspace === "worktree" ? "a git worktree" : "the project directory"}${base === undefined ? "" : ` based on ${base}`}${resolvedAssignee === undefined ? "" : `, executed by ${resolvedAssignee}`}.`,
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
      "Create a task on the board at once, linked to this conversation, and start on it: the " +
      "executor (you, or `assignee` if specified) runs it in a fresh session that does not see " +
      "this conversation. Drafting first is the rule, not a suggestion: unless the user named the " +
      "task themselves, propose it with `draft_task` and let the user decide.",
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
      base: Type.Optional(
        Type.String({
          description:
            "A branch name, a commit, or `#N` naming another task, that the task's worktree " +
            "starts at. Write it whenever the work does not belong to the project checkout's " +
            "current line: an executor in an isolated session cannot guess it. Absent is the " +
            "project checkout's HEAD.",
        }),
      ),
      assignee: Type.Optional(
        Type.String({
          description:
            "The agent this work is for, when it is not you: its name or its id. In a group, it " +
            "must name a member of that group (never Captain), and is resolved to the agent's " +
            "registry id when written; absent is you, the maker, which executes it itself.",
        }),
      ),
      dependsOn: dependsOnParameter,
      parent: parentParameter,
    }),
    async execute(args) {
      try {
        const workspace = await workspaceFor(
          who.conversationId,
          args.workspace,
        );
        const { base, assignee: rawAssignee, ...rest } = args;
        const assignee = normalizeAssignee(rawAssignee);
        const task = board.create(
          {
            ...rest,
            workspace,
            base,
            assignee,
            conversationId: who.conversationId,
          },
          actor,
        );
        return text(
          `Created task #${task.number} "${task.title}"${
            task.assigneeAgentId === null
              ? ""
              : `, executed by ${nameOf(task.assigneeAgentId)}`
          }.`,
          {
            id: task.id,
            number: task.number,
          },
        );
      } catch (error) {
        return failure(error);
      }
    },
  });

  const update = defineTool({
    name: "update_task",
    label: "update_task",
    description:
      `Change a task's title, description or status, or what it waits for. Only the fields you ` +
      `give change. This cannot change a task's assignee (ownership is set at creation). ` +
      `Moving a task to done or cancelled stops its runs. ${ARCHIVED_RULE}`,
    parameters: Type.Object(
      {
        task: Type.String({
          description: "The task's number (12 or #12) or id",
        }),
        title: Type.Optional(Type.String()),
        description: Type.Optional(Type.String()),
        status: Type.Optional(
          Type.String({
            description:
              "backlog, todo, in_progress, in_review, done, blocked or cancelled",
          }),
        ),
        parent: Type.Optional(
          Type.String({
            description:
              "Make it a subtask of this task (number or id), or of none with an empty string",
          }),
        ),
        addDependencies: dependsOnParameter,
        removeDependencies: Type.Optional(
          Type.Array(Type.String(), {
            description:
              "Tasks this one should no longer wait for: numbers (12 or #12) or ids",
          }),
        ),
      },
      { additionalProperties: false },
    ),
    execute(args) {
      try {
        const {
          task: which,
          parent,
          addDependencies,
          removeDependencies,
          ...fields
        } = args;
        const id = taskOf(which).id;
        const archived = archivedNotice.before(id);
        if (parent !== undefined)
          board.setParent(id, parent.trim() === "" ? null : parent, actor);
        for (const other of removeDependencies ?? [])
          board.removeDependency(id, other, actor);
        for (const edge of addDependencies ?? [])
          board.addDependency(
            id,
            edge.task,
            { requireDone: edge.requireDone },
            actor,
          );
        const task = board.update(id, fields, actor);
        return text(
          `#${task.number} is now [${task.status}] "${task.title}".${archived?.after() ?? ""}`,
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
      `Comment on a task. The comment is on its timeline and in its card, and if a run is ` +
      `working on the task it reads the comment and carries on with it. ${
        ARCHIVED_RULE
      }`,
    parameters: Type.Object({
      task: Type.String({ description: "The task's number (12 or #12) or id" }),
      body: Type.String({ description: "What to say" }),
    }),
    execute(args) {
      try {
        const task = taskOf(args.task);
        const archived = archivedNotice.before(task.id);
        board.comment(task.id, args.body, actor);
        return text(`Commented on #${task.number}.${archived?.after() ?? ""}`, {
          id: task.id,
        });
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

/** A mentioned agent's tools: read the board, and answer in the task's thread. */
function mentionedTools(
  deps: TaskToolDeps,
  who: { agentId: string; taskId: string; maker: boolean },
): KernelTool[] {
  const { runner, asks } = deps;
  const { list, get, note } = reading(deps);
  const archivedNotice = note();

  const answer = defineTool({
    name: "comment_task",
    label: "comment_task",
    description:
      `Answer in this task's thread, in your name: what you were asked for, said once and in ` +
      `full. The user and the executor read it there. After it, stop: you are woken again when ` +
      `you are mentioned again. ${ARCHIVED_RULE}`,
    parameters: Type.Object({
      body: Type.String({ description: "Your answer" }),
    }),
    execute(args) {
      try {
        const archived = archivedNotice.before(who.taskId);
        return text(
          `${runner.answer(who.taskId, who.agentId, args.body)}${archived?.after() ?? ""}`,
          { id: who.taskId },
        );
      } catch (error) {
        return failure(error);
      }
    },
  });

  const answerQuestion = defineTool({
    name: "answer_task_question",
    label: "answer_task_question",
    description:
      "Answer, for the user, a question the executor of a task you made asked. Only when the task's " +
      "description, the project's memory or an earlier decision settles it; the question, your " +
      "answer and your basis are written on the task's timeline for the user to check.",
    parameters: Type.Object({
      interactionId: Type.String({ description: "The question's id" }),
      text: Type.Optional(
        Type.String({ description: "Your answer, in words" }),
      ),
      selections: Type.Optional(
        Type.Array(Type.String(), {
          description: "Your answer, as options of the question",
        }),
      ),
      basis: Type.String({
        description:
          "One sentence: what in the task, the memory or a decision settles it",
      }),
    }),
    async execute(args) {
      try {
        return text(await asks!.answer(who.agentId, args));
      } catch (error) {
        return failure(error);
      }
    },
  });

  const escalateQuestion = defineTool({
    name: "escalate_task_question",
    label: "escalate_task_question",
    description:
      "Send a question of the executor of a task you made to the user, and stop. For anything that " +
      "cannot be undone, spends money, sends something outside, deletes, grants access, is the " +
      "user's own preference, or that you are not sure of.",
    parameters: Type.Object({
      interactionId: Type.String({ description: "The question's id" }),
      reason: Type.String({
        description: "Why it needs the user, in a few words",
      }),
    }),
    execute(args) {
      try {
        return text(
          asks!.escalate(who.agentId, args.interactionId, args.reason),
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
    toKernelTool(answer, none),
    ...(who.maker && asks !== undefined
      ? [
          toKernelTool(answerQuestion, none),
          toKernelTool(escalateQuestion, none),
        ]
      : []),
  ] as KernelTool[];
}

/** The executor's tools: read the board, say how it is going, and finish. */
function runTools(
  deps: TaskToolDeps,
  who: { agentId: string; taskId: string },
): KernelTool[] {
  const { board, runner } = deps;
  const actor: TaskActor = { kind: "agent", agentId: who.agentId };
  const { taskOf, nameOf, list, get, note } = reading(deps);
  const archivedNotice = note();

  const task = (): TaskRecord => taskOf(who.taskId);

  /**
   * The run this session is working on, asked each time: the session is the task's and outlives a
   * run, so the tools made when it was opened are still there when a later run of the same task is
   * called upon them.
   */
  const workingRun = (): RunRecord => {
    const run = runner.workingRunOf(who.taskId);
    if (run === undefined)
      throw new Error(
        "no run of this task is going, so there is nothing to report to",
      );
    return run;
  };

  const update = defineTool({
    name: "update_task",
    label: "update_task",
    description:
      `Change this task's title, description or status while you work (for example to blocked ` +
      `when you wait on something). Only the fields you give change. This cannot change the ` +
      `task's assignee. Moving it to review is finish_task's job, and done or cancelled is the ` +
      `user's call. ${ARCHIVED_RULE}`,
    parameters: Type.Object(
      {
        title: Type.Optional(Type.String()),
        description: Type.Optional(Type.String()),
        status: Type.Optional(
          Type.String({
            description: "backlog, todo, in_progress or blocked",
          }),
        ),
      },
      { additionalProperties: false },
    ),
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
        const archived = archivedNotice.before(who.taskId);
        const updated = board.update(task().id, args, actor);
        return text(
          `#${updated.number} is now [${updated.status}] "${updated.title}".${archived?.after() ?? ""}`,
          { id: updated.id, status: updated.status },
        );
      } catch (error) {
        return failure(error);
      }
    },
  });

  const subtask = defineTool({
    name: "create_subtask",
    label: "create_subtask",
    description:
      "Split this task: make a subtask of it, which starts on its own (in a session of its own) " +
      "once what it waits for is resolved. Make every subtask the work needs, ordering them with " +
      "dependsOn (subtasks without dependencies on each other run in parallel; a closing subtask " +
      "that depends on the others pulls the work together). This task then does not run itself " +
      "any more: its status comes from its subtasks. When the subtasks are made, call finish_task " +
      "saying how you split the work; that ends this run.",
    parameters: Type.Object({
      title: Type.String({ description: "A short title" }),
      description: Type.String({
        description:
          "What it is: the goal, what is decided and how it will be judged done, for a reader who knows nothing else",
      }),
      dependsOn: dependsOnParameter,
      assignee: Type.Optional(
        Type.String({
          description:
            "The agent that executes it, by name or id (never Captain; when this task belongs to " +
            "a group, it must be a member of that group). Absent is you, the executor of this task",
        }),
      ),
      base: Type.Optional(
        Type.String({
          description:
            "A branch, a commit, or `#N`, its worktree starts at. Absent with exactly one dependency in this project: that task's branch; else the project checkout's HEAD.",
        }),
      ),
    }),
    execute(args) {
      try {
        workingRun();
        const parent = task();
        const conversationId =
          parent.conversationId ?? parent.originConversationId;
        if (conversationId === null)
          throw new Error(
            "this task is in no conversation, so it has nowhere to make subtasks",
          );
        const assignee = normalizeAssignee(args.assignee);
        const made = board.create(
          {
            title: args.title,
            description: args.description,
            status: "todo",
            conversationId,
            workspace: parent.workspaceMode,
            base: args.base,
            assignee,
            dependsOn: args.dependsOn,
            parent: parent.id,
            ...(parent.captainAssignmentId === null
              ? {}
              : {
                  captainAssignmentId: parent.captainAssignmentId,
                  captainMessageId: parent.captainMessageId,
                }),
          },
          actor,
        );
        const waits = made.waitingOn ?? [];
        return text(
          `Created subtask #${made.number} "${made.title}" of #${parent.number}${
            made.assigneeAgentId === null
              ? ""
              : `, executed by ${nameOf(made.assigneeAgentId)}`
          }${
            waits.length === 0
              ? "; it starts now"
              : `; it waits for ${waits.map((w) => `#${w.number}`).join(", ")}`
          }.`,
          { id: made.id, number: made.number },
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
      `Post a comment on this task: a progress note or a question for the user. It is on the ` +
      `task's timeline. It does not end your run; finish_task does. ${
        ARCHIVED_RULE
      }`,
    parameters: Type.Object({
      body: Type.String({ description: "What to say" }),
    }),
    execute(args) {
      try {
        workingRun();
        const archived = archivedNotice.before(who.taskId);
        // Your own comment is not sent back to you, and does not wake the task either.
        board.comment(task().id, args.body, actor, { deliver: false });
        return text(
          `Commented on #${taskOf(who.taskId).number}.${archived?.after() ?? ""}`,
          { id: who.taskId },
        );
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
          runner.submit(workingRun().id, {
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
    toKernelTool(subtask, none),
    toKernelTool(comment, none),
    toKernelTool(finish, none),
  ] as KernelTool[];
}
