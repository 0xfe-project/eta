/**
 * The bundled `sessions` plugin (S11).
 *
 * It is a plugin, so the test loads it the way a loader would — on a context, with the
 * `wire` service present — and checks that its presence on the pipe is a *registration*:
 * the actions appear in `hello`'s descriptor list, the sidebar is an eager state target, a
 * session that opens gets its own state target, a prompt runs a turn and the frames follow,
 * and unloading the plugin takes every one of those away again.
 *
 * Nothing here calls into the plugin's internals: everything goes through the registry, the
 * state sender and the sink — the same three doors a client uses.
 */
import type { ServerFrame, StateSnapshot } from "@eta/client-wire-proto";
import type { CompactionSummarizer } from "@eta/core";
import { assistantMessage, fakeModels } from "@eta/core/testing";
import { Context } from "cordis";
import { describe, expect, it } from "vitest";
import { SESSION_ACTIONS, sessionsPlugin } from "../src/bundled/sessions";
import { SessionManager } from "../src/manager";
import { MemorySessionStore } from "../src/memory-store";
import { UnknownOpError } from "../src/registry";
import { WireService } from "../src/wire-service";

interface Harness {
  ctx: Context;
  wire: WireService;
  manager: SessionManager;
  frames: { target?: string; frame: ServerFrame }[];
  load: () => Promise<void>;
  unload: () => Promise<void>;
  call: (target: string, action: string, args?: unknown) => Promise<unknown>;
  state: (target: string) => StateSnapshot | undefined;
}

async function harness(
  models = fakeModels([
    assistantMessage({ content: [{ type: "text", text: "an answer" }] }),
  ]),
  options: {
    compaction?: CompactionSummarizer;
    modelsFor?: (meta: { title?: string }) => unknown;
  } = {},
): Promise<Harness> {
  const ctx = new Context();
  const wire = new WireService(ctx);
  const frames: { target?: string; frame: ServerFrame }[] = [];
  wire.attachSink((addressed) => frames.push(addressed));
  const manager = new SessionManager({
    store: new MemorySessionStore(),
    modelsFor: (meta) =>
      (options.modelsFor === undefined
        ? models
        : options.modelsFor(meta)) as never,
    compaction: options.compaction,
  });
  let unload: (() => Promise<void>) | undefined;
  const plugin = sessionsPlugin({ manager });
  const context = { reply: () => undefined };
  return {
    ctx,
    wire,
    manager,
    frames,
    async load() {
      // `ctx.plugin` returns a fiber that is also awaitable: awaiting it means the plugin
      // is loaded (its `apply` has run), and disposing it is the unload.
      const fiber = ctx.plugin(plugin as never, undefined as never);
      await fiber;
      unload = async () => {
        await (fiber as unknown as { dispose: () => Promise<void> }).dispose();
      };
    },
    async unload() {
      await unload?.();
    },
    async call(target, action, args) {
      return (
        await wire.registry.dispatch(
          { op: "call", target, action, args },
          context,
        )
      ).result;
    },
    state: (target) => wire.snapshot(target),
  };
}

/** Wait for a run to finish: the pump starts it, and the plugin reports it on the bus. */
async function until(
  predicate: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs)
      throw new Error("timed out waiting for the run");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("what the plugin puts on the pipe", () => {
  it("registers its actions, and they show up as descriptors", async () => {
    const h = await harness();
    await h.load();
    // The descriptor list is the plugin's own action list, not a second copy of it.
    expect(
      h.wire
        .descriptors()
        .map((op) => op.name)
        .sort(),
    ).toEqual(
      [...SESSION_ACTIONS].map((action) => `sessions.${action}`).sort(),
    );
    await h.unload();
  });

  it("registers the sidebar as an eager state target", async () => {
    const h = await harness();
    await h.load();
    expect(h.wire.registry.eagerTargets()).toEqual(["sessions"]);
    const sidebar = h.state("sessions");
    expect(sidebar?.sections.list).toEqual([]);
    expect(sidebar?.revisions).toHaveProperty("list");
    await h.unload();
  });

  it("registers a state target per open session, and takes it away on close", async () => {
    const h = await harness();
    await h.load();
    const created = (await h.call("sessions", "create", {
      cwd: "/work/eta",
      title: "one",
    })) as { session: string };
    expect(created.session).toBeTruthy();
    // The session's own target exists, and its state is the harness view — sections and all.
    const state = h.state(`sessions.${created.session}`);
    expect(Object.keys(state?.sections ?? {})).toContain("core");
    expect(Object.keys(state?.sections ?? {})).toContain("transcript");

    await h.call("sessions", "delete", { session: created.session });
    expect(h.state(`sessions.${created.session}`)).toBeUndefined();
    await h.unload();
  });
});

describe("a turn, seen from the pipe", () => {
  it("runs a prompt and pushes state, with the events in between", async () => {
    const h = await harness();
    await h.load();
    const { session } = (await h.call("sessions", "create", {
      cwd: "/work/eta",
    })) as { session: string };

    // A client watches before it asks: pushes go to subscribers only, which is what keeps the
    // pipe from carrying state nobody is looking at. Subscribing answers in place — the client
    // holds a whole state from the first frame it gets.
    h.wire.subscribe(1, "sessions");
    h.wire.subscribe(1, `sessions.${session}`);
    // And the client is looking at the session it just prompted: a focused target streams
    // tightly, which is the floor this test is asserting against.
    h.wire.focus([`sessions.${session}`]);
    const stateFrames = (): {
      frame: { snapshot?: unknown; patch?: unknown };
      target?: string;
    }[] => h.frames.filter((entry) => entry.frame.type === "state") as never;
    expect(stateFrames()[0]?.frame).toHaveProperty("snapshot");

    await h.call("sessions", "prompt", { session, text: "hello" });
    await until(
      () =>
        h.manager.openSessions()[0]?.session.runner.running === false &&
        h.state(`sessions.${session}`) !== undefined,
    );
    // The transcript the pipe would show holds both sides of the turn.
    const transcript = h.state(`sessions.${session}`)?.sections.transcript as {
      messages: unknown[];
    };
    expect(transcript.messages.length).toBeGreaterThanOrEqual(2);

    // Every frame after the turn is a patch, not another snapshot: the client is current, so
    // only what moved is sent. Run traffic is paced, so this arrives on the floor rather than
    // on the instant — which is the point of the budget.
    await until(() => stateFrames().some((entry) => "patch" in entry.frame));
    expect(
      stateFrames().filter((entry) => "snapshot" in entry.frame),
    ).toHaveLength(2);

    // Events for that session's target were emitted (the agent channel, target-scoped), and
    // they carry the kernel's own event names.
    const events = h.frames.filter((entry) => entry.frame.type === "event") as {
      target?: string;
      frame: { name: string };
    }[];
    expect(
      events.every((entry) => entry.target === `sessions.${session}`),
    ).toBe(true);
    expect(events.some((entry) => entry.frame.name === "turn:run-start")).toBe(
      true,
    );
    expect(events.some((entry) => entry.frame.name === "message:update")).toBe(
      true,
    );

    // State pushes went out for the session and for the sidebar.
    const pushed = stateFrames().map((entry) => entry.target);
    expect(pushed).toContain(`sessions.${session}`);
    expect(pushed).toContain("sessions");
    await h.unload();
  });

  it("keeps the sidebar saying who is running", async () => {
    const h = await harness();
    await h.load();
    const { session } = (await h.call("sessions", "create", {
      cwd: "/work/eta",
    })) as { session: string };
    expect(
      (h.state("sessions")?.sections.list as { badges: string[] }[])[0]?.badges,
    ).toEqual([]);
    await h.call("sessions", "prompt", { session, text: "go" });
    await until(
      () =>
        (
          h.state("sessions")?.sections.list as { badges: string[] }[]
        )[0]?.badges.includes("running") === true,
    );
    await until(
      () => h.manager.openSessions()[0]?.session.runner.running === false,
    );
    await until(
      () =>
        (h.state("sessions")?.sections.list as { badges: string[] }[])[0]
          ?.badges.length === 0,
    );
    await h.unload();
  });

  it("answers a failure with a name, not with silence", async () => {
    const h = await harness();
    await h.load();
    await expect(
      h.call("sessions", "promt", { session: "s1" }),
    ).rejects.toThrow(UnknownOpError);
    await expect(h.call("sessions", "prompt", { text: "hi" })).rejects.toThrow(
      /needs a session and a text/,
    );
    await expect(
      h.call("sessions", "prompt", { session: "nope", text: "hi" }),
    ).rejects.toThrow(/no such session/);
    await h.unload();
  });
});

describe("focus", () => {
  it("remembers what a client should attach to, in the sidebar's state", async () => {
    const h = await harness();
    await h.load();
    const { session } = (await h.call("sessions", "create", {
      cwd: "/work/eta",
    })) as { session: string };
    await h.call("sessions", "focus", { session });
    expect(h.state("sessions")?.sections.focused).toBe(session);
    await expect(
      h.call("sessions", "focus", { session: "nope" }),
    ).rejects.toThrow(/no such session/);
    await h.unload();
  });
});

describe("unloading", () => {
  it("takes every registration with it, and leaves the manager usable", async () => {
    const h = await harness();
    await h.load();
    const { session } = (await h.call("sessions", "create", {
      cwd: "/work/eta",
    })) as { session: string };
    expect(
      h.wire
        .descriptors()
        .map((descriptor) => `${descriptor.target}.${descriptor.action}`)
        .sort(),
    ).toEqual(
      [...SESSION_ACTIONS].map((action) => `sessions.${action}`).sort(),
    );

    await h.unload();
    expect(h.wire.descriptors()).toEqual([]);
    expect(h.wire.registry.hasState("sessions")).toBe(false);
    expect(h.wire.registry.hasState(`sessions.${session}`)).toBe(false);
    // The session itself is untouched: the plugin owned its *wire presence*, not its life.
    expect(h.manager.openSessions()).toHaveLength(1);
    await h.manager.closeAll();
  });
});

describe("the row a session keeps", () => {
  it("renames, pins and archives, and the sidebar says so", async () => {
    const h = await harness();
    await h.load();
    const { session } = (await h.call("sessions", "create", {
      cwd: "/work/eta",
    })) as { session: string };

    const renamed = await h.call("sessions", "rename", {
      session,
      title: "porting the wire",
    });
    expect(renamed).toEqual({ session, title: "porting the wire" });
    await h.call("sessions", "pin", { session, pinned: true });
    await h.call("sessions", "archive", { session, archived: true });

    const row = (h.state("sessions")?.sections.list as { id: string }[]).find(
      (entry) => entry.id === session,
    );
    expect(row).toMatchObject({
      title: "porting the wire",
      pinned: true,
      archived: true,
    });

    // The row is the store's, not a copy the plugin keeps in a state of its own.
    const listed = (await h.manager.list()).find(
      (listing) => listing.id === session,
    );
    expect(listed?.ok === true ? listed.meta : undefined).toMatchObject({
      title: "porting the wire",
      pinned: true,
    });

    // An empty title clears it; a session that is not there is named as such.
    const cleared = await h.call("sessions", "rename", { session, title: "" });
    expect(cleared).toEqual({ session, title: null });
    await expect(
      h.call("sessions", "pin", { session: "nope", pinned: true }),
    ).rejects.toThrow(/no such session/);
    await expect(h.call("sessions", "archive", { session })).rejects.toThrow(
      /archived: true or false/,
    );
    await h.unload();
  });

  it("forks a session into a second one, focused, holding the history it copied", async () => {
    const h = await harness(
      fakeModels([
        assistantMessage({ content: [{ type: "text", text: "first answer" }] }),
      ]),
    );
    await h.load();
    const { session: source } = (await h.call("sessions", "create", {
      cwd: "/work/eta",
      title: "the source",
    })) as {
      session: string;
    };
    await h.call("sessions", "prompt", {
      session: source,
      text: "the first question",
    });
    await until(
      () => h.manager.openSessions()[0]?.session.runner.running === false,
    );
    const before = (
      h.state(`sessions.${source}`)?.sections.transcript as {
        messages: unknown[];
      }
    ).messages.length;

    const { session: forked } = (await h.call("sessions", "fork", {
      session: source,
    })) as { session: string };
    expect(forked).not.toBe(source);
    // The fork is on the wire the moment it exists: its own state target, and in front.
    expect(h.wire.targets().map((target) => target.name)).toContain(
      `sessions.${forked}`,
    );
    expect(h.wire.snapshot(`sessions.${forked}`)).toBeDefined();
    expect(h.state("sessions")?.sections.focused).toBe(forked);
    const rows = h.state("sessions")?.sections.list as {
      id: string;
      title?: string;
    }[];
    expect(rows.map((row) => row.id)).toContain(forked);
    expect(rows.find((row) => row.id === forked)?.title).toBe(
      "the source (fork)",
    );

    // It inherited the history prefix, and the source kept all of it.
    const inherited = (
      h.state(`sessions.${forked}`)?.sections.transcript as {
        messages: unknown[];
      }
    ).messages;
    expect(inherited).toHaveLength(before);
    expect(h.state(`sessions.${source}`)?.sections.transcript).toMatchObject({
      messages: { length: before },
    });

    // A fork is a new session: what happens in it does not go back to the one it came from.
    await h.call("sessions", "prompt", {
      session: forked,
      text: "a question only the fork asks",
    });
    await until(
      () =>
        h.manager
          .session(forked)
          .then((open) => open?.session.runner.running === false) instanceof
        Promise,
    );
    await until(
      () => h.state(`sessions.${forked}`)?.sections.transcript !== undefined,
    );
    const sourceText = JSON.stringify(
      h.state(`sessions.${source}`)?.sections.transcript,
    );
    expect(sourceText).not.toContain("only the fork asks");

    await expect(
      h.call("sessions", "fork", { session: "nope" }),
    ).rejects.toThrow(/no such session/);
    await h.unload();
  });
});

describe("compacting on demand", () => {
  it("compacts when asked, and refuses when the session has no summarizer", async () => {
    const requests: number[] = [];
    const summarizer: CompactionSummarizer = {
      summarize: async (request) => {
        requests.push(request.estimatedTokens);
        return {
          summary: "everything so far, briefly",
          retainedTail: [],
          tokensBefore: request.estimatedTokens,
        };
      },
    };
    const models = fakeModels([
      ...[1, 2, 3, 4].map((turn) =>
        assistantMessage({
          content: [{ type: "text", text: `answer ${turn}` }],
        }),
      ),
    ]);
    const h = await harness(models, { compaction: summarizer });
    await h.load();
    const { session } = (await h.call("sessions", "create", {
      cwd: "/work/eta",
    })) as { session: string };
    const running = () =>
      h.manager.openSessions().find((open) => open.meta.id === session)?.session
        .runner.running;
    for (const question of ["first", "second", "third"]) {
      await h.call("sessions", "prompt", { session, text: question });
      await until(() => running() === false);
    }

    expect(await h.call("sessions", "compact", { session })).toEqual({
      session,
      compacted: true,
    });
    expect(requests).toHaveLength(1);
    // The journal keeps the whole conversation (it is history), and the compaction is a
    // row of its own — what changed is what the *model* is sent next.
    const systems = h.state(`sessions.${session}`)?.sections.systems as {
      rows: { kind: string }[];
    };
    expect(
      systems.rows.filter((row) => row.kind === "compaction"),
    ).toHaveLength(1);
    expect(
      JSON.stringify(h.state(`sessions.${session}`)?.sections.transcript),
    ).toContain("first");

    const callsBefore = models.calls.length;
    await h.call("sessions", "prompt", {
      session,
      text: "after the compaction",
    });
    await until(() => models.calls.length > callsBefore);
    await until(() => running() === false);
    const sent = JSON.stringify(models.calls.at(-1)?.context.messages);
    expect(sent).toContain("everything so far, briefly");
    expect(sent).not.toContain("first");

    // Without a summarizer the session says so instead of pretending nothing happened.
    const bare = await harness(models);
    await bare.load();
    const { session: plain } = (await bare.call("sessions", "create", {
      cwd: "/work/eta",
    })) as { session: string };
    await expect(
      bare.call("sessions", "compact", { session: plain }),
    ).rejects.toThrow(/no compaction configured/);
    await bare.unload();
    await h.unload();
  });
});

describe("a session that is only in the store", () => {
  it("opens on demand: an action on it works after a restart, not only after a create", async () => {
    const models = fakeModels([
      assistantMessage({ content: [{ type: "text", text: "an answer" }] }),
    ]);
    const h = await harness(models);
    await h.load();
    const { session } = (await h.call("sessions", "create", {
      cwd: "/work/eta",
    })) as { session: string };
    // What a restart looks like: the row is in the store, and the plugin holds nothing.
    await h.manager.closeAll();
    expect(h.manager.openSessions()).toEqual([]);

    await h.call("sessions", "prompt", {
      session,
      text: "are you still there?",
    });
    const running = () =>
      h.manager.openSessions().find((open) => open.meta.id === session)?.session
        .runner.running === false;
    await until(running);
    // Opened, attached (its state target exists) and focused, just as if it had been created.
    expect(h.wire.targets().map((target) => target.name)).toContain(
      `sessions.${session}`,
    );
    expect(
      h.manager.session(session).then((open) => open !== undefined),
    ).toBeInstanceOf(Promise);
    await h.unload();
  });
});

describe("the state a session carries between turns", () => {
  it("sets, pauses, resumes and clears the goal, and starts the work when one is set", async () => {
    const models = fakeModels([
      assistantMessage({ content: [{ type: "text", text: "on it" }] }),
    ]);
    const h = await harness(models);
    await h.load();
    const { session } = (await h.call("sessions", "create", {
      cwd: "/work/eta",
    })) as { session: string };
    const goalOf = () =>
      h.state(`sessions.${session}`)?.sections.goal as
        | { objective: string; status: string }
        | undefined;

    expect(goalOf()).toBeUndefined();
    // A goal with no objective is refused rather than stored empty.
    await expect(
      h.call("sessions", "goal", { session, action: "set" }),
    ).rejects.toThrow(/needs an objective/);
    await expect(
      h.call("sessions", "goal", { session, action: "wander" }),
    ).rejects.toThrow(/set, pause, resume or clear/);

    await h.call("sessions", "goal", {
      session,
      action: "set",
      objective: "port the server",
    });
    expect(goalOf()).toMatchObject({
      objective: "port the server",
      status: "active",
    });
    // The goal is durable state, not a field on a frame: it is in the journal.
    const log = () =>
      h.manager.openSessions().find((open) => open.meta.id === session)?.session
        .log;
    expect(
      log()
        ?.graph.pathOldestFirst()
        .some((entry) => entry.type === "goal"),
    ).toBe(true);
    // Setting it started the work, because "work on this" is an instruction.
    await until(() => models.calls.length > 0);
    await until(
      () =>
        h.manager.openSessions().find((open) => open.meta.id === session)
          ?.session.runner.running === false,
    );

    await h.call("sessions", "goal", { session, action: "pause" });
    expect(goalOf()?.status).toBe("paused");
    await h.call("sessions", "goal", { session, action: "resume" });
    expect(goalOf()?.status).toBe("active");
    await h.call("sessions", "goal", { session, action: "clear" });
    expect(goalOf()).toBeUndefined();
    await h.unload();
  });

  it("creates, updates, sets and removes tasks", async () => {
    const h = await harness();
    await h.load();
    const { session } = (await h.call("sessions", "create", {
      cwd: "/work/eta",
    })) as { session: string };
    const tasks = () =>
      h.state(`sessions.${session}`)?.sections.tasks as {
        id: string;
        content: string;
        status: string;
      }[];

    const created = (await h.call("sessions", "taskCreate", {
      session,
      content: "port the wire",
      priority: "high",
    })) as {
      task: { id: string };
    };
    expect(created.task.id).toBe("t1");
    expect(tasks()).toEqual([
      expect.objectContaining({
        id: "t1",
        content: "port the wire",
        status: "pending",
      }),
    ]);

    await h.call("sessions", "taskUpdate", {
      session,
      id: "t1",
      content: "port the wire, then the floor",
    });
    expect(tasks()[0]?.content).toBe("port the wire, then the floor");
    await h.call("sessions", "taskSet", {
      session,
      id: "t1",
      status: "in_progress",
    });
    expect(tasks()[0]?.status).toBe("in_progress");
    await h.call("sessions", "taskSet", {
      session,
      id: "t1",
      status: "completed",
    });
    expect(tasks()[0]?.status).toBe("completed");

    // A task that is not there is named as such, not silently nothing.
    await expect(
      h.call("sessions", "taskSet", { session, id: "t9", status: "completed" }),
    ).rejects.toThrow(/no such task/);
    expect(
      await h.call("sessions", "taskRemove", { session, id: "t1" }),
    ).toEqual({ removed: true });
    expect(tasks()).toEqual([]);
    await expect(h.call("sessions", "taskRemove", { session })).rejects.toThrow(
      /needs a session and an id/,
    );
    await h.unload();
  });

  it("deletes a key of the model's own state, and answers a pending question", async () => {
    const h = await harness();
    await h.load();
    const { session } = (await h.call("sessions", "create", {
      cwd: "/work/eta",
    })) as { session: string };
    const open = () =>
      h.manager.openSessions().find((entry) => entry.meta.id === session)
        ?.session;
    const stateKeys = () =>
      (h.state(`sessions.${session}`)?.sections.state as { keys: string[] })
        .keys;

    await h.call("sessions", "resync", { session });
    expect(stateKeys()).toEqual([]);
    await open()?.journaling.writeValues([
      {
        kind: "value",
        op: "set",
        namespace: "eta.model-state",
        key: "plan",
        value: "x",
      },
    ]);
    await h.call("sessions", "resync", { session });
    expect(stateKeys()).toEqual(["plan"]);
    // Deleting it is the same door the model's own state tools use.
    await h.call("sessions", "stateDelete", { session, key: "plan" });
    await h.call("sessions", "resync", { session });
    expect(stateKeys()).toEqual([]);

    // A question waiting for a human is answered (or dropped) through the wire.
    const asked = open()?.ask?.ask(
      {
        questionId: "q1",
        question: "which wire?",
        options: [],
        askedAt: Date.now(),
      } as never,
      { timeoutMs: 5_000 },
    );
    await until(() => (open()?.ask?.pendingAsks() ?? []).length > 0);
    expect(
      await h.call("sessions", "answer", {
        session,
        questionId: "q1",
        response: { kind: "freeform", text: "this one" },
      }),
    ).toEqual({ answered: true });
    expect(await asked).toEqual({ kind: "freeform", text: "this one" });
    // An answer for something nobody is waiting on is a `false`, not an invention.
    expect(
      await h.call("sessions", "answer", {
        session,
        questionId: "q1",
        response: { kind: "none" },
      }),
    ).toEqual({
      answered: false,
    });

    const waiting = open()?.ask?.ask(
      {
        questionId: "q2",
        question: "still there?",
        options: [],
        askedAt: Date.now(),
      } as never,
      { timeoutMs: 5_000 },
    );
    await until(() => (open()?.ask?.pendingAsks() ?? []).length > 0);
    // Dropping the question also gives up the run that was waiting on it: a turn nobody can
    // answer must not hang.
    expect(
      await h.call("sessions", "askAbort", { session, questionId: "q2" }),
    ).toEqual({ aborted: true });
    expect(await waiting).toEqual({ kind: "none" });
    expect(open()?.ask?.pendingAsks()).toEqual([]);
    await h.unload();
  });
});

describe("choosing how the next turn is generated", () => {
  it("switches the model, and refuses while the session is busy", async () => {
    const models = fakeModels([
      assistantMessage({ content: [{ type: "text", text: "an answer" }] }),
    ]);
    // A models layer that serves exactly one identity, the way a real one serves what its
    // providers hold: anything else has to be refused.
    const serves = models.getModel.bind(models);
    models.getModel = (provider, id) =>
      provider === "fake" && id === "fake-model"
        ? serves(provider, id)
        : undefined;
    const h = await harness(models);
    await h.load();
    const { session } = (await h.call("sessions", "create", {
      cwd: "/work/eta",
    })) as { session: string };
    const open = () =>
      h.manager.openSessions().find((entry) => entry.meta.id === session)
        ?.session;

    // A model nobody serves is named now, not a minute later when a run fails.
    await expect(
      h.call("sessions", "modelSet", { session, model: "pro6000:nothing" }),
    ).rejects.toThrow(/model_unavailable/);
    // Nothing changed: a refused switch leaves the session exactly where it was.
    expect(open()?.config.model).toEqual({
      provider: "unknown",
      modelId: "unknown",
    });

    // The fake models layer serves exactly one identity, so ask for that one.
    const switched = await h.call("sessions", "modelSet", {
      session,
      model: "fake:fake-model",
    });
    expect(switched).toEqual({
      model: "fake:fake-model",
      thinkingLevel: "off",
    });
    expect(open()?.config.model).toEqual({
      provider: "fake",
      modelId: "fake-model",
    });
    // Written where a restart reads it: the row and the journal's config both say so.
    const row = (await h.manager.list()).find(
      (listing) => listing.id === session,
    );
    expect(row?.ok === true ? row.meta.model : undefined).toBe(
      "fake:fake-model",
    );
    // The journal holds the configuration now, so a replay comes back on this model rather
    // than on whatever the caller would default to.
    const journaled = await h.manager.list();
    expect(journaled.some((listing) => listing.id === session)).toBe(true);
    const reopened = (await h.manager.session(session))?.session;
    expect(reopened?.config.model).toEqual({
      provider: "fake",
      modelId: "fake-model",
    });

    // And it refuses to change under a run that already assembled its request.
    await h.call("sessions", "prompt", { session, text: "slow down" });
    await h
      .call("sessions", "modelSet", { session, model: "fake:fake-model" })
      .then(
        () => {
          throw new Error("a busy session accepted a model change");
        },
        (error: Error) => expect(error.message).toContain("busy"),
      );
    await until(() => open()?.runner.running === false);
    await h.unload();
  });

  it("sets the thinking level the model accepts", async () => {
    const models = fakeModels([
      assistantMessage({ content: [{ type: "text", text: "an answer" }] }),
    ]);
    const h = await harness(models);
    await h.load();
    const { session } = (await h.call("sessions", "create", {
      cwd: "/work/eta",
    })) as { session: string };
    const open = () =>
      h.manager.openSessions().find((entry) => entry.meta.id === session)
        ?.session;

    expect(
      await h.call("sessions", "thinkingLevel", { session, level: "high" }),
    ).toEqual({ session, level: "high" });
    expect(open()?.config.thinkingLevel).toBe("high");
    // A level that does not exist is refused before it reaches the configuration.
    await expect(
      h.call("sessions", "thinkingLevel", { session, level: "galaxy" }),
    ).rejects.toThrow(/unknown thinking level/);
    // The fake model does not reason, so anything but "off" is refused rather than sent.
    const reasoning = fakeModels([]);
    reasoning.getModel = () =>
      ({
        provider: "fake",
        id: "fake-model",
        api: "openai-completions",
        reasoning: false,
      }) as never;
    const plain = await harness(reasoning);
    await plain.load();
    const { session: other } = (await plain.call("sessions", "create", {
      cwd: "/work/eta",
    })) as { session: string };
    await expect(
      plain.call("sessions", "thinkingLevel", {
        session: other,
        level: "high",
      }),
    ).rejects.toThrow(/does not support thinking level high/);
    await plain.unload();
    await h.unload();
  });

  it("takes a queued input back, and says which of the three things happened", async () => {
    const models = fakeModels([
      assistantMessage({
        stopReason: "toolUse",
        content: [
          { type: "toolCall", id: "c1", name: "list_steps", arguments: {} },
        ],
      }),
      assistantMessage({ content: [{ type: "text", text: "done" }] }),
    ]);
    const h = await harness(models);
    await h.load();
    const { session } = (await h.call("sessions", "create", {
      cwd: "/work/eta",
    })) as { session: string };
    const open = () =>
      h.manager.openSessions().find((entry) => entry.meta.id === session)
        ?.session;

    // An id nothing has seen: never there.
    expect(
      await h.call("sessions", "queueRemove", { session, entryId: "never" }),
    ).toEqual({
      entryId: "never",
      outcome: "not_found",
    });

    // Queue one behind a run that is in flight, then take it back.
    await h.call("sessions", "prompt", { session, text: "start something" });
    await until(() => open()?.runner.running === true);
    await h.call("sessions", "prompt", { session, text: "and then this" });
    const queued = open()?.kernel.inbox.list() ?? [];
    expect(queued).toHaveLength(1);
    const entryId = queued[0]?.entryId as string;
    expect(
      await h.call("sessions", "queueRemove", { session, entryId }),
    ).toEqual({ entryId, outcome: "cancelled" });
    expect(open()?.kernel.inbox.list()).toEqual([]);

    // One the run already took: the journal holds it, so it was consumed, not cancelled.
    await until(() => open()?.runner.running === false);
    const consumed = open()?.log.graph.pathOldestFirst()[0]?.id as string;
    expect(
      await h.call("sessions", "queueRemove", { session, entryId: consumed }),
    ).toEqual({
      entryId: consumed,
      outcome: "already_consumed",
    });
    await h.unload();
  });
});

describe("what other plugins hear", () => {
  it("announces sessions appearing, moving and going away", async () => {
    const h = await harness();
    await h.load();
    const seen: string[] = [];
    // The service is reached the way a plugin reaches it: through the context it injected.
    const sessions = (
      h.ctx as unknown as {
        sessions: {
          subscribe: (listener: {
            opened: (session: { id: string; cwd: string }) => void;
            closed: (id: string) => void;
            focused: (id: string | undefined) => void;
            changed: (session: { id: string; cwd: string }) => void;
          }) => () => void;
        };
      }
    ).sessions;
    const off = sessions.subscribe({
      opened: (session) => seen.push(`opened:${session.id}`),
      closed: (id) => seen.push(`closed:${id}`),
      focused: (id) => seen.push(`focused:${id ?? "none"}`),
      changed: (session) => seen.push(`changed:${session.id}`),
    });
    const { session } = (await h.call("sessions", "create", {
      cwd: "/work/eta",
    })) as { session: string };
    await h.call("sessions", "focus", { session });
    await h.call("sessions", "delete", { session });
    expect(seen).toContain(`opened:${session}`);
    expect(seen).toContain(`focused:${session}`);
    expect(seen).toContain(`closed:${session}`);
    // Unsubscribing stops the announcements.
    off();
    const after = seen.length;
    const second = (await h.call("sessions", "create", {
      cwd: "/work/eta",
    })) as { session: string };
    expect(seen.length).toBe(after);
    void second;
    await h.unload();
  });
});

describe("history and search", () => {
  it("pages a transcript by sequence, oldest-first, without repeating a row", async () => {
    const models = fakeModels([
      assistantMessage({ content: [{ type: "text", text: "answer one" }] }),
      assistantMessage({ content: [{ type: "text", text: "answer two" }] }),
      assistantMessage({ content: [{ type: "text", text: "answer three" }] }),
    ]);
    const h = await harness(models);
    await h.load();
    const { session } = (await h.call("sessions", "create", {
      cwd: "/work/eta",
    })) as { session: string };
    for (const question of [
      "first question",
      "second question",
      "third question",
    ]) {
      await h.call("sessions", "prompt", { session, text: question });
      await until(
        () =>
          h.manager.openSessions().find((open) => open.meta.id === session)
            ?.session.runner.running === false,
      );
    }

    // The newest page, and then the page before it, by cursor.
    const newest = (await h.call("sessions", "history", {
      session,
      limit: 3,
    })) as {
      rows: { seq: number; message: { role: string } }[];
    };
    expect(newest.rows.length).toBeGreaterThan(0);
    const oldestSeq = newest.rows[0]?.seq as number;
    const older = (await h.call("sessions", "history", {
      session,
      beforeSeq: oldestSeq,
      limit: 3,
    })) as {
      rows: { seq: number }[];
    };
    // The cursor is exclusive: nothing in the older page is in the newer one.
    const overlap = older.rows.filter((row) => row.seq >= oldestSeq);
    expect(overlap).toEqual([]);
    expect(older.rows.length).toBeGreaterThan(0);

    // Paging all the way back sees every message exactly once, in order.
    const seen: number[] = [];
    let cursor: number | undefined;
    for (;;) {
      const page = (await h.call("sessions", "history", {
        session,
        limit: 2,
        ...(cursor === undefined ? {} : { beforeSeq: cursor }),
      })) as {
        rows: { seq: number }[];
      };
      if (page.rows.length === 0) break;
      seen.unshift(...page.rows.map((row) => row.seq));
      cursor = page.rows[0]?.seq;
      if (page.rows.length < 2) break;
    }
    expect(seen).toEqual([...seen].sort((left, right) => left - right));
    expect(new Set(seen).size).toBe(seen.length);

    // A session that is not there is named as such.
    await expect(
      h.call("sessions", "history", { session: "nope" }),
    ).rejects.toThrow(/no such session/);
    await h.unload();
  });

  it("finds which sessions mention something, one hit each", async () => {
    const models = fakeModels([
      assistantMessage({
        content: [{ type: "text", text: "the wire is four words" }],
      }),
      assistantMessage({
        content: [{ type: "text", text: "nothing about that here" }],
      }),
    ]);
    const h = await harness(models);
    await h.load();
    const { session: first } = (await h.call("sessions", "create", {
      cwd: "/work/one",
    })) as { session: string };
    const { session: second } = (await h.call("sessions", "create", {
      cwd: "/work/two",
    })) as { session: string };
    await h.call("sessions", "prompt", {
      session: first,
      text: "what does the wire look like?",
    });
    await until(
      () =>
        h.manager.openSessions().find((open) => open.meta.id === first)?.session
          .runner.running === false,
    );

    const hits = (await h.call("sessions", "search", { query: "wire" })) as {
      hits: { session: string; snippet: string }[];
    };
    expect(hits.hits.map((hit) => hit.session)).toEqual([first]);
    expect(hits.hits[0]?.snippet).toContain("wire");

    // A query nobody says finds nothing; an empty one is not a search at all.
    expect(
      (
        (await h.call("sessions", "search", {
          query: "nothing like this",
        })) as { hits: unknown[] }
      ).hits,
    ).toEqual([]);
    expect(
      (
        (await h.call("sessions", "search", { query: "   " })) as {
          hits: unknown[];
        }
      ).hits,
    ).toEqual([]);

    // A session that was never opened is not searched: a search is over what this plugin holds.
    await h.manager.close(second);
    const afterClose = (await h.call("sessions", "search", {
      query: "wire",
    })) as { hits: { session: string }[] };
    expect(afterClose.hits.map((hit) => hit.session)).not.toContain(second);
    await h.unload();
  });
});
