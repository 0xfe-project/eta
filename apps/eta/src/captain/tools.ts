import type {
  BoardTaskDetail,
  CaptainPromptKind,
  InboxResponse,
  LlmAccounts,
  LlmModel,
  ProvidersView,
} from "@eta/client-contracts";
import type { KernelTool } from "@eta/core";
import type { AssembledServer, SessionMeta } from "@eta/server";
import type { AgentStore } from "../agents/store";
import type { AttachmentStore } from "../conversations/attachments";
import type { ConversationStore } from "../conversations/store";
import type { Timeline } from "../conversations/timeline";
import type { Inbox } from "../inbox/inbox";
import type { RemoteSessionsRouter } from "../machines/remote-sessions";
import type { ProjectStore } from "../projects/store";
import type { TaskBoard } from "../tasks/board";
import type { TaskRecord, TaskStore } from "../tasks/store";
import type { CaptainMemory } from "./memory";
import type { CaptainService } from "./service";
import { readFile } from "node:fs/promises";
import {
  AGENT_RUNTIMES,
  isAgentRuntime,
  keyMissing,
  LLM_PROVIDER_ID,
  providerLabel,
  TASK_STATUSES,
  TASK_WORKSPACE_MODES,
} from "@eta/client-contracts";
import { defineTool, text, toKernelTool, toolError } from "@eta/harness";
import { Type } from "typebox";
import { interactionId } from "../inbox/store";
import { heldIn } from "../session-owner";
import { ARCHIVED_RULE, archivedNote } from "../tasks/archived";
import { GroupConflictError } from "./propose-group";
import { redactJson, redactText, redactValue } from "./redact";

export interface CaptainToolDeps {
  service: CaptainService;
  agents: AgentStore;
  projects: ProjectStore;
  conversations: ConversationStore;
  timeline: Timeline;
  board: TaskBoard;
  tasks: TaskStore;
  inbox: Inbox;
  attachments: AttachmentStore;
  memory: CaptainMemory;
  server: () => AssembledServer | undefined;
  router: RemoteSessionsRouter;
  answerInbox: (
    interactionId: string,
    response: InboxResponse,
  ) => Promise<{ answered: boolean; interaction: unknown }>;
  dataDir: string;
}

const json = (value: unknown): string => redactJson(value);

// TODO(captain-refactor): Consolidate Captain tools and wire handlers behind shared action
// descriptors so schemas, authorization and execution are defined once. Until then, avoid adding
// another duplicated tool/wire adapter with only a presentation-layer difference.
export function captainSessionTools(
  deps: CaptainToolDeps,
): (input: { meta: SessionMeta }) => KernelTool[] {
  return ({ meta }) => {
    const captain = deps.service.identity();
    if (captain === undefined || meta.agentId !== captain.agentId) return [];

    const listAgents = defineTool({
      name: "list_agents",
      description:
        "List every agent with its runtime, model, machine and workspace. Secrets are never included.",
      parameters: Type.Object({}),
      execute() {
        return text(
          json(
            deps.agents.list().map((agent) => ({
              id: agent.id,
              name: agent.name,
              runtime: agent.runtime,
              model: agent.model,
              status: deps.timeline.agentStatuses().get(agent.id) ?? "idle",
              machineId: agent.machineId,
              systemRole: agent.systemRole,
              updatedAt: agent.updatedAt,
            })),
          ),
        );
      },
    });

    const readAgent = defineTool({
      name: "read_agent",
      description:
        "Read one agent's prompt, persona, model, runtime, machine and workspace. Credentials are not agent state and are never returned.",
      parameters: Type.Object({ agentId: Type.String() }),
      execute(args) {
        const agent = deps.agents.get(args.agentId);
        if (agent === undefined) return toolError("No such agent.");
        return text(
          json(
            redactValue({
              ...agent,
              status: deps.timeline.agentStatuses().get(agent.id) ?? "idle",
            }),
          ),
        );
      },
    });

    const listConversations = defineTool({
      name: "list_conversations",
      description:
        "List conversations with project, kind, archive state, member ids and last sequence.",
      parameters: Type.Object({}),
      execute() {
        return text(
          json(
            deps.conversations.list().map((conversation) => ({
              id: conversation.id,
              name: conversation.name,
              kind: conversation.kind,
              projectId: conversation.projectId,
              archived: conversation.archived,
              members: deps.conversations
                .participants(conversation.id)
                .map((member) => member.agentId),
              lastSeq: conversation.lastSeq,
            })),
          ),
        );
      },
    });

    const readConversation = defineTool({
      name: "read_conversation",
      description:
        "Read the newest rows of a conversation, including thinking, tool activity and attachments. Secrets are redacted.",
      parameters: Type.Object({
        conversationId: Type.String(),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
        beforeSeq: Type.Optional(Type.Integer({ minimum: 1 })),
      }),
      execute(args) {
        if (deps.conversations.get(args.conversationId) === undefined)
          return toolError("No such conversation.");
        const page = deps.timeline.page(
          args.conversationId,
          args.beforeSeq,
          args.limit ?? 100,
        );
        return text(
          json({
            messages: page.messages.map((row) => redactValue(row)),
            hasMore: page.hasMore,
            held: page.held.map((row) => redactValue(row)),
          }),
        );
      },
    });

    const readSession = defineTool({
      name: "read_session",
      description:
        "Read a session's journal entries, including messages, thinking, tool results, asks and failures. Remote sessions are read through the machine link and fail plainly when offline.",
      parameters: Type.Object({
        sessionId: Type.String(),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
      }),
      execute: async (args) => {
        const limit = args.limit ?? 200;
        if (deps.router.machineOf(args.sessionId) !== undefined) {
          try {
            const history = await deps.router.forward("history", {
              session: args.sessionId,
              limit,
            });
            return text(json(redactValue(history)));
          } catch (error) {
            return toolError(
              error instanceof Error ? error.message : String(error),
            );
          }
        }
        const server = deps.server();
        if (server === undefined)
          return toolError("The session host is starting.");
        try {
          const managed = await server.sessions.session(args.sessionId);
          if (managed === undefined) return toolError("No such session.");
          const entries = managed.session.log.graph
            .pathOldestFirst()
            .slice(-limit);
          return text(
            json({
              session: args.sessionId,
              entries: entries.map((entry) => redactValue(entry)),
            }),
          );
        } catch (error) {
          return toolError(
            error instanceof Error ? error.message : String(error),
          );
        }
      },
    });

    const listTasks = defineTool({
      name: "captain_list_tasks",
      description:
        "List the task board with status, executor, assignment source and run status, and the task graph: parentId and subtasks (done/total) for the tree, dependsOn (each edge with its state and requireDone) and waitingOn (what its work still waits for, inherited from parents too, `via` the parent). `under` lists one tree: the task and everything below it. Archived tasks (archivedAt set; put away, usually done long ago) are left out unless `archived` asks for them: `only` lists them alone, last archived first (to find one for unarchive_task), `include` lists them with the rest; archivedBy says who put each away (`user`, `auto`, or the agent's id).",
      parameters: Type.Object({
        status: Type.Optional(Type.String()),
        archived: Type.Optional(
          Type.Union([Type.Literal("only"), Type.Literal("include")]),
        ),
        under: Type.Optional(
          Type.String({ description: "A task's number (#12) or id" }),
        ),
      }),
      execute(args) {
        const root =
          args.under === undefined ? undefined : deps.board.find(args.under);
        if (args.under !== undefined && root === undefined)
          return toolError("No such task.");
        const tree =
          root === undefined
            ? undefined
            : new Set([
                root.id,
                ...deps.board
                  .graph()
                  .descendantsOf(root.id)
                  .map((task) => task.id),
              ]);
        return text(
          json(
            deps.board
              .list({ archived: args.archived })
              .filter(
                (task) =>
                  (args.status === undefined || task.status === args.status) &&
                  (tree === undefined || tree.has(task.id)),
              )
              .map((task) => redactValue(task)),
          ),
        );
      },
    });

    const readTask = defineTool({
      name: "captain_read_task",
      description:
        "Read one task, its workspace, runs and full activity timeline. Assignment provenance is included, and its place in the task graph: ancestors (top first) and children, dependsOn and dependents, waitingOn.",
      parameters: Type.Object({ taskId: Type.String() }),
      execute(args) {
        const task = deps.board.find(args.taskId);
        if (task === undefined) return toolError("No such task.");
        return text(
          json({
            task: redactValue(deps.board.detail(task.id)),
            activity: deps.board
              .activity(task.id)
              .map((row) => redactValue(row)),
          }),
        );
      },
    });

    const readInbox = defineTool({
      name: "read_inbox",
      description:
        "Read pending and recent Inbox questions. Questions may contain user text; secrets are redacted.",
      parameters: Type.Object({
        pendingOnly: Type.Optional(Type.Boolean()),
      }),
      execute(args) {
        return text(
          json(
            deps.inbox
              .list()
              .filter(
                (item) =>
                  args.pendingOnly !== true || item.status === "pending",
              )
              .map((item) => redactValue(item)),
          ),
        );
      },
    });

    const readMemory = defineTool({
      name: "read_agent_memory",
      description:
        "Read one agent's long-term and project memories with source and provenance. Deleted entries are hidden unless includeDeleted is true.",
      parameters: Type.Object({
        agentId: Type.String(),
        query: Type.Optional(Type.String()),
        includeDeleted: Type.Optional(Type.Boolean()),
      }),
      execute: async (args) => {
        try {
          const memories = await deps.memory.list(args.agentId, {
            ...(args.query === undefined ? {} : { query: args.query }),
            ...(args.includeDeleted === true ? { includeDeleted: true } : {}),
          });
          return text(json(memories.map((memory) => redactValue(memory))));
        } catch (error) {
          return toolError(
            error instanceof Error ? error.message : String(error),
          );
        }
      },
    });

    const readAttachment = defineTool({
      name: "read_attachment",
      description:
        "Read an attachment. Text is redacted and capped; images are returned as image content; other binaries return metadata only.",
      parameters: Type.Object({ attachmentId: Type.String() }),
      execute: async (args) => {
        const attachment = deps.attachments.get(args.attachmentId);
        if (attachment === undefined) return toolError("No such attachment.");
        const bytes = await readFile(deps.attachments.pathOf(attachment)).catch(
          () => undefined,
        );
        if (bytes === undefined)
          return toolError("The attachment file is gone.");
        if (attachment.contentType.startsWith("image/"))
          return {
            content: [
              {
                type: "image" as const,
                data: bytes.toString("base64"),
                mimeType: attachment.contentType,
              },
            ],
            details: { attachment: redactValue(attachment) },
          };
        const textLike =
          attachment.contentType.startsWith("text/") ||
          /json|xml|javascript|yaml|x-yaml|markdown/i.test(
            attachment.contentType,
          );
        if (!textLike)
          return text(
            json({
              attachment: redactValue(attachment),
              content: "[binary attachment omitted]",
            }),
          );
        return text(
          json({
            attachment: redactValue(attachment),
            content: redactText(bytes.subarray(0, 64 * 1024).toString("utf8")),
          }),
        );
      },
    });

    const assign = defineTool({
      name: "assign_in_group",
      description:
        "Send a visible Captain message in an existing group and wake one or more members in chat for coordination, investigation, discussion, or questions. With no agentIds, speak to the group's steward (or its only member when it has none), like a user message without mentions; a group with several members and no steward needs agentIds. To directly create and assign tracked board tasks (or staged task trees), use `dispatch_task` instead.",
      parameters: Type.Object({
        conversationId: Type.String(),
        text: Type.String(),
        agentIds: Type.Optional(Type.Array(Type.String())),
        mode: Type.Optional(
          Type.Union([Type.Literal("queue"), Type.Literal("steer")]),
        ),
      }),
      execute: async (args) => {
        try {
          const running = deps.timeline
            .active(args.conversationId)
            .find((row) => row.agentId === captain.agentId);
          const result = await deps.service.assign({
            ...args,
            rootMessageId: running?.rootMessageId ?? null,
          });
          return text(assignmentText(result), result);
        } catch (error) {
          return toolError(
            error instanceof Error ? error.message : String(error),
          );
        }
      },
    });

    const dispatchTask = defineTool({
      name: "dispatch_task",
      description:
        "Create a tracked board task directly in an existing group conversation, assign it to a non-Captain group member (or default to the group's steward / sole non-Captain member), post a visible Captain announcement in the group without waking chat replies, and enqueue its run (unless status is `backlog`). For staged work / task trees, call `dispatch_task` with `parent` and `dependsOn`. Use `assign_in_group` when you want to talk to or coordinate members in group chat instead of directly creating a task.",
      parameters: Type.Object(
        {
          conversationId: Type.String({
            description: "The group conversation id.",
          }),
          title: Type.String({
            description: "A short title for the task.",
          }),
          description: Type.String({
            description:
              "What to do, what has been decided, and how it will be judged done, written for an executor running in an isolated session.",
          }),
          assignee: Type.Optional(
            Type.String({
              description:
                "Non-Captain member of the group (name or id) to execute the task; defaults to the group's steward or sole member.",
            }),
          ),
          status: Type.Optional(
            Type.Union([Type.Literal("todo"), Type.Literal("backlog")], {
              description:
                "todo (default, starts immediately) or backlog (queued on board without starting).",
            }),
          ),
          workspace: Type.Optional(
            Type.Union(
              TASK_WORKSPACE_MODES.map((mode) => Type.Literal(mode)),
              {
                description:
                  "worktree or local; defaults to the conversation project's mode.",
              },
            ),
          ),
          base: Type.Optional(
            Type.String({
              description: "Branch, commit, or #N the worktree starts from.",
            }),
          ),
          parent: Type.Optional(
            Type.String({
              description:
                "Parent task number (#N) or id when dispatching a subtask.",
            }),
          ),
          dependsOn: Type.Optional(
            Type.Array(
              Type.Object({
                task: Type.String({
                  description:
                    "The task waited for: its number (#12 or 12) or id.",
                }),
                requireDone: Type.Optional(
                  Type.Boolean({
                    description:
                      "Only done resolves it. By default in_review is enough to start.",
                  }),
                ),
              }),
            ),
          ),
          message: Type.Optional(
            Type.String({
              description:
                "Optional visible note to post in the group chat announcing the dispatched task.",
            }),
          ),
        },
        { additionalProperties: false },
      ),
      execute: async (args) => {
        try {
          const result = await deps.service.dispatchTask(args);
          const assigneeName =
            result.task.assigneeAgentId === null
              ? "unassigned"
              : (deps.agents.get(result.task.assigneeAgentId)?.name ??
                result.task.assigneeAgentId);
          return text(
            `Dispatched task #${result.task.number} "${result.task.title}" to ${assigneeName} (assignment ${result.assignment.id}; message ${result.messageId}).`,
            result,
          );
        } catch (error) {
          return toolError(
            error instanceof Error ? error.message : String(error),
          );
        }
      },
    });

    /**
     * Where a proposal's card goes: this conversation, or Captain's own conversation from a session held
     * in none (a task's, a routine run's).
     */
    const proposalOrigin = async (): Promise<string> =>
      meta.conversationId === undefined ||
      heldIn(meta.conversationId) !== "conversation" ||
      deps.conversations.get(meta.conversationId) === undefined
        ? (await deps.service.conversation()).conversationId
        : meta.conversationId;

    const proposeGroup = defineTool({
      name: "propose_group",
      description: [
        "Propose a new group conversation. Nothing is created yet: the proposal appears as a card in this conversation, and only the user's confirmation creates the group (adding the directory as a project first when it is not one). Every proposal needs that confirmation.",
        "Before proposing, call list_conversations: if a suitable group already exists, use it with dispatch_task or assign_in_group instead. A group with the same name in the same project is a conflict; the error returns that group's conversationId.",
        "Directory: give projectId for an existing project, or path (absolute) plus optional machineId (default: the primary machine) for a directory that must already exist on that machine, e.g. a repository you just cloned. An agent's own workspace or an archived project is refused.",
        "memberIds needs at least one agent and must not include you. stewardId is the member who takes messages that name nobody: one of memberIds, or null for none; left out, it is the first member. Nobody is ever added to a group for that.",
        "Several groups can be proposed in one turn; each gets its own card. Do not wait for the decision: once everything is proposed, end your turn. For each proposal the user confirms or rejects, a message in this conversation tells you the outcome and, if created, the new group's conversationId; then dispatch tasks there with dispatch_task or coordinate with assign_in_group.",
      ].join(" "),
      parameters: Type.Object({
        name: Type.String({ description: "The group's name." }),
        projectId: Type.Optional(
          Type.String({ description: "An existing project. Or give path." }),
        ),
        path: Type.Optional(
          Type.String({
            description:
              "An existing directory on the machine, absolute. Or give projectId.",
          }),
        ),
        machineId: Type.Optional(
          Type.String({
            description:
              "The machine path is on; the primary machine if left out.",
          }),
        ),
        memberIds: Type.Array(Type.String(), { minItems: 1 }),
        stewardId: Type.Optional(
          Type.Union([Type.String(), Type.Null()], {
            description:
              "The member who takes messages that name nobody, or null for none. Default: the first member.",
          }),
        ),
        goal: Type.Optional(Type.String()),
      }),
      execute: async (args) => {
        try {
          const { operation } = await deps.service.proposals.propose(
            deps.service.propose.group,
            args,
            await proposalOrigin(),
          );
          return text(
            `Proposed group "${args.name.trim()}" (operation ${operation.id}). It is waiting for the user's confirmation. Propose anything else that is needed, then end this turn; a message here will tell you the outcome.`,
            { operationId: operation.id, status: operation.status },
          );
        } catch (error) {
          if (error instanceof GroupConflictError)
            return toolError(
              `Conflict: ${error.message}. Use that group with dispatch_task or assign_in_group, or propose a different name.`,
            );
          return toolError(
            error instanceof Error ? error.message : String(error),
          );
        }
      },
    });

    const listModels = defineTool({
      name: "list_models",
      description:
        "List every configured provider model and gateway subscription model (llm:<id>) with its id (provider:modelId), name, providerName, and availability. Call this before ask_user when offering model choices for propose_agent.",
      parameters: Type.Object({}),
      execute() {
        try {
          return text(json(availableModels(deps.server())));
        } catch (error) {
          return toolError(
            error instanceof Error ? error.message : String(error),
          );
        }
      },
    });

    const listPersonaCards = defineTool({
      name: "list_persona_cards",
      description:
        "List the persona cards an agent you propose can wear: the id to name one, and one line saying what it is. A card is never written, edited or invented — a new agent wears one of these exactly as it is.",
      parameters: Type.Object({}),
      async execute() {
        try {
          return text(json(await deps.service.listPersonaCards()));
        } catch (error) {
          return toolError(
            error instanceof Error ? error.message : String(error),
          );
        }
      },
    });

    const proposeAgent = defineTool({
      name: "propose_agent",
      description: [
        "Propose a new agent. Nothing is created yet: the proposal appears as a card in this conversation, and only the user's confirmation creates the agent, its workspace and its first instructions and persona versions. Every proposal needs that confirmation.",
        "For the built-in eta runtime, call list_persona_cards before proposing and pick the single card that fits the work best: persona must be one of those ids (never write or invent a card). External runtimes (any non-eta runtime, such as OAR or ACP) cannot carry a persona card (omit persona) and must be pinned to one concrete machineId (they cannot participate in groups or tasks on other machines).",
        "model has no default: call list_models first, then ask the user which model the agent should run with ask_user, offering the available models, and propose the one they choose.",
        "name must not be the name of an agent that already exists. purpose is one sentence: what the agent is responsible for, and when it should be retired. instructions is what it is told to do, and cannot be empty.",
        "Several agents can be proposed in one turn; each gets its own card. Do not wait for the decision: once everything is proposed, end your turn. When the user decides, you are told the outcome in that conversation as a message that starts your next turn. Only a proposal you made is reported back — an agent the user creates in the agent dialog is not yours to track.",
      ].join(" "),
      parameters: Type.Object({
        name: Type.String({
          description: "The agent's name; it must be unique.",
        }),
        purpose: Type.String({
          description:
            "One sentence: what it is responsible for, and when it should retire.",
        }),
        instructions: Type.String({
          description: "What the agent is told to do. It cannot be empty.",
        }),
        persona: Type.Optional(
          Type.String({
            description:
              "An id from list_persona_cards (eta runtime only; omit for external runtimes).",
          }),
        ),
        model: Type.String({
          description:
            "provider:modelId, chosen by the user. There is no default.",
        }),
        runtime: Type.Optional(
          Type.String({
            description: `One of ${AGENT_RUNTIMES.join(", ")}, or acp.<id> for an ACP agent the host lists.`,
          }),
        ),
        machineId: Type.Optional(
          Type.String({
            description:
              "Machine id to pin this agent to (required for any non-eta runtime; omit for eta to follow the project).",
          }),
        ),
        plugins: Type.Optional(Type.Array(Type.String())),
      }),
      execute: async (args) => {
        try {
          const { runtime, machineId, ...rest } = args;
          if (runtime !== undefined && !isAgentRuntime(runtime))
            throw new Error(`unknown runtime: ${runtime}`);
          const { operation } = await deps.service.proposals.propose(
            deps.service.propose.agent,
            {
              ...rest,
              ...(runtime === undefined ? {} : { runtime }),
              ...(machineId === undefined ? {} : { machineId }),
            },
            await proposalOrigin(),
          );
          return text(
            `Proposed agent "${args.name.trim()}" (operation ${operation.id}). It is waiting for the user's confirmation on its card in this conversation.`,
            { operationId: operation.id, status: operation.status },
          );
        } catch (error) {
          return toolError(
            error instanceof Error ? error.message : String(error),
          );
        }
      },
    });

    /** The writing tools go through on an archived task and say what they undid (`archived.ts`). */
    const archivedNotice = archivedNote(
      deps.board,
      (agentId) => deps.agents.get(agentId)?.name ?? "a deleted agent",
      {
        rearchive: "If they want it put away again, archive_task does that.",
      },
    );

    const controlTask = defineTool({
      name: "control_task",
      description:
        "Continue, pause, interrupt, cancel, rerun or delete a task. Normal continuation is a task comment so the executor resumes its own session. " +
        `Deleting an archived task deletes it; anything else follows this: ${ARCHIVED_RULE}`,
      parameters: Type.Object({
        taskId: Type.String(),
        action: Type.Union([
          Type.Literal("continue"),
          Type.Literal("pause"),
          Type.Literal("interrupt"),
          Type.Literal("cancel"),
          Type.Literal("rerun"),
          Type.Literal("delete"),
        ]),
        text: Type.Optional(Type.String()),
      }),
      execute: async (args) => {
        try {
          const known = deps.board.find(args.taskId);
          const archived =
            known === undefined || args.action === "delete"
              ? undefined
              : archivedNotice.before(known.id);
          const result = await deps.service.taskControl(args);
          return text(
            result === null
              ? `Task ${args.taskId} deleted.`
              : `Task #${result.number} ${args.action}: ${result.status}.${archived?.after() ?? ""}`,
            result ?? { taskId: args.taskId, deleted: true },
          );
        } catch (error) {
          return toolError(
            error instanceof Error ? error.message : String(error),
          );
        }
      },
    });

    const updateTask = defineTool({
      name: "update_task_fields",
      description: `Change a task's title, description or status. This does not change its creator or executor. ${
        ARCHIVED_RULE
      }`,
      parameters: Type.Object(
        {
          taskId: Type.String(),
          title: Type.Optional(Type.String()),
          description: Type.Optional(Type.String()),
          status: Type.Optional(
            Type.Union(TASK_STATUSES.map((status) => Type.Literal(status))),
          ),
        },
        { additionalProperties: false },
      ),
      execute(args) {
        try {
          const task = deps.board.find(args.taskId);
          if (task === undefined) return toolError("No such task.");
          const archived = archivedNotice.before(task.id);
          const updated = deps.board.update(
            task.id,
            {
              ...(args.title === undefined ? {} : { title: args.title }),
              ...(args.description === undefined
                ? {}
                : { description: args.description }),
              ...(args.status === undefined ? {} : { status: args.status }),
            },
            { kind: "agent", agentId: captain.agentId },
          );
          return text(
            `Task #${updated.number} updated.${archived?.after() ?? ""}`,
            updated,
          );
        } catch (error) {
          return toolError(
            error instanceof Error ? error.message : String(error),
          );
        }
      },
    });

    /** The tasks named, each once; or the names that match none. */
    const namedTasks = (
      names: readonly string[],
    ): { tasks: TaskRecord[] } | { unknown: string[] } => {
      const found = names.map((name) => [name, deps.board.find(name)] as const);
      const unknown = found
        .filter(([, task]) => task === undefined)
        .map(([name]) => name);
      if (unknown.length > 0) return { unknown };
      const tasks = new Map<string, TaskRecord>();
      for (const [, task] of found) tasks.set(task!.id, task!);
      return { tasks: [...tasks.values()] };
    };
    const noSuchTasks = (unknown: readonly string[]) =>
      toolError(
        `No such task: ${unknown.join(", ")}. Nothing was changed; captain_list_tasks (with archived: "include") shows the board.`,
      );
    const numbers = (tasks: readonly { number: number }[]): string =>
      tasks.map((task) => `#${task.number}`).join(", ");
    const archiveState = (task: BoardTaskDetail) => ({
      id: task.id,
      number: task.number,
      status: task.status,
      archivedAt: task.archivedAt ?? null,
      archivedBy: task.archivedBy ?? null,
    });
    const taskIds = Type.Array(
      Type.String({ description: "A task's number (#12) or id" }),
      { minItems: 1 },
    );

    const archiveTask = defineTool({
      name: "archive_task",
      description:
        "Archive tasks: put them away from the board, each with its subtasks, the way the user's Archive does. Use it to clear finished work (done or cancelled) the user wants off the board; any status may be archived and keeps its status. An archived task is hidden from captain_list_tasks unless `archived` asks for it, and comes back by itself when anything new happens on it. If a task, or one under it, has a run that has not ended, archiving stops that run: the call then archives nothing and says which tasks are running. Ask the user first, and only with their agreement call again with stopRuns: true. Undo with unarchive_task.",
      parameters: Type.Object({
        taskIds,
        stopRuns: Type.Optional(
          Type.Boolean({
            description:
              "Stop the runs that have not ended, then archive. Only once the user agreed to stop them.",
          }),
        ),
      }),
      execute(args) {
        try {
          const named = namedTasks(args.taskIds);
          if ("unknown" in named) return noSuchTasks(named.unknown);
          const stopRuns = args.stopRuns === true;
          if (!stopRuns) {
            const running = new Map<string, TaskRecord>();
            for (const task of named.tasks)
              for (const t of deps.board.runningIfArchived(task.id))
                running.set(t.id, t);
            if (running.size > 0)
              return toolError(
                `${numbers([...running.values()])} ${running.size === 1 ? "is running" : "are running"}: archiving stops ${running.size === 1 ? "its run" : "their runs"}. Nothing was archived. Ask the user whether to stop ${running.size === 1 ? "it" : "them"}; only with their agreement call archive_task again with stopRuns: true.`,
              );
          }
          const already = named.tasks.filter(
            (task) => task.archivedAt !== null && task.archivedAt !== undefined,
          );
          const archived = named.tasks
            .filter((task) => !already.includes(task))
            .map((task) =>
              deps.board.archive(
                task.id,
                { kind: "agent", agentId: captain.agentId },
                { stopRuns },
              ),
            );
          return text(
            [
              archived.length > 0 ? `Archived ${numbers(archived)}.` : "",
              already.length > 0
                ? `${numbers(already)} ${already.length === 1 ? "was" : "were"} archived already.`
                : "",
            ]
              .filter((line) => line !== "")
              .join(" "),
            {
              tasks: [
                ...archived,
                ...already.map((t) => deps.board.detail(t.id)!),
              ].map(archiveState),
            },
          );
        } catch (error) {
          return toolError(
            error instanceof Error ? error.message : String(error),
          );
        }
      },
    });

    const unarchiveTask = defineTool({
      name: "unarchive_task",
      description:
        "Bring archived tasks back to the board, each with its archived subtasks, the way the user's Restore does. Use it when the user wants archived work back in view or to work on it again; it does not change a task's status or start a run. Find archived tasks with captain_list_tasks and archived: \"only\".",
      parameters: Type.Object({ taskIds }),
      execute(args) {
        try {
          const named = namedTasks(args.taskIds);
          if ("unknown" in named) return noSuchTasks(named.unknown);
          const notArchived = named.tasks.filter(
            (task) => task.archivedAt === null || task.archivedAt === undefined,
          );
          const back = deps.board.unarchive(
            named.tasks
              .filter((task) => !notArchived.includes(task))
              .map((task) => task.id),
            { kind: "agent", agentId: captain.agentId },
          );
          return text(
            [
              back.length > 0 ? `Restored ${numbers(back)}.` : "",
              notArchived.length > 0
                ? `${numbers(notArchived)} ${notArchived.length === 1 ? "was" : "were"} not archived.`
                : "",
            ]
              .filter((line) => line !== "")
              .join(" "),
            {
              tasks: named.tasks.map((t) =>
                archiveState(deps.board.detail(t.id)!),
              ),
            },
          );
        } catch (error) {
          return toolError(
            error instanceof Error ? error.message : String(error),
          );
        }
      },
    });

    const answerInbox = defineTool({
      name: "answer_inbox",
      description:
        "Answer an Inbox question that does not belong to Captain-dispatched work. Questions from assigned agents must use relay_inbox_to_user.",
      parameters: Type.Object({
        interactionId: Type.String(),
        text: Type.Optional(Type.String()),
        selections: Type.Optional(Type.Array(Type.String())),
      }),
      execute: async (args) => {
        try {
          const source = deps.inbox.get(args.interactionId);
          if (source !== undefined && deps.service.assignmentForInbox(source)) {
            const relay = deps.inbox.relayQuestionOf(source.id);
            const decision =
              relay === undefined
                ? undefined
                : deps.service.store.reviewByDedupe(
                    `inbox-decision:${relay.id}:${relay.revision}`,
                  );
            if (
              decision === undefined ||
              (decision.status !== "pending" && decision.status !== "running")
            )
              return toolError(
                "This question belongs to Captain-dispatched work. Use relay_inbox_to_user and answer it only in the resulting inbox_decision review.",
              );
          }
          const response: InboxResponse =
            args.selections !== undefined && args.selections.length > 0
              ? { kind: "selection", selections: args.selections }
              : args.text === undefined || args.text.trim() === ""
                ? { kind: "none" }
                : { kind: "freeform", text: args.text };
          const result = await deps.answerInbox(args.interactionId, response);
          return text(
            result.answered
              ? "Inbox answer delivered."
              : "The question is no longer waiting.",
            result,
          );
        } catch (error) {
          return toolError(
            error instanceof Error ? error.message : String(error),
          );
        }
      },
    });

    const relayInboxToUser = defineTool({
      name: "relay_inbox_to_user",
      description:
        "Send a Captain-assigned agent's question to the user and finish this turn. The user's answer later starts an inbox_decision review that writes the decision back to the original question.",
      parameters: Type.Object({ interactionId: Type.String() }),
      execute: async (args) => {
        try {
          const source = deps.inbox.get(args.interactionId);
          if (source === undefined) return toolError("No such Inbox question.");
          if (source.status !== "pending")
            return text("That Inbox question is no longer waiting.");
          if (deps.service.assignmentForInbox(source) === undefined)
            return toolError(
              "This Inbox question does not belong to Captain-dispatched work.",
            );

          const server = deps.server();
          if (server === undefined)
            return toolError("The session host is starting.");
          const managed = await server.sessions.session(meta.id);
          const ask = managed?.session.ask;
          if (ask === undefined)
            return toolError("Captain's question channel is unavailable.");

          const questionId = `relay:${source.id}:${source.revision}:${crypto.randomUUID()}`;
          const waiting = ask.ask({
            questionId,
            question: source.prompt,
            ...(source.options.length === 0 ? {} : { options: source.options }),
            ...(source.multi ? { multi: true } : {}),
          });
          const relay = deps.inbox.get(interactionId(meta.id, questionId));
          if (relay === undefined || relay.status !== "pending") {
            ask.abort(questionId);
            return toolError("The relay question did not open for the user.");
          }
          deps.inbox.setRelayOf(relay.id, source.id);
          void waiting.catch(() => undefined);
          return text(
            "The question is now waiting in the user's Inbox. This turn can finish; the user's answer will start an inbox_decision review.",
            { interactionId: source.id, relayInteractionId: relay.id },
          );
        } catch (error) {
          return toolError(
            error instanceof Error ? error.message : String(error),
          );
        }
      },
    });

    const promptHistory = defineTool({
      name: "prompt_history",
      description:
        "Read versioned instructions, persona and base prompts. Versions are append-only.",
      parameters: Type.Object({
        subjectId: Type.Optional(Type.String()),
        kind: Type.Optional(
          Type.Union([
            Type.Literal("instructions"),
            Type.Literal("persona"),
            Type.Literal("base"),
          ]),
        ),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
      }),
      execute(args) {
        return text(json(deps.service.promptHistory(args)));
      },
    });

    const diffPrompt = defineTool({
      name: "diff_prompt",
      description: "Compare two prompt versions of the same agent and kind.",
      parameters: Type.Object({
        subjectId: Type.String(),
        kind: Type.Union([
          Type.Literal("instructions"),
          Type.Literal("persona"),
          Type.Literal("base"),
        ]),
        fromVersion: Type.Integer({ minimum: 1 }),
        toVersion: Type.Integer({ minimum: 1 }),
      }),
      execute(args) {
        try {
          return text(
            deps.service.promptDiff(
              args.subjectId,
              args.kind as CaptainPromptKind,
              args.fromVersion,
              args.toVersion,
            ).diff,
          );
        } catch (error) {
          return toolError(
            error instanceof Error ? error.message : String(error),
          );
        }
      },
    });

    const setPrompt = defineTool({
      name: "set_agent_prompt",
      description:
        "Change an agent's instructions or persona. Changing the global base prompt or Captain's own prompt creates a pending user approval.",
      parameters: Type.Object({
        subjectId: Type.String(),
        kind: Type.Union([
          Type.Literal("instructions"),
          Type.Literal("persona"),
          Type.Literal("base"),
        ]),
        content: Type.String(),
      }),
      execute: async (args) => {
        try {
          if (args.kind === "base" || args.subjectId === captain.agentId) {
            const operation = deps.service.createOperation({
              kind: "set_prompt",
              requiresApproval: true,
              actorAgentId: captain.agentId,
              payload: args,
            });
            return text(
              `Approval required. Pending operation ${operation.id}.`,
              operation,
            );
          }
          const version = deps.service.setPrompt({
            ...args,
            actorAgentId: captain.agentId,
          });
          return text(
            `Prompt ${args.kind} version ${version.version} saved.`,
            version,
          );
        } catch (error) {
          return toolError(
            error instanceof Error ? error.message : String(error),
          );
        }
      },
    });

    const rollbackPrompt = defineTool({
      name: "rollback_agent_prompt",
      description:
        "Restore an older prompt version by appending it as the newest version. The base prompt and Captain's own prompt require user approval.",
      parameters: Type.Object({
        subjectId: Type.String(),
        kind: Type.Union([
          Type.Literal("instructions"),
          Type.Literal("persona"),
          Type.Literal("base"),
        ]),
        version: Type.Integer({ minimum: 1 }),
      }),
      execute: async (args) => {
        try {
          const selected = deps.service.promptVersion(
            args.subjectId,
            args.kind,
            args.version,
          );
          if (args.kind === "base" || args.subjectId === captain.agentId) {
            const operation = deps.service.createOperation({
              kind: "set_prompt",
              requiresApproval: true,
              actorAgentId: captain.agentId,
              payload: {
                subjectId: args.subjectId,
                kind: args.kind,
                content: selected.content,
              },
            });
            return text(
              `Approval required. Pending operation ${operation.id}.`,
              operation,
            );
          }
          const version = deps.service.rollbackPrompt({
            ...args,
            actorAgentId: captain.agentId,
          });
          return text(
            `Restored prompt as version ${version.version}.`,
            version,
          );
        } catch (error) {
          return toolError(
            error instanceof Error ? error.message : String(error),
          );
        }
      },
    });

    const pauseMemory = defineTool({
      name: "set_memory_paused",
      description:
        "Turn long-term and project memory recall, automatic capture and explicit memory tools off or on for a conversation or task. The setting persists until changed.",
      parameters: Type.Object({
        scopeType: Type.Union([
          Type.Literal("conversation"),
          Type.Literal("task"),
        ]),
        scopeId: Type.String(),
        paused: Type.Boolean(),
      }),
      execute(args) {
        try {
          const pause = deps.service.setMemoryPaused({
            ...args,
            updatedBy: captain.agentId,
          });
          return text(
            `Memory is ${pause.paused ? "paused" : "enabled"} for ${pause.scopeType} ${pause.scopeId}.`,
            pause,
          );
        } catch (error) {
          return toolError(
            error instanceof Error ? error.message : String(error),
          );
        }
      },
    });

    const deleteMemory = defineTool({
      name: "delete_memory",
      description:
        "Soft-delete one memory. The memory can be restored later; deletion is audited.",
      parameters: Type.Object({
        agentId: Type.String(),
        memoryId: Type.String(),
      }),
      execute: async (args) => {
        try {
          const operation = deps.service.createOperation({
            kind: "delete_memory",
            requiresApproval: true,
            actorAgentId: captain.agentId,
            payload: args,
          });
          return text(
            `Approval required. Pending operation ${operation.id}.`,
            operation,
          );
        } catch (error) {
          return toolError(
            error instanceof Error ? error.message : String(error),
          );
        }
      },
    });

    const restoreMemory = defineTool({
      name: "restore_memory",
      description: "Restore a soft-deleted memory.",
      parameters: Type.Object({
        agentId: Type.String(),
        memoryId: Type.String(),
      }),
      execute: async (args) => {
        try {
          await deps.memory.restore(args.agentId, args.memoryId);
          return text(`Restored memory ${args.memoryId}.`);
        } catch (error) {
          return toolError(
            error instanceof Error ? error.message : String(error),
          );
        }
      },
    });

    const setSetting = defineTool({
      name: "set_captain_setting",
      description:
        "Change a typed supervisor setting: enabled, patrol/inbox/stuck minutes, retry limit or loop rounds. Credentials cannot be read or set here.",
      parameters: Type.Object({
        key: Type.Union([
          Type.Literal("supervisorEnabled"),
          Type.Literal("patrolMinutes"),
          Type.Literal("inboxMinutes"),
          Type.Literal("stuckMinutes"),
          Type.Literal("retryLimit"),
          Type.Literal("loopRounds"),
        ]),
        value: Type.Union([
          Type.Boolean(),
          Type.Integer({ minimum: 1, maximum: 1440 }),
        ]),
      }),
      execute(args) {
        try {
          const setting = deps.service.setSetting(
            args.key,
            args.value,
            captain.agentId,
          );
          return text(`Captain setting ${args.key} updated.`, setting);
        } catch (error) {
          return toolError(
            error instanceof Error ? error.message : String(error),
          );
        }
      },
    });

    const settingHistory = defineTool({
      name: "captain_setting_history",
      description: "Read the version history of one typed Captain setting.",
      parameters: Type.Object({
        key: Type.Union([
          Type.Literal("supervisorEnabled"),
          Type.Literal("patrolMinutes"),
          Type.Literal("inboxMinutes"),
          Type.Literal("stuckMinutes"),
          Type.Literal("retryLimit"),
          Type.Literal("loopRounds"),
        ]),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
      }),
      execute(args) {
        return text(json(deps.service.settingHistory(args.key, args.limit)));
      },
    });

    const rollbackSetting = defineTool({
      name: "rollback_captain_setting",
      description:
        "Restore an older value of a typed Captain setting by appending it as the newest version.",
      parameters: Type.Object({
        key: Type.Union([
          Type.Literal("supervisorEnabled"),
          Type.Literal("patrolMinutes"),
          Type.Literal("inboxMinutes"),
          Type.Literal("stuckMinutes"),
          Type.Literal("retryLimit"),
          Type.Literal("loopRounds"),
        ]),
        version: Type.Integer({ minimum: 1 }),
      }),
      execute(args) {
        try {
          const setting = deps.service.rollbackSetting(
            args.key,
            args.version,
            captain.agentId,
          );
          return text(`Rolled back ${args.key} as version ${setting.version}.`);
        } catch (error) {
          return toolError(
            error instanceof Error ? error.message : String(error),
          );
        }
      },
    });

    const requestDeleteAgent = defineTool({
      name: "request_delete_agent",
      description:
        "Request deletion of an ordinary agent. Deletion is destructive and always waits for user approval in Captain operations.",
      parameters: Type.Object({ agentId: Type.String() }),
      execute(args) {
        const agent = deps.agents.get(args.agentId);
        if (agent === undefined) return toolError("No such agent.");
        if (agent.systemRole === "captain")
          return toolError("Captain cannot delete itself.");
        const operation = deps.service.createOperation({
          kind: "delete_agent",
          requiresApproval: true,
          actorAgentId: captain.agentId,
          payload: { agentId: args.agentId },
        });
        return text(
          `Approval required. Pending operation ${operation.id}.`,
          operation,
        );
      },
    });

    const recommendAcceptance = defineTool({
      name: "recommend_task_acceptance",
      description:
        "Post Captain's acceptance recommendation on a task. The user retains final approve/reject authority.",
      parameters: Type.Object({
        taskId: Type.String(),
        recommendation: Type.Union([
          Type.Literal("accept"),
          Type.Literal("revise"),
        ]),
        notes: Type.String(),
      }),
      execute(args) {
        const task = deps.board.find(args.taskId);
        if (task === undefined) return toolError("No such task.");
        deps.board.comment(
          task.id,
          `Captain recommends ${args.recommendation}: ${args.notes}`,
          { kind: "agent", agentId: captain.agentId },
        );
        return text(
          `Task #${task.number}: Captain recommends ${args.recommendation}; the user decides.`,
        );
      },
    });

    const post = defineTool({
      name: "post_in_group",
      description:
        "Post a plain message in a group conversation, as Captain, without waking anyone: no agent is named and no reply is started. Use it to share something (a routine's result the brief says to send there, a notice). To get work done, use dispatch_task (to create a tracked task) or assign_in_group (to wake members in chat) instead. Only groups; not your own conversation with the user.",
      parameters: Type.Object({
        conversationId: Type.String(),
        text: Type.String({ minLength: 1 }),
      }),
      execute: async (args) => {
        try {
          const result = await deps.service.post(args);
          return text(`Posted (message ${result.messageId}).`, result);
        } catch (error) {
          return toolError(
            error instanceof Error ? error.message : String(error),
          );
        }
      },
    });

    const schedule = Type.Union(
      [
        Type.Object({
          kind: Type.Literal("daily"),
          time: Type.String({ description: "HH:MM, 24 hours" }),
        }),
        Type.Object({
          kind: Type.Literal("weekly"),
          days: Type.Array(Type.Integer({ minimum: 0, maximum: 6 }), {
            minItems: 1,
            description: "0 is Sunday",
          }),
          time: Type.String({ description: "HH:MM, 24 hours" }),
        }),
        Type.Object({
          kind: Type.Literal("hourly"),
          every: Type.Integer({
            description: "Hours between runs: 1, 2, 3, 4, 6, 8 or 12",
          }),
        }),
        Type.Object({
          kind: Type.Literal("cron"),
          cron: Type.String({
            description:
              "Five fields: minute hour day-of-month month day-of-week",
          }),
        }),
      ],
      { description: "When it runs, in timezone's wall clock" },
    );

    const listRoutines = defineTool({
      name: "list_routines",
      description:
        "List the routines: the work you run on a schedule. Each has its id, name, schedule, time zone, whether it is enabled, its current brief and its latest runs (status and report title).",
      parameters: Type.Object({}),
      execute() {
        const routines = deps.service.routines;
        return text(
          json(
            routines.store.list().map((routine) => ({
              id: routine.id,
              name: routine.name,
              schedule: routine.schedule,
              timezone: routine.timezone,
              enabled: routine.enabled,
              brief: routines.store.brief(routine.id),
              runs: routines.store.runs(routine.id, 5).map((run) => ({
                id: run.id,
                status: run.status,
                startedAt: new Date(run.startedAt).toISOString(),
                title: run.title,
                error: run.error,
              })),
            })),
          ),
        );
      },
    });

    const proposeRoutine = defineTool({
      name: "propose_routine",
      description: [
        "Propose a routine: work you will do on a schedule, each time in a new session of your own with all your tools. Nothing is created yet: the proposal appears as a card in this conversation, and only the user's confirmation creates it.",
        'Use it when the user asks for something to be done regularly ("every Monday morning, …").',
        "brief is what each run is asked to do, written as instructions to yourself: what to check or do, and what to report. If the user wants the result sent somewhere (a group), say so in the brief; there is no other setting for it. A routine has no agent and no model: it is yours.",
        "timezone is an IANA zone such as Asia/Shanghai: ask the user if you do not know theirs.",
        "Do not wait for the decision: end your turn. A message here will tell you the outcome.",
      ].join(" "),
      parameters: Type.Object({
        name: Type.String({ description: "A short name" }),
        brief: Type.String({ description: "What each run is asked to do" }),
        schedule,
        timezone: Type.String(),
      }),
      execute: async (args) => {
        try {
          const { operation } = await deps.service.proposals.propose(
            deps.service.propose.routine,
            args,
            await proposalOrigin(),
          );
          return text(
            `Proposed routine "${args.name.trim()}" (operation ${operation.id}). It is waiting for the user's confirmation on its card. End this turn; a message will tell you the outcome.`,
            { operationId: operation.id, status: operation.status },
          );
        } catch (error) {
          return toolError(
            error instanceof Error ? error.message : String(error),
          );
        }
      },
    });

    const updateRoutine = defineTool({
      name: "update_routine",
      description:
        "Change a routine the user already has: rename it, rewrite its brief (written as a new version; the old ones are kept), change its schedule or time zone, or disable and enable it. Only what you give changes. Do it when the user asks you to.",
      parameters: Type.Object({
        routineId: Type.String(),
        name: Type.Optional(Type.String()),
        brief: Type.Optional(Type.String()),
        schedule: Type.Optional(schedule),
        timezone: Type.Optional(Type.String()),
        enabled: Type.Optional(Type.Boolean()),
      }),
      execute: async (args) => {
        try {
          const { routineId, ...patch } = args;
          const routine = deps.service.routines.update(routineId, patch);
          await deps.service.audit.record({
            action: "captain.routine.update",
            actorAgentId: captain.agentId,
            data: { routineId, fields: Object.keys(patch) },
          });
          return text(
            json({
              id: routine.id,
              name: routine.name,
              schedule: routine.schedule,
              timezone: routine.timezone,
              enabled: routine.enabled,
              briefVersion: deps.service.routines.store.brief(routine.id)
                ?.version,
            }),
          );
        } catch (error) {
          return toolError(
            error instanceof Error ? error.message : String(error),
          );
        }
      },
    });

    return [
      listAgents,
      readAgent,
      listConversations,
      readConversation,
      readSession,
      listTasks,
      readTask,
      readInbox,
      readMemory,
      readAttachment,
      assign,
      dispatchTask,
      proposeGroup,
      listModels,
      listPersonaCards,
      proposeAgent,
      controlTask,
      updateTask,
      archiveTask,
      unarchiveTask,
      answerInbox,
      relayInboxToUser,
      promptHistory,
      diffPrompt,
      setPrompt,
      rollbackPrompt,
      pauseMemory,
      deleteMemory,
      restoreMemory,
      setSetting,
      settingHistory,
      rollbackSetting,
      requestDeleteAgent,
      recommendAcceptance,
      post,
      listRoutines,
      proposeRoutine,
      updateRoutine,
    ].map((tool) => toKernelTool(tool, () => undefined)) as KernelTool[];
  };
}

export function availableModels(server: AssembledServer | undefined) {
  if (server === undefined) return [];
  const providers = server.wire.snapshot("providers")?.sections.config as
    | ProvidersView
    | undefined;
  const configured = (providers?.providers ?? []).flatMap((provider) => {
    const providerName = providerLabel(provider);
    const missing = keyMissing(provider);
    return provider.models.map((model) => ({
      id: `${provider.id}:${model.id}`,
      provider: provider.id,
      providerName,
      name: model.name ?? model.id,
      available: !missing,
    }));
  });
  const llmSections = server.wire.snapshot("llm")?.sections;
  const accounts = llmSections?.accounts as LlmAccounts | undefined;
  const connectorNames = new Map(
    accounts?.connectors.map((connector) => [connector.id, connector.name]) ??
      [],
  );
  const llmModels = ((llmSections?.models as LlmModel[] | undefined) ?? []).map(
    (model) => ({
      id: `${LLM_PROVIDER_ID}:${model.id}`,
      provider: LLM_PROVIDER_ID,
      providerName: connectorNames.get(model.connector) ?? model.connector,
      name: model.name,
      available: model.available,
      ...(model.reason === undefined
        ? {}
        : { unavailableReason: model.reason.code }),
    }),
  );
  return [...configured, ...llmModels];
}

function assignmentText(result: {
  assignment: { id: string; round: number; targets: { agentId: string }[] };
  messageId: string;
}): string {
  return `Captain assignment ${result.assignment.id} sent (round ${result.assignment.round}) to ${result.assignment.targets
    .map((target) => target.agentId)
    .join(", ")}; message ${result.messageId}.`;
}
