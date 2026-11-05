import type { CaptainPromptKind, InboxResponse } from "@eta/client-contracts";
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
import type { TaskStore } from "../tasks/store";
import type { CaptainMemory } from "./memory";
import type { CaptainService } from "./service";
import { readFile } from "node:fs/promises";
import { defineTool, text, toKernelTool, toolError } from "@eta/harness";
import { Type } from "typebox";
import { interactionId } from "../inbox/store";
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
              bundles: agent.bundles,
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
        "List the task board with status, executor, assignment source and run status.",
      parameters: Type.Object({
        status: Type.Optional(Type.String()),
      }),
      execute(args) {
        return text(
          json(
            deps.board
              .list()
              .filter(
                (task) =>
                  args.status === undefined || task.status === args.status,
              )
              .map((task) => redactValue(task)),
          ),
        );
      },
    });

    const readTask = defineTool({
      name: "captain_read_task",
      description:
        "Read one task, its workspace, runs and full activity timeline. Assignment provenance is included.",
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
        "Send a visible Captain instruction to one or more members of an existing group. With no agentIds, speak to the group's steward, like a user message without mentions. This only chats and authorizes work; the target agents create and execute their own tasks.",
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

    const controlTask = defineTool({
      name: "control_task",
      description:
        "Continue, pause, interrupt, cancel, rerun or delete a task. Normal continuation is a task comment so the executor resumes its own session.",
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
          const result = await deps.service.taskControl(args);
          return text(
            result === null
              ? `Task ${args.taskId} deleted.`
              : `Task #${result.number} ${args.action}: ${result.status}.`,
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
      description:
        "Change a task's title, description or status. This does not change its creator or executor.",
      parameters: Type.Object({
        taskId: Type.String(),
        title: Type.Optional(Type.String()),
        description: Type.Optional(Type.String()),
        status: Type.Optional(
          Type.Union([
            Type.Literal("backlog"),
            Type.Literal("todo"),
            Type.Literal("in_progress"),
            Type.Literal("in_review"),
            Type.Literal("done"),
            Type.Literal("blocked"),
            Type.Literal("cancelled"),
          ]),
        ),
      }),
      execute(args) {
        try {
          const task = deps.board.find(args.taskId);
          if (task === undefined) return toolError("No such task.");
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
          return text(`Task #${updated.number} updated.`, updated);
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
        deps.service.notify(
          "task_acceptance",
          `Captain recommends ${args.recommendation} for task #${task.number}.`,
          { taskId: task.id, recommendation: args.recommendation },
        );
        return text(
          `Task #${task.number}: Captain recommends ${args.recommendation}; the user decides.`,
        );
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
      controlTask,
      updateTask,
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
    ].map((tool) => toKernelTool(tool, () => undefined)) as KernelTool[];
  };
}

function assignmentText(result: {
  assignment: { id: string; round: number; targets: { agentId: string }[] };
  messageId: string;
}): string {
  return `Captain assignment ${result.assignment.id} sent (round ${result.assignment.round}) to ${result.assignment.targets
    .map((target) => target.agentId)
    .join(", ")}; message ${result.messageId}.`;
}
