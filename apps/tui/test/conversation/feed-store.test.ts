/**
 * The feed against a scripted wire, for what a real host does not do on demand: a resync that
 * fails, a tool printing as it runs, a burst of stream events, frames arriving in a chosen order.
 * The paths a real host drives (rows, a reply from working to done, paging, release) are in
 * feed-host.test.ts.
 */
import type {
  ConversationSections,
  MemberView,
  MessageView,
} from "@eta/client-contracts";
import type {
  TargetState,
  WireClient,
  WireEvent,
  WireState,
} from "../../src/connection/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStore } from "zustand/vanilla";
import { feedFor, feedItems } from "../../src/ext/conversation/feed/store";

interface Scripted extends WireClient {
  calls: { target: string; action: string; args: unknown }[];
  subscribed: Map<string, number>;
  /** Settle the oldest pending call of `target.action`. */
  settle: (op: string, outcome: { ok: unknown } | { error: Error }) => void;
  emit: (target: string, event: WireEvent) => void;
  setTarget: (target: string, sections: Record<string, unknown>) => void;
}

function scriptedWire(): Scripted {
  const store = createStore<WireState>(() => ({
    status: "open",
    ops: [],
    mounted: [],
    targets: {},
    missing: {},
    error: undefined,
  }));
  const calls: Scripted["calls"] = [];
  const pending: {
    op: string;
    resolve: (v: unknown) => void;
    reject: (e: Error) => void;
  }[] = [];
  const subscribed = new Map<string, number>();
  const listeners = new Map<string, Set<(event: WireEvent) => void>>();
  return {
    store,
    calls,
    subscribed,
    can: () => true,
    call: <T>(target: string, action: string, args?: unknown) => {
      calls.push({ target, action, args });
      return new Promise<T>((resolve, reject) => {
        pending.push({
          op: `${target}.${action}`,
          resolve: resolve as (v: unknown) => void,
          reject,
        });
      });
    },
    subscribe: (target) => {
      subscribed.set(target, (subscribed.get(target) ?? 0) + 1);
      let done = false;
      return () => {
        if (done) return;
        done = true;
        const left = (subscribed.get(target) ?? 1) - 1;
        if (left === 0) subscribed.delete(target);
        else subscribed.set(target, left);
      };
    },
    onEvent: (target, listener) => {
      const set = listeners.get(target) ?? new Set();
      set.add(listener);
      listeners.set(target, set);
      return () => set.delete(listener);
    },
    settle: (op, outcome) => {
      const index = pending.findIndex((p) => p.op === op);
      if (index < 0) throw new Error(`no pending ${op}`);
      const [waiter] = pending.splice(index, 1);
      if ("ok" in outcome) waiter!.resolve(outcome.ok);
      else waiter!.reject(outcome.error);
    },
    emit: (target, event) => {
      for (const listener of [...(listeners.get(target) ?? [])])
        listener(event);
    },
    setTarget: (target, sections) => {
      const state: TargetState = { sections, revisions: {}, version: 1 };
      store.setState((s) => ({ targets: { ...s.targets, [target]: state } }));
    },
  };
}

function row(seq: number, fields: Partial<MessageView> = {}): MessageView {
  return {
    id: `m${seq}`,
    conversationId: "c1",
    seq,
    kind: "message",
    author: "user",
    agentId: null,
    text: `row ${seq}`,
    thinking: "",
    status: "done",
    revision: 1,
    mentions: [],
    rootMessageId: null,
    replyToId: null,
    data: {},
    createdAt: 0,
    updatedAt: 0,
    ...fields,
  };
}

function conversation(
  members: MemberView[],
  messages: MessageView[],
  held: MessageView[] = [],
  hasMore = false,
): Partial<ConversationSections> {
  return {
    info: { id: "c1", kind: "direct" } as never,
    members,
    timeline: { messages, held, hasMore },
  };
}

const ada = (
  status: MemberView["status"],
  sessionId: string | null = "s1",
): MemberView => ({
  agentId: "ada",
  sessionId,
  lastSeq: 0,
  status,
});

const flushPromises = async () => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
};

afterEach(() => {
  vi.useRealTimers();
});

describe("attach", () => {
  it("subscribes the conversation and the agents, and releases both", () => {
    const wire = scriptedWire();
    const release = feedFor(wire, "c1").attach();
    expect([...wire.subscribed.keys()].sort()).toEqual([
      "agents",
      "conversations.c1",
    ]);
    release();
    expect(wire.subscribed.size).toBe(0);
  });

  it("opens a running member's session with resync before subscribing to it", async () => {
    const wire = scriptedWire();
    const release = feedFor(wire, "c1").attach();
    wire.setTarget("conversations.c1", conversation([ada("working")], []));
    expect(wire.calls).toEqual([
      { target: "sessions", action: "resync", args: { session: "s1" } },
    ]);
    expect(wire.subscribed.has("sessions.s1")).toBe(false);
    wire.settle("sessions.resync", { ok: {} });
    await flushPromises();
    expect(wire.subscribed.get("sessions.s1")).toBe(1);
    release();
    expect(wire.subscribed.size).toBe(0);
  });

  it.each(["idle", "queued"] as const)(
    "leaves an %s member's session alone",
    (status) => {
      const wire = scriptedWire();
      feedFor(wire, "c1").attach();
      wire.setTarget("conversations.c1", conversation([ada(status)], []));
      expect(wire.calls).toEqual([]);
    },
  );

  it("leaves a running member without a session alone", () => {
    const wire = scriptedWire();
    feedFor(wire, "c1").attach();
    wire.setTarget(
      "conversations.c1",
      conversation([ada("working", null)], []),
    );
    expect(wire.calls).toEqual([]);
  });

  it.each(["waiting_for_input", "stopping"] as const)(
    "watches a %s member",
    async (status) => {
      const wire = scriptedWire();
      feedFor(wire, "c1").attach();
      wire.setTarget("conversations.c1", conversation([ada(status)], []));
      wire.settle("sessions.resync", { ok: {} });
      await flushPromises();
      expect(wire.subscribed.get("sessions.s1")).toBe(1);
    },
  );

  it("still subscribes when resync fails, and says the session cannot be read", async () => {
    const wire = scriptedWire();
    const feed = feedFor(wire, "c1");
    feed.attach();
    wire.setTarget(
      "conversations.c1",
      conversation(
        [ada("working")],
        [row(1, { author: "agent", agentId: "ada", status: "working" })],
      ),
    );
    wire.settle("sessions.resync", { error: new Error("no such session") });
    await flushPromises();
    expect(wire.subscribed.get("sessions.s1")).toBe(1);
    expect(feed.store.getState().sessions.get("s1")?.unreadable).toBe(true);
    expect(feedItems(feed.store.getState(), "en")).toMatchObject([
      { kind: "notice", text: "Replying, but its session cannot be read" },
    ]);
  });

  it("resyncs a session once per wire, across members starting again and other feeds", async () => {
    const wire = scriptedWire();
    const feed = feedFor(wire, "c1");
    feed.attach();
    wire.setTarget("conversations.c1", conversation([ada("working")], []));
    wire.settle("sessions.resync", { ok: {} });
    await flushPromises();
    wire.setTarget("conversations.c1", conversation([ada("idle")], []));
    wire.setTarget("conversations.c1", conversation([ada("working")], []));
    feedFor(wire, "c-other").attach();
    wire.setTarget("conversations.c-other", conversation([ada("working")], []));
    await flushPromises();
    expect(wire.calls.filter((c) => c.action === "resync")).toHaveLength(1);
    expect(wire.subscribed.get("sessions.s1")).toBe(2);
    // A new wire is a new host: it asks again.
    const fresh = scriptedWire();
    feedFor(fresh, "c1").attach();
    fresh.setTarget("conversations.c1", conversation([ada("working")], []));
    expect(fresh.calls.filter((c) => c.action === "resync")).toHaveLength(1);
  });

  it("releases a member's session once it stops running", async () => {
    const wire = scriptedWire();
    feedFor(wire, "c1").attach();
    wire.setTarget("conversations.c1", conversation([ada("working")], []));
    wire.settle("sessions.resync", { ok: {} });
    await flushPromises();
    wire.setTarget("conversations.c1", conversation([ada("idle")], []));
    expect(wire.subscribed.has("sessions.s1")).toBe(false);
  });

  it("does not subscribe a session whose resync settles after the release", async () => {
    const wire = scriptedWire();
    const release = feedFor(wire, "c1").attach();
    wire.setTarget("conversations.c1", conversation([ada("working")], []));
    release();
    wire.settle("sessions.resync", { ok: {} });
    await flushPromises();
    expect(wire.subscribed.size).toBe(0);
  });

  it("can be attached twice; the subscriptions stay until the last release", () => {
    const wire = scriptedWire();
    const feed = feedFor(wire, "c1");
    const one = feed.attach();
    const two = feed.attach();
    one();
    expect(wire.subscribed.has("conversations.c1")).toBe(true);
    two();
    expect(wire.subscribed.size).toBe(0);
  });
});

describe("what the feed reads", () => {
  it("reads the session's transcript, its own stream and its question", async () => {
    const wire = scriptedWire();
    const feed = feedFor(wire, "c1");
    feed.attach();
    wire.setTarget(
      "conversations.c1",
      conversation([ada("waiting_for_input")], []),
    );
    wire.settle("sessions.resync", { ok: {} });
    await flushPromises();
    const streaming = { role: "assistant", content: [], timestamp: 3 };
    const messages = [
      { entryId: "e1", seq: 1, at: 0, message: { role: "user", content: "q" } },
    ];
    wire.setTarget("sessions.s1", {
      transcript: { messages },
      core: { session: "s1", running: true, streaming },
      ask: { pending: { questionId: "q1", question: "Which one?" } },
    });
    const live = feed.store.getState().sessions.get("s1")!;
    expect(live.rows).toBe(messages);
    expect(live.coreStreaming).toBe(streaming);
    expect(live.question).toBe("Which one?");
    expect(live.unreadable).toBe(false);
  });

  it("says a session the host answered target:missing for cannot be read", async () => {
    const wire = scriptedWire();
    const feed = feedFor(wire, "c1");
    feed.attach();
    wire.setTarget("conversations.c1", conversation([ada("working")], []));
    wire.settle("sessions.resync", { ok: {} });
    await flushPromises();
    wire.store.setState({ missing: { "sessions.s1": true } });
    expect(feed.store.getState().sessions.get("s1")?.unreadable).toBe(true);
  });
});

describe("the session's events", () => {
  async function watching() {
    vi.useFakeTimers();
    const wire = scriptedWire();
    const feed = feedFor(wire, "c1");
    feed.attach();
    wire.setTarget("conversations.c1", conversation([ada("working")], []));
    wire.settle("sessions.resync", { ok: {} });
    await flushPromises();
    const live = () => feed.store.getState().sessions.get("s1")!;
    return { wire, feed, live };
  }
  const message = (text: string) => ({
    role: "assistant",
    content: [{ type: "text", text }],
    timestamp: 5,
  });

  it.each(["turn:run-start", "turn:run-end", "generation:interrupted"])(
    "clear the streamed message on %s",
    async (name) => {
      const { wire, live } = await watching();
      wire.emit("sessions.s1", {
        name: "message:update",
        data: { message: message("a") },
      });
      vi.advanceTimersByTime(40);
      wire.emit("sessions.s1", { name, data: {} });
      vi.advanceTimersByTime(40);
      expect(live().streamed).toBeUndefined();
    },
  );

  it("collect what a running tool printed, at most once per 100 ms, and drop it when the call ends", async () => {
    const { wire, live } = await watching();
    const update = (id: string, texts: string[]) =>
      wire.emit("sessions.s1", {
        name: "tool:update",
        data: {
          toolCallId: id,
          partialResult: {
            content: [
              ...texts.map((text) => ({ type: "text", text })),
              { type: "image" },
            ],
          },
        },
      });
    update("c1", ["line 1", "line 2"]);
    update("c2", ["other"]);
    vi.advanceTimersByTime(99);
    expect(live().progress.size).toBe(0);
    vi.advanceTimersByTime(1);
    expect(live().progress).toEqual(
      new Map([
        ["c1", "line 1\nline 2"],
        ["c2", "other"],
      ]),
    );
    wire.emit("sessions.s1", { name: "tool:end", data: { toolCallId: "c1" } });
    vi.advanceTimersByTime(100);
    expect(live().progress).toEqual(new Map([["c2", "other"]]));
    wire.emit("sessions.s1", { name: "turn:run-end", data: {} });
    vi.advanceTimersByTime(100);
    expect(live().progress.size).toBe(0);
  });

  it("are not heard after the member stops running", async () => {
    const { wire, live } = await watching();
    wire.setTarget("conversations.c1", conversation([ada("idle")], []));
    wire.emit("sessions.s1", {
      name: "message:update",
      data: { message: message("late") },
    });
    vi.advanceTimersByTime(100);
    expect(live().streamed).toBeUndefined();
  });

  it("make the live items: the stream shows as the reply's text", async () => {
    const { wire, feed } = await watching();
    wire.setTarget(
      "conversations.c1",
      conversation(
        [ada("working")],
        [row(1, { author: "agent", agentId: "ada", status: "working" })],
      ),
    );
    wire.setTarget("sessions.s1", {
      transcript: { messages: [] },
      core: { session: "s1", running: true },
    });
    wire.emit("sessions.s1", {
      name: "message:update",
      data: { message: message("hello wor") },
    });
    vi.advanceTimersByTime(40);
    expect(feedItems(feed.store.getState(), "en")).toMatchObject([
      { kind: "text", text: "hello wor", streaming: true },
    ]);
  });
});

describe("loadOlder", () => {
  it("asks for 50 rows before the oldest held, once while one is on its way, and keeps them", async () => {
    const wire = scriptedWire();
    const feed = feedFor(wire, "c1");
    feed.attach();
    wire.setTarget(
      "conversations.c1",
      conversation([], [row(60), row(61)], [], true),
    );
    const first = feed.loadOlder();
    void feed.loadOlder();
    expect(feed.store.getState().loadingOlder).toBe(true);
    expect(wire.calls).toEqual([
      {
        target: "conversations",
        action: "history",
        args: { conversationId: "c1", beforeSeq: 60, limit: 50 },
      },
    ]);
    wire.settle("conversations.history", {
      ok: { conversationId: "c1", messages: [row(58), row(59)], hasMore: true },
    });
    await first;
    const state = feed.store.getState();
    expect(state.loadingOlder).toBe(false);
    expect(state.rows.map((r) => r.seq)).toEqual([58, 59, 60, 61]);
    // The next window does not take the older page away.
    wire.setTarget(
      "conversations.c1",
      conversation([], [row(60), row(61), row(62)]),
    );
    expect(feed.store.getState().rows.map((r) => r.seq)).toEqual([
      58, 59, 60, 61, 62,
    ]);
  });

  it("rejects with the host's error and can be asked again", async () => {
    const wire = scriptedWire();
    const feed = feedFor(wire, "c1");
    feed.attach();
    wire.setTarget("conversations.c1", conversation([], [row(5)], [], true));
    const failing = feed.loadOlder();
    wire.settle("conversations.history", { error: new Error("boom") });
    await expect(failing).rejects.toThrow("boom");
    expect(feed.store.getState().loadingOlder).toBe(false);
    void feed.loadOlder();
    expect(wire.calls).toHaveLength(2);
  });
});

describe("whether older rows exist", () => {
  it("is what the window says, whatever seq its oldest row has", async () => {
    const wire = scriptedWire();
    const feed = feedFor(wire, "c1");
    feed.attach();
    // The first message is held, or was recalled: the oldest row is seq 2 and nothing is older.
    wire.setTarget("conversations.c1", conversation([], [row(2), row(3)]));
    expect(feed.store.getState().hasOlder).toBe(false);
    await feed.loadOlder();
    expect(wire.calls).toEqual([]);
    wire.setTarget(
      "conversations.c1",
      conversation([], [row(1), row(2)], [], true),
    );
    expect(feed.store.getState().hasOlder).toBe(true);
  });

  it("is what the last page said once one came, even as the window moves on", async () => {
    const wire = scriptedWire();
    const feed = feedFor(wire, "c1");
    feed.attach();
    wire.setTarget(
      "conversations.c1",
      conversation([], [row(60), row(61)], [], true),
    );
    const loading = feed.loadOlder();
    wire.settle("conversations.history", {
      ok: {
        conversationId: "c1",
        messages: [row(58), row(59)],
        hasMore: false,
      },
    });
    await loading;
    expect(feed.store.getState().hasOlder).toBe(false);
    wire.setTarget(
      "conversations.c1",
      conversation([], [row(61), row(62)], [], true),
    );
    expect(feed.store.getState().hasOlder).toBe(false);
    await feed.loadOlder();
    expect(wire.calls).toHaveLength(1);
  });

  it("stops at an empty page, whatever it says about more", async () => {
    const wire = scriptedWire();
    const feed = feedFor(wire, "c1");
    feed.attach();
    wire.setTarget("conversations.c1", conversation([], [row(5)], [], true));
    const loading = feed.loadOlder();
    wire.settle("conversations.history", {
      ok: { conversationId: "c1", messages: [], hasMore: true },
    });
    await loading;
    expect(feed.store.getState().hasOlder).toBe(false);
    await feed.loadOlder();
    expect(wire.calls).toHaveLength(1);
  });
});

describe("a stream left over from an earlier watch", () => {
  const message = (text: string, timestamp = 5) => ({
    role: "assistant",
    content: [{ type: "text", text }],
    timestamp,
  });
  const reply = (status: MessageView["status"]) =>
    row(1, { author: "agent", agentId: "ada", status });

  async function streamedThenStopped() {
    vi.useFakeTimers();
    const wire = scriptedWire();
    const feed = feedFor(wire, "c1");
    const release = feed.attach();
    wire.setTarget(
      "conversations.c1",
      conversation([ada("working")], [reply("working")]),
    );
    wire.settle("sessions.resync", { ok: {} });
    await flushPromises();
    wire.setTarget("sessions.s1", {
      transcript: { messages: [] },
      core: { session: "s1", running: true },
    });
    wire.emit("sessions.s1", {
      name: "message:update",
      data: { message: message("half an old answ") },
    });
    wire.emit("sessions.s1", {
      name: "tool:update",
      data: {
        toolCallId: "t1",
        partialResult: { content: [{ type: "text", text: "old output" }] },
      },
    });
    vi.advanceTimersByTime(100);
    const live = () => feed.store.getState().sessions.get("s1")!;
    expect(live().streamed).toEqual(message("half an old answ"));
    return { wire, feed, release, live };
  }

  it("is dropped when the member stops running before turn:run-end is heard", async () => {
    const { wire, live } = await streamedThenStopped();
    wire.setTarget(
      "conversations.c1",
      conversation([ada("idle")], [reply("done")]),
    );
    expect(live().streamed).toBeUndefined();
    expect(live().progress.size).toBe(0);
  });

  it("is not drawn as the next reply of the same session", async () => {
    const { wire, feed } = await streamedThenStopped();
    wire.setTarget(
      "conversations.c1",
      conversation([ada("idle")], [reply("done")]),
    );
    wire.setTarget(
      "conversations.c1",
      conversation(
        [ada("working")],
        [
          reply("done"),
          row(2, { author: "agent", agentId: "ada", status: "working" }),
        ],
      ),
    );
    await flushPromises();
    const texts = feedItems(feed.store.getState(), "en").map((item) =>
      "text" in item ? item.text : "",
    );
    expect(texts.join("\n")).not.toContain("half an old answ");
  });

  it("is dropped when the view lets go of the conversation", async () => {
    const { release, live } = await streamedThenStopped();
    release();
    expect(live().streamed).toBeUndefined();
    expect(live().progress.size).toBe(0);
  });

  it("is dropped at once when a new turn starts", async () => {
    const { wire, live } = await streamedThenStopped();
    wire.emit("sessions.s1", { name: "turn:run-start", data: {} });
    expect(live().streamed).toBeUndefined();
  });
});

describe("a resync that failed", () => {
  it("is asked again the next time the session is watched, and the session reads again once it answers", async () => {
    const wire = scriptedWire();
    const feed = feedFor(wire, "c1");
    feed.attach();
    const working = conversation(
      [ada("working")],
      [row(1, { author: "agent", agentId: "ada", status: "working" })],
    );
    wire.setTarget("conversations.c1", working);
    wire.settle("sessions.resync", { error: new Error("not yet") });
    await flushPromises();
    expect(feed.store.getState().sessions.get("s1")?.unreadable).toBe(true);
    wire.setTarget("conversations.c1", conversation([ada("idle")], []));
    wire.setTarget("conversations.c1", working);
    expect(wire.calls.filter((c) => c.action === "resync")).toHaveLength(2);
    wire.settle("sessions.resync", { ok: {} });
    await flushPromises();
    expect(feed.store.getState().sessions.get("s1")?.unreadable).toBe(false);
  });

  it("reads again once the session's sections arrive", async () => {
    const wire = scriptedWire();
    const feed = feedFor(wire, "c1");
    feed.attach();
    wire.setTarget("conversations.c1", conversation([ada("working")], []));
    wire.settle("sessions.resync", { error: new Error("not yet") });
    await flushPromises();
    expect(feed.store.getState().sessions.get("s1")?.unreadable).toBe(true);
    wire.setTarget("sessions.s1", { transcript: { messages: [] } });
    expect(feed.store.getState().sessions.get("s1")?.unreadable).toBe(false);
  });
});
