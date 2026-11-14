/**
 * The feed against a real host in this process, over the TUI's own wire: the host makes the
 * agents, the conversation, the replies and their sessions, and the models answer as each test
 * scripts them (`apps/eta/test/support/models.ts`).
 */
import type {
  AgentView,
  ConversationSummary,
  ProjectView,
  SendResult,
} from "@eta/client-contracts";
import type { WireClient } from "../../src/connection/types";
import type { Feed } from "../../src/ext/conversation/feed/store";
import { assistantMessage } from "@eta/core/testing";
import { afterEach, describe, expect, it } from "vitest";
import {
  call,
  gate,
  say,
  scriptedModels,
} from "../../../eta/test/support/models";
import { wireUrl } from "../../src/connection/address";
import { Wire } from "../../src/connection/wire";
import { feedFor, feedItems } from "../../src/ext/conversation/feed/store";
import { baseUrl, testHost } from "../support/host";
import { tempDir, until } from "../support/temp";

const wires: Wire[] = [];
const releases: (() => void)[] = [];

afterEach(() => {
  for (const release of releases.splice(0)) release();
  for (const wire of wires.splice(0)) wire.close();
});

type Models = ReturnType<typeof scriptedModels>["models"];

/** A wire that counts what it is asked to call. */
function counting(wire: Wire): WireClient & { asked: string[] } {
  const asked: string[] = [];
  return {
    store: wire.store,
    asked,
    can: (op) => wire.can(op),
    call: (target, action, args, options) => {
      asked.push(`${target}.${action}:${JSON.stringify(args)}`);
      return wire.call(target, action, args, options);
    },
    subscribe: (target) => wire.subscribe(target),
    onEvent: (target, listener) => wire.onEvent(target, listener),
  };
}

async function connected(models: Models) {
  const host = await testHost({ overrides: { models: models as never } });
  const raw = new Wire({ url: wireUrl(baseUrl(host)) });
  wires.push(raw);
  raw.connect();
  await until(() => raw.store.getState().status === "open", 20_000, "hello");
  const wire = counting(raw);
  const ask = <T>(target: string, action: string, args: unknown) =>
    raw.call<T>(target, action, args);
  const agent = async (name: string) =>
    (
      await ask<{ agent: AgentView }>("agents", "create", {
        name,
        model: "fake:fake-model",
      })
    ).agent;
  const project = async (stewardId?: string) =>
    (
      await ask<{ project: ProjectView }>("projects", "create", {
        path: await tempDir("eta-tui-project-"),
        ...(stewardId === undefined ? {} : { stewardId }),
      })
    ).project;
  const conversation = async (projectId: string, agentIds: string[]) =>
    (
      await ask<{ conversation: ConversationSummary }>(
        "conversations",
        "create",
        {
          projectId,
          agentIds,
        },
      )
    ).conversation;
  const send = (conversationId: string, text: string) =>
    ask<SendResult>("conversations", "send", { conversationId, text });
  return { host, raw, wire, agent, project, conversation, send };
}

/** One agent who is her project's steward, and a conversation with her. */
async function withAda(models: Models) {
  const world = await connected(models);
  const ada = await world.agent("Ada");
  const project = await world.project(ada.id);
  const group = await world.conversation(project.id, [ada.id]);
  return { ...world, ada, group };
}

function follow(feed: Feed): void {
  releases.push(feed.attach());
}

const rowOf = (feed: Feed, id: string) =>
  feed.store.getState().rows.find((row) => row.id === id);

/**
 * A provider that streams `text` and then says nothing more until the run is aborted: a reply that
 * stays mid-sentence for as long as the test needs.
 */
function streamThenHang(
  text: string,
  signal: AbortSignal | undefined,
): unknown {
  // A real provider stamps the message when it starts; the stream is drawn by that stamp.
  const partial = {
    ...assistantMessage({ content: [{ type: "text", text }] }),
    stopReason: "pending",
    timestamp: Date.now(),
  };
  const events = [
    { type: "start", partial },
    { type: "text_start", contentIndex: 0, partial },
    { type: "text_delta", contentIndex: 0, delta: text, partial },
  ];
  const aborted = new Promise<void>((resolve) => {
    if (signal?.aborted === true) resolve();
    else signal?.addEventListener("abort", () => resolve(), { once: true });
  });
  return {
    [Symbol.asyncIterator]: () => {
      let index = 0;
      return {
        next: async () => {
          const event = events[index];
          index += 1;
          if (event !== undefined) return { value: event, done: false };
          await aborted;
          throw new Error("aborted");
        },
      };
    },
    result: async () => {
      await aborted;
      throw new Error("aborted");
    },
  };
}

describe("the feed on a real host", () => {
  it("reads an existing conversation's rows as items", async () => {
    const { models } = scriptedModels(() => say("the answer", "a thought"));
    const world = await withAda(models);
    const sent = await world.send(world.group.id, "the question");
    const feed = feedFor(world.wire, world.group.id);
    follow(feed);
    await until(
      () => rowOf(feed, sent.replies[0]!.id)?.status === "done",
      20_000,
      "the reply",
    );
    await until(
      () => feed.store.getState().agents.length > 0,
      20_000,
      "the agents",
    );
    const state = feed.store.getState();
    expect(state.loaded).toBe(true);
    expect(state.info?.id).toBe(world.group.id);
    expect(state.members.map((member) => member.agentId)).toEqual([
      world.ada.id,
    ]);
    const items = feedItems(state, "en");
    const kinds = items.map((item) => item.kind);
    const reply = sent.replies[0]!.id;
    expect(items).toContainEqual(
      expect.objectContaining({
        kind: "user",
        key: sent.message.id,
        text: "the question",
      }),
    );
    expect(items).toContainEqual({
      kind: "text",
      key: `${reply}:text`,
      text: "the answer",
      streaming: false,
    });
    expect(items).toContainEqual({
      kind: "thinking",
      key: `${reply}:thinking`,
      text: "a thought",
      streaming: false,
    });
    expect(state.info?.kind).toBe("group");
    expect(items).toContainEqual({
      kind: "author",
      key: `${reply}:author`,
      name: "Ada",
      agentId: world.ada.id,
      members: [world.ada.id],
    });
    expect(kinds.indexOf("user")).toBeLessThan(kinds.indexOf("text"));
  });

  it("draws a reply from its session while it works, then from its row once done, keeping the tool's key", async () => {
    const finish = gate();
    const { models, requests } = scriptedModels(async (request) => {
      if (request.index === 0)
        return call("not_a_tool", { what: "x" }, "call-1");
      await finish.opened;
      return say("all done");
    });
    const world = await withAda(models);
    const feed = feedFor(world.wire, world.group.id);
    follow(feed);
    const sent = await world.send(world.group.id, "go");
    const reply = sent.replies[0]!.id;
    const toolKey = `${reply}:call-1`;

    await until(() => requests.length === 2, 20_000, "the second request");
    await until(
      () =>
        feedItems(feed.store.getState(), "en").some(
          (item) => item.key === toolKey,
        ),
      20_000,
      "the live tool call",
    );
    expect(rowOf(feed, reply)?.status).toBe("working");
    const liveTool = feedItems(feed.store.getState(), "en").find(
      (item) => item.key === toolKey,
    );
    expect(liveTool).toMatchObject({
      kind: "tool",
      tool: { id: "call-1", name: "not_a_tool" },
    });

    finish.open();
    await until(() => rowOf(feed, reply)?.status === "done", 20_000, "done");
    const items = feedItems(feed.store.getState(), "en").filter((item) =>
      item.key.startsWith(reply),
    );
    expect(items.map((item) => item.key)).toContain(toolKey);
    expect(items.at(-1)).toEqual({
      kind: "text",
      key: `${reply}:text`,
      text: "all done",
      streaming: false,
    });
    expect(items.find((item) => item.key === toolKey)).toMatchObject({
      progress: undefined,
    });
  });

  it("shows the words of a reply that is still being written", async () => {
    const { models } = scriptedModels(() => say("unused"));
    const base = models.streamSimple;
    let streamed = 0;
    models.streamSimple = (model, context, options) => {
      streamed += 1;
      return streamed === 1
        ? (streamThenHang("half a senten", options?.signal) as never)
        : base(model, context, options);
    };
    const world = await withAda(models);
    const feed = feedFor(world.wire, world.group.id);
    follow(feed);
    const sent = await world.send(world.group.id, "talk");
    const reply = sent.replies[0]!.id;
    await until(
      () =>
        feedItems(feed.store.getState(), "en").some(
          (item) => item.kind === "text" && item.text === "half a senten",
        ),
      20_000,
      "the streamed words",
    );
    expect(rowOf(feed, reply)?.status).toBe("working");
    expect(
      feedItems(feed.store.getState(), "en").find(
        (item) => item.kind === "text",
      ),
    ).toMatchObject({
      streaming: true,
    });
    await world.raw.call("conversations", "stop", {
      conversationId: world.group.id,
    });
    await until(
      () => rowOf(feed, reply)?.status === "stopped",
      20_000,
      "stopped",
    );
    expect(feedItems(feed.store.getState(), "en").at(-1)).toMatchObject({
      kind: "outcome",
      outcome: "stopped",
    });
  });

  it("pages back to the oldest rows", async () => {
    const { models } = scriptedModels(() => say("unused"));
    const world = await connected(models);
    const ada = await world.agent("Ada");
    const ben = await world.agent("Ben");
    // No steward and two members: a message wakes nobody, so each send is one row.
    const project = await world.project();
    const group = await world.conversation(project.id, [ada.id, ben.id]);
    for (let i = 1; i <= 55; i += 1) await world.send(group.id, `message ${i}`);
    const feed = feedFor(world.wire, group.id);
    follow(feed);
    await until(
      () => feed.store.getState().rows.length === 50,
      20_000,
      "the window",
    );
    expect(feed.store.getState().hasOlder).toBe(true);
    expect(feed.store.getState().rows[0]!.text).toBe("message 6");

    await feed.loadOlder();
    const state = feed.store.getState();
    expect(state.rows.map((row) => row.text)).toEqual(
      Array.from({ length: 55 }, (_, i) => `message ${i + 1}`),
    );
    expect(state.hasOlder).toBe(false);
    expect(state.loadingOlder).toBe(false);
    expect(
      world.wire.asked.filter((asked) =>
        asked.startsWith("conversations.history"),
      ),
    ).toHaveLength(1);
  });
});
