/**
 * A host with a client on it, and the few moves every product test makes: an agent, a project, a
 * conversation, a message, and waiting for what the client has been told.
 */
import type {
  AgentArgs,
  AgentView,
  ConversationArgs,
  ConversationSummary,
  MessageView,
  ProjectView,
  SendResult,
  TimelineSection,
} from "@eta/client-contracts";
import type { Host, HostOptions } from "../../src/host";
import type { Client } from "./client";
import { connect, until } from "./client";
import { tempDir, testHost } from "./host";

export interface World {
  host: Host;
  client: Client;
  /** Make an agent. */
  agent: (
    name: string,
    fields?: Partial<AgentArgs["create"]>,
  ) => Promise<AgentView>;
  /** A directory (a fresh one unless `path` is given) registered as a project. */
  project: (fields?: {
    path?: string;
    stewardId?: string | null;
    name?: string;
    /** A machine other than the primary. */
    machineId?: string;
  }) => Promise<ProjectView>;
  /** A group conversation in a project. */
  group: (
    projectId: string,
    agentIds: string[],
    name?: string,
  ) => Promise<ConversationSummary>;
  /** Messages written but not in the conversation yet. */
  held: (conversationId: string) => MessageView[];
  send: (
    conversationId: string,
    text: string,
    extra?: Partial<ConversationArgs["send"]>,
  ) => Promise<SendResult>;
  /** Subscribe to a conversation and wait for its first state. */
  watch: (conversationId: string) => Promise<void>;
  /** The timeline the client holds for a watched conversation. */
  rows: (conversationId: string) => MessageView[];
  /** One row of it. */
  row: (conversationId: string, id: string) => MessageView | undefined;
  /** Wait until a row has one of the statuses. */
  settled: (
    conversationId: string,
    id: string,
    statuses?: string[],
  ) => Promise<MessageView>;
}

export async function world(
  options: Partial<HostOptions> = {},
): Promise<World> {
  const host = await testHost(options);
  const client = await connect(`ws://127.0.0.1:${host.port}/ws`);
  await client.hello();
  // What `hello` carries is a snapshot; the lists stay current for a client that subscribes.
  for (const target of ["agents", "machines", "projects", "conversations"])
    client.subscribe(target);
  const call = async <T>(
    target: string,
    action: string,
    args?: unknown,
  ): Promise<T> => (await client.call(target, action, args)) as T;

  const rows = (conversationId: string): MessageView[] =>
    client.section<TimelineSection>(
      `conversations.${conversationId}`,
      "timeline",
    )?.messages ?? [];

  const row = (conversationId: string, id: string) =>
    rows(conversationId).find((message) => message.id === id);

  /** Messages written but not in the conversation yet: every lane was busy when they were sent. */
  const held = (conversationId: string): MessageView[] =>
    client.section<TimelineSection>(
      `conversations.${conversationId}`,
      "timeline",
    )?.held ?? [];

  return {
    host,
    client,
    async agent(name, fields = {}) {
      const { agent } = await call<{ agent: AgentView }>("agents", "create", {
        name,
        ...fields,
      });
      return agent;
    },
    async project(fields = {}) {
      const path = fields.path ?? (await tempDir("eta-project-"));
      const { project } = await call<{ project: ProjectView }>(
        "projects",
        "create",
        {
          path,
          ...(fields.machineId === undefined
            ? {}
            : { machineId: fields.machineId }),
          ...(fields.stewardId === undefined
            ? {}
            : { stewardId: fields.stewardId }),
          ...(fields.name === undefined ? {} : { name: fields.name }),
        },
      );
      return project;
    },
    async group(projectId, agentIds, name) {
      const { conversation } = await call<{
        conversation: ConversationSummary;
      }>("conversations", "create", {
        projectId,
        agentIds,
        ...(name === undefined ? {} : { name }),
      });
      return conversation;
    },
    send: (conversationId, text, extra = {}) =>
      call<SendResult>("conversations", "send", {
        conversationId,
        text,
        ...extra,
      }),
    async watch(conversationId) {
      client.subscribe(`conversations.${conversationId}`);
      await until(
        () =>
          client.section(`conversations.${conversationId}`, "timeline") !==
          undefined,
      );
    },
    rows,
    held,
    row,
    async settled(
      conversationId,
      id,
      statuses = ["done", "failed", "stopped"],
    ) {
      await until(() => {
        const found = row(conversationId, id);
        return found !== undefined && statuses.includes(found.status);
      });
      return row(conversationId, id)!;
    },
  };
}
