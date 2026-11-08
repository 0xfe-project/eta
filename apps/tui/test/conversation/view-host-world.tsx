/**
 * A real host in this process, the TUI's own wire to it, and the whole interface drawn in memory
 * on that wire: what the conversation view and its commands are tested on. The host makes the
 * agents, projects, conversations and replies; the models answer as each test scripts them.
 */
import type {
  AgentView,
  ConversationSummary,
  HistoryResult,
  MessageView,
  ProjectView,
  SendResult,
} from "@eta/client-contracts";
import type { TuiState } from "../../src/config/types";
import type { WireClient } from "../../src/connection/types";
import type { RenderedApp } from "../ui-support/app";
import { afterEach } from "vitest";
import { scriptedModels } from "../../../eta/test/support/models";
import { wireUrl } from "../../src/connection/address";
import { Wire } from "../../src/connection/wire";
import { CONVERSATION_VIEW } from "../../src/ext/conversation/kind";
import { baseUrl, closeHost, testHost } from "../support/host";
import { tempDir, until } from "../support/temp";
import { renderApp } from "../ui-support/app";
import { flush, plain } from "../ui-support/render";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

export type Respond = Parameters<typeof scriptedModels>[0];

/** One call the interface made, its arguments as sent. */
export interface Asked {
  op: string;
  args: Record<string, unknown>;
}

/** A wire that writes down every call it is asked to make, then makes it. */
function recording(wire: Wire): WireClient & { asked: Asked[] } {
  const asked: Asked[] = [];
  return {
    store: wire.store,
    asked,
    can: (op) => wire.can(op),
    call: (target, action, args, options) => {
      asked.push({
        op: `${target}.${action}`,
        args: (args ?? {}) as Record<string, unknown>,
      });
      return wire.call(target, action, args, options);
    },
    subscribe: (target) => wire.subscribe(target),
    onEvent: (target, listener) => wire.onEvent(target, listener),
  };
}

export const KEY = {
  pageUp: "\u001B[5~",
  lineUp: "\u001B[1;2A",
  bottom: "\u001B[1;5F",
  search: "\u0006",
  select: "\u001Bv",
} as const;

/**
 * The real extensions the host worlds draw the interface without. On connecting, the first-time
 * setup opens over the screen when the host has no usable model or no agent. These hosts have no
 * configured model, some tests start with no agent, and a world's wire says hello before the test
 * creates its agents, so the agents list the setup reads can be empty though agents exist. The
 * setup is tested against hosts of its own under `test/ext/`.
 */
export const WITHOUT_SETUP = ["setup"];

export async function hostWorld(respond: Respond) {
  const { models, requests } = scriptedModels(respond);
  const host = await testHost({ overrides: { models: models as never } });
  const raw = new Wire({ url: wireUrl(baseUrl(host)) });
  cleanups.push(() => raw.close());
  raw.connect();
  await until(() => raw.store.getState().status === "open", 20_000, "hello");
  // The eager list comes with hello only; the test follows it on its own, so what it reads of
  // the host does not depend on the interface subscribing.
  const followList = raw.subscribe("conversations");
  cleanups.push(followList);
  const wire = recording(raw);

  const ask = <T,>(target: string, action: string, args: unknown) =>
    raw.call<T>(target, action, args);
  const agent = async (name: string) =>
    (await ask<{ agent: AgentView }>("agents", "create", { name })).agent;
  const project = async (stewardId?: string) =>
    (
      await ask<{ project: ProjectView }>("projects", "create", {
        path: await tempDir("eta-tui-project-"),
        ...(stewardId === undefined ? {} : { stewardId }),
      })
    ).project;
  const conversation = async (
    projectId: string,
    agentIds: string[],
    name?: string,
  ) =>
    (
      await ask<{ conversation: ConversationSummary }>(
        "conversations",
        "create",
        { projectId, agentIds, ...(name === undefined ? {} : { name }) },
      )
    ).conversation;
  const send = (conversationId: string, text: string) =>
    ask<SendResult>("conversations", "send", { conversationId, text });
  /** The conversation's newest rows as the host has them now. */
  const rows = async (conversationId: string) =>
    (
      await ask<HistoryResult>("conversations", "history", {
        conversationId,
        limit: 100,
      })
    ).messages;
  const rowWhere = async (
    conversationId: string,
    found: (row: MessageView) => boolean,
  ) => (await rows(conversationId)).find(found);
  /** The conversation's summary in the eager list the wire holds. */
  const listed = (conversationId: string) =>
    (
      raw.store.getState().targets.conversations?.sections.list as
        | ConversationSummary[]
        | undefined
    )?.find((c) => c.id === conversationId);

  const show = async (state: TuiState, size = { columns: 80, rows: 24 }) => {
    const r = await renderApp({
      patch: { wire },
      state,
      without: WITHOUT_SETUP,
      ...size,
    });
    cleanups.push(() => r.unmount());
    return r;
  };
  const showConversation = (
    id: string,
    size?: { columns: number; rows: number },
  ) => show({ tabs: [{ kind: CONVERSATION_VIEW, id }], activeTab: 0 }, size);

  return {
    host,
    raw,
    wire,
    requests,
    agent,
    project,
    conversation,
    send,
    rows,
    rowWhere,
    listed,
    show,
    showConversation,
    closeHost: () => closeHost(host),
  };
}

/** One agent, Ada, who is her project's steward, and a conversation with her. */
export async function withAda(respond: Respond, name?: string) {
  const world = await hostWorld(respond);
  const ada = await world.agent("Ada");
  const project = await world.project(ada.id);
  const group = await world.conversation(project.id, [ada.id], name);
  return { ...world, ada, project, group };
}

/**
 * A conversation with two members and no steward: a message wakes nobody, so each send is one
 * row and nothing answers.
 */
export async function quietGroup(
  respond: Respond = () => {
    throw new Error("nobody should be asked");
  },
) {
  const world = await hostWorld(respond);
  const ada = await world.agent("Ada");
  const ben = await world.agent("Ben");
  const project = await world.project();
  const group = await world.conversation(project.id, [ada.id, ben.id]);
  return { ...world, ada, ben, project, group };
}

export function screenShows(
  r: RenderedApp,
  text: string | ((screen: string) => boolean),
  timeoutMs = 20_000,
): Promise<void> {
  const holds =
    typeof text === "string" ? (s: string) => s.includes(text) : text;
  return until(
    async () => {
      await flush();
      return holds(plain(r));
    },
    timeoutMs,
    `the screen to show ${String(text)}`,
  );
}

/** The calls of one op the interface made, oldest first. */
export const askedFor = (wire: { asked: Asked[] }, op: string) =>
  wire.asked.filter((asked) => asked.op === op).map((asked) => asked.args);
