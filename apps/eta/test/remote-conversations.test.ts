import type {
  AttachmentView,
  InboxResponse,
  InteractionView,
  SidebarSession,
  ViewMessageRow,
} from "@eta/client-contracts";
/**
 * A conversation in a project on another machine.
 *
 * Every test runs a real daemon against a real host. The reply's session lives on the daemon (its
 * kernel, its journal and its tools are there), the models are the primary's (scripted here, and
 * the daemon has none), and the browser is a wire client of the primary that watches the session
 * as it would a local one.
 */
import type { KernelModels } from "@eta/core";
import { Buffer } from "node:buffer";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { LINK_LIMITS } from "@eta/client-contracts";
import { DaemonLink, DaemonNode } from "@eta/daemon";
import { afterEach, describe, expect, it } from "vitest";
import { connect, until } from "./support/client";
import { dropLink, machineView } from "./support/daemon";
import { tempDir, testHost } from "./support/host";
import { call, gate, HANG, say, scriptedModels } from "./support/models";
import { remoteWorld, sessionOf } from "./support/remote";

const SECRET = "sk-only-the-primary-may-know-this";

/** A model layer whose model carries a credential, as a real provider's would. */
function withCredential(
  models: KernelModels,
  options: unknown[],
): KernelModels {
  return {
    ...models,
    getModel: (provider, id) => {
      const model = models.getModel(provider, id);
      return model === undefined
        ? undefined
        : ({
            ...model,
            baseUrl: `https://${SECRET}.example/v1`,
            headers: { authorization: `Bearer ${SECRET}` },
          } as never);
    },
    streamSimple: (model, context, streamOptions) => {
      options.push(streamOptions);
      return models.streamSimple(model, context, streamOptions);
    },
  };
}

describe("a reply on a remote machine", () => {
  it("names where its run starts in the daemon's journal, which the view's rows are numbered by", async () => {
    const opened = gate();
    const { models } = scriptedModels(async (request) => {
      if (request.index === 1) await opened.opened;
      return say(`answer ${request.index + 1}`);
    });
    const r = await remoteWorld({ models });
    const { group } = await r.agents("Ada");

    const one = await r.send(group.id, "first");
    await r.settled(group.id, one.replies[0]!.id);
    const session = sessionOf(r, group.id)!;
    r.client.subscribe(`sessions.${session}`);
    const rows = () =>
      r.client.section<{ messages: ViewMessageRow[] }>(
        `sessions.${session}`,
        "transcript",
      )?.messages ?? [];
    await until(() => rows().length === 2);
    const last = rows().at(-1)!.seq;

    const two = await r.send(group.id, "second");
    const working = await r.settled(group.id, two.replies[0]!.id, ["working"]);
    expect(working.data.runFrom).toBe(last);

    await until(() => rows().length === 3);
    expect(rows().at(-1)!.seq).toBeGreaterThan(last);
    opened.open();
    await r.settled(group.id, two.replies[0]!.id);
  });

  it("still runs when the daemon cannot say where the session stands", async () => {
    const { models } = scriptedModels(() => say("hello"));
    const r = await remoteWorld({ models });
    const { group } = await r.agents("Ada");
    // A daemon of an older build has no such action.
    const link = r.host.product.hub.link(r.daemon.machineId)!;
    const asked = link.machine.bind(link);
    link.machine = ((action: "info", args: Record<string, never>) =>
      (action as string) === "lastSeq"
        ? Promise.reject(new Error("unknown action"))
        : asked(action, args)) as typeof link.machine;

    const sent = await r.send(group.id, "hi");
    const done = await r.settled(group.id, sent.replies[0]!.id);
    expect(done).toMatchObject({ status: "done", text: "hello" });
    expect(done.data).not.toHaveProperty("runFrom");
  });

  it("runs on the daemon, generates through the primary and streams to a browser watching the session", async () => {
    const opened = gate();
    const { models, requests } = scriptedModels(async (request) => {
      if (request.index === 0) await opened.opened;
      return say("hello from over there", "a thought");
    });
    const seen: unknown[] = [];
    const r = await remoteWorld({ models: withCredential(models, seen) });
    const { group } = await r.agents("Ada");

    const sent = await r.send(group.id, "hi");
    const reply = sent.replies[0]!;
    await r.settled(group.id, reply.id, ["working"]);
    await until(() => sessionOf(r, group.id) !== undefined);
    const session = sessionOf(r, group.id)!;

    // The browser watches the session on the primary's own wire.
    r.client.subscribe(`sessions.${session}`);
    await until(() =>
      r.client.frames.some(
        (frame) =>
          frame.type === "state" && frame.target === `sessions.${session}`,
      ),
    );
    opened.open();

    const done = await r.settled(group.id, reply.id);
    expect(done).toMatchObject({
      status: "done",
      text: "hello from over there",
      thinking: "a thought",
    });
    // What the browser saw of the session came from the daemon's kernel: its events, and its
    // state with the words in it.
    await until(() =>
      JSON.stringify(
        r.client.frames.filter(
          (frame) =>
            frame.type === "state" && frame.target === `sessions.${session}`,
        ),
      ).includes("hello from over there"),
    );
    expect(
      r.client.frames.some(
        (frame) =>
          frame.type === "event" &&
          frame.target === `sessions.${session}` &&
          frame.name === "message:end",
      ),
    ).toBe(true);

    // The session lives on the daemon: its journal is in the daemon's directory, and the
    // primary's session host has none of it.
    expect(r.host.server.sessions.openSessions()).toEqual([]);
    expect(existsSync(join(r.daemon.dataDir, "sessions", session))).toBe(true);
    expect(existsSync(join(r.host.dataDir, "sessions", session))).toBe(false);

    // The request the primary's model got is the agent's: its words came over the link.
    expect(requests[0]!.agent).toBe("Ada");
    expect(requests[0]!.tools).toEqual(
      expect.arrayContaining(["mention", "conversation_info"]),
    );

    // The credential is the primary's: nothing the daemon was sent, or sent, has it, and the
    // request the provider layer got carried none of the daemon's choosing.
    expect(r.traffic.in.join("")).not.toContain(SECRET);
    expect(r.traffic.out.join("")).not.toContain(SECRET);
    for (const options of seen as Record<string, unknown>[]) {
      expect(options?.apiKey).toBeUndefined();
      expect(options?.headers).toBeUndefined();
    }

    // Usage is counted on the primary, for the agent and the conversation.
    const usage = r.host.db
      .query<
        { agent_id: string; conversation_id: string; session_id: string },
        []
      >("SELECT agent_id, conversation_id, session_id FROM usage")
      .all();
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({
      conversation_id: group.id,
      session_id: session,
    });
  });

  // TOBEREFR: see packages/TOBEREFR/TODO.md
  it.skip("its file and shell tools work on the daemon's machine", async () => {
    const { models } = scriptedModels((request) => {
      if (request.lastRole === "toolResult") return say(`saw: ${request.last}`);
      return call("bash", {
        command: "echo from-the-daemon > proof.txt && pwd",
      });
    });
    const r = await remoteWorld({ models });
    const { group } = await r.agents("Ada");
    const sent = await r.send(group.id, "write a file");
    const done = await r.settled(group.id, sent.replies[0]!.id);
    expect(done.status).toBe("done");
    expect(await readFile(join(r.dir, "proof.txt"), "utf8")).toBe(
      "from-the-daemon\n",
    );
    expect(done.text).toContain(r.dir);
  });

  it("its tool calls come back on the reply's row", async () => {
    const { models } = scriptedModels((request) =>
      request.lastRole === "toolResult"
        ? say("ok")
        : call("create_step", { content: "over-there" }, "call-remote"),
    );
    const r = await remoteWorld({ models });
    const { group } = await r.agents("Ada");
    const sent = await r.send(group.id, "do it");
    const done = await r.settled(group.id, sent.replies[0]!.id);
    expect(done.data.activity).toMatchObject([
      { id: "call-remote", name: "create_step", status: "completed" },
    ]);
    expect(JSON.stringify(done.data.activity)).toContain("over-there");
  });

  it("the second wake finds the same session, still the daemon's", async () => {
    const { models, requests } = scriptedModels(() => say("again"));
    const r = await remoteWorld({ models });
    const { group } = await r.agents("Ada");
    const first = await r.send(group.id, "one");
    await r.settled(group.id, first.replies[0]!.id);
    const session = sessionOf(r, group.id)!;
    const second = await r.send(group.id, "two");
    await r.settled(group.id, second.replies[0]!.id);
    expect(sessionOf(r, group.id)).toBe(session);
    expect(await readdir(join(r.daemon.dataDir, "sessions"))).toEqual([
      session,
    ]);
    // The second request carried the first exchange: one session, one history.
    expect(requests[1]!.transcript.join("\n")).toContain("one");
  });

  it("a project on a machine that is offline fails the reply, and says why", async () => {
    const { models, requests } = scriptedModels(() => say("never"));
    const r = await remoteWorld({ models });
    const { group } = await r.agents("Ada");
    await r.daemon.link.stop();
    await until(
      () => machineView(r.client, r.daemon.machineId)?.status === "offline",
    );
    const sent = await r.send(group.id, "anyone?");
    const failed = await r.settled(group.id, sent.replies[0]!.id);
    expect(failed.status).toBe("failed");
    expect(failed.text).toMatch(/offline/);
    expect(requests).toHaveLength(0);
  });
});

describe("the primary's tools on a remote session", () => {
  it("mention wakes another member, whose reply runs on the daemon too", async () => {
    const { models } = scriptedModels((request) => {
      if (request.agent === "Bob") return say("Reviewed, it is fine.");
      return request.lastRole === "toolResult"
        ? say("I asked Bob.")
        : call("mention", {
            agents: ["bob"],
            message: "please review the plan",
          });
    });
    const r = await remoteWorld({ models });
    const { agents, group } = await r.agents("Ada", "Bob");
    const sent = await r.send(group.id, "plan the release");
    const adas = await r.settled(group.id, sent.replies[0]!.id);
    expect(adas.text).toBe("I asked Bob.");
    await until(
      () =>
        r
          .rows(group.id)
          .filter((row) => row.kind === "message" && row.author === "agent")
          .length === 2,
    );
    const rows = r.rows(group.id);
    expect(rows.find((row) => row.kind === "mention")).toMatchObject({
      agentId: agents[0]!.id,
      mentions: [agents[1]!.id],
      text: "please review the plan",
    });
    const bobs = rows.find(
      (row) => row.agentId === agents[1]!.id && row.kind === "message",
    )!;
    await r.settled(group.id, bobs.id);
    expect(r.row(group.id, bobs.id)?.text).toBe("Reviewed, it is fine.");
    // Two sessions, both on the daemon.
    expect(await readdir(join(r.daemon.dataDir, "sessions"))).toHaveLength(2);
    expect(existsSync(join(r.host.dataDir, "sessions"))).toBe(false);
  });

  it("a task tool acts as the agent, in its conversation", async () => {
    const { models } = scriptedModels((request) =>
      request.lastRole === "toolResult"
        ? say(`result: ${request.last}`)
        : call("create_task", {
            title: "Write the docs",
            description: "The README",
            workspace: "local",
          }),
    );
    const r = await remoteWorld({ models, tasks: { runs: false } });
    const { agents, group } = await r.agents("Ada");
    r.client.subscribe("tasks");
    const sent = await r.send(group.id, "track the docs");
    const done = await r.settled(group.id, sent.replies[0]!.id);
    expect(done.text).toContain("Write the docs");
    await until(
      () => (r.client.section<unknown[]>("tasks", "list") ?? []).length === 1,
    );
    const rows = r.host.db
      .query<{ title: string; created_by_agent: string | null }, []>(
        "SELECT title, created_by_agent FROM task",
      )
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.title).toBe("Write the docs");
    expect(rows[0]!.created_by_agent).toBe(agents[0]!.id);
  });

  // TOBEREFR: see packages/TOBEREFR/TODO.md
  it.skip("publish_artifact reads the files on the daemon's machine, through the link", async () => {
    await Promise.resolve();
    const { models } = scriptedModels((request) =>
      request.lastRole === "toolResult"
        ? say(`published: ${request.last}`)
        : call("publish_artifact", { path: "site", title: "Remote site" }),
    );
    const r = await remoteWorld({ models });
    await mkdir(join(r.dir, "site"));
    await writeFile(
      join(r.dir, "site", "index.html"),
      "<h1>from the daemon</h1>",
    );
    const { group } = await r.agents("Ada");
    r.client.subscribe("artifacts");
    const sent = await r.send(group.id, "publish it");
    const done = await r.settled(group.id, sent.replies[0]!.id);
    expect(done.text).toContain("Published");
    await until(
      () =>
        (r.client.section<unknown[]>("artifacts", "list") ?? []).length === 1,
    );
    // The files were read by the daemon's shell: scripts went over the link.
    expect(
      r.traffic.in.filter((text) => text.includes('"method":"exec"')).length,
    ).toBeGreaterThan(0);
    const stored = r.host.db
      .query<{ title: string }, []>("SELECT title FROM artifact")
      .all();
    expect(stored.map((row) => row.title)).toEqual(["Remote site"]);
  });
});

describe("watching and driving a remote session from the browser", () => {
  const stateFrames = (r: { traffic: { out: string[] } }, session: string) =>
    r.traffic.out.filter(
      (text) =>
        text.includes('"type":"state"') &&
        text.includes(`"target":"sessions.${session}"`),
    ).length;

  it("the primary listens to the daemon only while somebody here is watching", async () => {
    const { models } = scriptedModels(() => say("noted"));
    const r = await remoteWorld({ models });
    const { group } = await r.agents("Ada");
    const first = await r.send(group.id, "one");
    await r.settled(group.id, first.replies[0]!.id);
    const session = sessionOf(r, group.id)!;

    // Nobody is watching: the run above cost the link no state frames for the session.
    expect(stateFrames(r, session)).toBe(0);

    r.client.subscribe(`sessions.${session}`);
    await until(() => stateFrames(r, session) > 0);
    const watched = stateFrames(r, session);

    // Nobody is watching again: the next frame from the daemon finds nobody and unsubscribes.
    r.client.unsubscribe(`sessions.${session}`);
    await until(
      () =>
        r.host.server.wire.state.watchersOf(`sessions.${session}`).length === 0,
    );
    const second = await r.send(group.id, "two");
    await r.settled(group.id, second.replies[0]!.id);
    // The daemon's state reaches the primary on a paced push, so how soon the mirror finds nobody
    // looking is not a number of milliseconds: wait for it to have let go.
    await until(
      () =>
        r.host.product.hub
          .link(r.daemon.machineId)
          ?.pipe.subscribed(`sessions.${session}`) === false,
    );
    const afterwards = stateFrames(r, session);
    expect(afterwards - watched).toBeLessThanOrEqual(1);
    const idle = afterwards;
    const third = await r.send(group.id, "three");
    await r.settled(group.id, third.replies[0]!.id);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(stateFrames(r, session)).toBe(idle);
  });

  it("sessions.* actions for a remote session go to its daemon", async () => {
    const { models, requests } = scriptedModels((request) =>
      say(`heard: ${request.last}`),
    );
    const r = await remoteWorld({ models });
    const { group } = await r.agents("Ada");
    const first = await r.send(group.id, "one");
    await r.settled(group.id, first.replies[0]!.id);
    const session = sessionOf(r, group.id)!;
    r.client.subscribe(`sessions.${session}`);

    // The browser prompts the session directly, as it would a local one.
    await r.client.call("sessions", "prompt", { session, text: "direct word" });
    await until(() => requests.length === 2);
    expect(requests[1]!.last).toContain("direct word");
    await until(() =>
      JSON.stringify(
        r.client.frames.filter(
          (frame) =>
            frame.type === "state" && frame.target === `sessions.${session}`,
        ),
      ).includes("heard: direct word"),
    );

    // A resync is the daemon's own state of the session.
    const resynced = (await r.client.call("sessions", "resync", {
      session,
    })) as { state: { sections: Record<string, unknown> } };
    expect(JSON.stringify(resynced.state.sections)).toContain("direct word");

    // A session that is not anyone's is still "no such session", not a routing error.
    await expect(
      r.client.call("sessions", "abort", { session: "nobody" }),
    ).rejects.toThrow(/no such session/);
  });

  it("a session on a machine that is offline says so instead of hanging", async () => {
    const { models } = scriptedModels(() => say("ok"));
    const r = await remoteWorld({ models });
    const { group } = await r.agents("Ada");
    const first = await r.send(group.id, "one");
    await r.settled(group.id, first.replies[0]!.id);
    const session = sessionOf(r, group.id)!;
    await r.daemon.link.stop();
    await until(
      () => machineView(r.client, r.daemon.machineId)?.status === "offline",
    );
    await expect(
      r.client.call("sessions", "abort", { session }),
    ).rejects.toThrow(/offline/);
  });

  it("a watched session is warmed again when the link comes back", async () => {
    const { models } = scriptedModels((request) =>
      say(`answer to ${request.last}`),
    );
    const r = await remoteWorld({ models });
    const { group } = await r.agents("Ada");
    const first = await r.send(group.id, "one");
    await r.settled(group.id, first.replies[0]!.id);
    const session = sessionOf(r, group.id)!;
    r.client.subscribe(`sessions.${session}`);
    const shown = (): string =>
      JSON.stringify(
        r.client.frames.filter(
          (frame) =>
            frame.type === "state" && frame.target === `sessions.${session}`,
        ),
      );
    // Warm, and what the daemon sent is already on the browser: nothing is still owed to it.
    await until(() => shown().includes("answer to"));

    await dropLink(r.host, r.client, r.daemon);
    // Nothing but the link coming back asks for it: the browser subscribed once, before the drop.
    await until(
      () =>
        r.host.product.hub
          .link(r.daemon.machineId)
          ?.pipe.subscribed(`sessions.${session}`) === true,
    );
    const second = await r.send(group.id, "after the drop");
    await r.settled(group.id, second.replies[0]!.id);
    // The reply that ran after the reconnect is in what the browser was shown.
    await until(() => shown().includes("after the drop"));
  });
});

describe("restarts", () => {
  it("a daemon that restarts finds its sessions and applies an agent edit made while it was offline", async () => {
    const { models, requests } = scriptedModels((request) =>
      say(`answer ${request.index}`),
    );
    const r = await remoteWorld({ models });
    const { agents, group } = await r.agents("Ada");
    const first = await r.send(group.id, "remember the number 7");
    await r.settled(group.id, first.replies[0]!.id);
    const session = sessionOf(r, group.id)!;

    // The daemon process goes away entirely, and a new one starts on the same directory.
    await r.daemon.stop();
    await until(
      () => machineView(r.client, r.daemon.machineId)?.status === "offline",
    );
    await r.client.call("agents", "update", {
      agentId: agents[0]!.id,
      model: "fake:after-restart",
    });
    const node = new DaemonNode({
      dataDir: r.daemon.dataDir,
      version: "test",
      warn: () => undefined,
    });
    await node.start();
    const link = new DaemonLink({
      identity: r.daemon.identity,
      server: node,
      backoff: { minMs: 20, maxMs: 100 },
    });
    link.start();
    try {
      await until(
        () => machineView(r.client, r.daemon.machineId)?.status === "online",
      );
      const second = await r.send(group.id, "what number?");
      expect((await r.settled(group.id, second.replies[0]!.id)).status).toBe(
        "done",
      );
      // The same session, with its history: it was read back from the daemon's own journal.
      expect(sessionOf(r, group.id)).toBe(session);
      expect(requests[1]!.transcript.join("\n")).toContain(
        "remember the number 7",
      );
      const config = await r.host.product.hub
        .link(r.daemon.machineId)!
        .machine("config", { session });
      expect(config.model).toBe("fake:after-restart");
    } finally {
      await link.stop();
      await node.close();
    }
  });

  it("a restarted host still knows which sessions are on which machine", async () => {
    const { models } = scriptedModels(() => say("ok"));
    const r = await remoteWorld({ models });
    const { group } = await r.agents("Ada");
    const first = await r.send(group.id, "hi");
    await r.settled(group.id, first.replies[0]!.id);
    const session = sessionOf(r, group.id)!;
    await r.daemon.link.stop();
    await r.host.close();

    // A new host on the same data directory: nothing is kept in memory between the two.
    const host = await testHost({ dataDir: r.host.dataDir, models });
    const client = await connect(`ws://127.0.0.1:${host.port}/ws`);
    await client.hello();
    // The session is the machine's, so the answer is about the machine, not "no such session".
    await expect(client.call("sessions", "abort", { session })).rejects.toThrow(
      /offline/,
    );
    // And the browser can already watch it: the target is on the wire.
    client.subscribe(`sessions.${session}`);
    await until(() =>
      client.frames.some(
        (frame) =>
          frame.type === "state" && frame.target === `sessions.${session}`,
      ),
    );
    client.close();
  });
});

describe("what the primary sends with a session", () => {
  it("the agent's persona card, kept on the primary, reaches the session", async () => {
    const { models, requests } = scriptedModels(() => say("ok"));
    const r = await remoteWorld({ models });
    // The user's own card lives in the primary's home (the test host's home is its data dir).
    await mkdir(join(r.host.dataDir, ".eta", "persona"), { recursive: true });
    await writeFile(
      join(r.host.dataDir, ".eta", "persona", "Zed.persona.md"),
      "You are Zed, who answers only in haiku about the sea.",
    );
    const zed = await r.agent("Zed", { persona: "Zed" });
    const group = await r.group(r.remoteProject.id, [zed.id]);
    await r.watch(group.id);
    const sent = await r.send(group.id, "hello");
    await r.settled(group.id, sent.replies[0]!.id);
    expect(requests[0]!.system).toContain("haiku about the sea");
  });

  it("a model picked in the session's own controls is made known to the daemon first", async () => {
    const { models } = scriptedModels(() => say("ok"));
    const r = await remoteWorld({ models });
    const { group } = await r.agents("Ada");
    const sent = await r.send(group.id, "hello");
    await r.settled(group.id, sent.replies[0]!.id);
    const session = sessionOf(r, group.id)!;
    const result = (await r.client.call("sessions", "modelSet", {
      session,
      model: "fake:another-model",
    })) as { model: string };
    expect(result.model).toBe("fake:another-model");
    // The daemon's session is now on it.
    const config = await r.host.product.hub
      .link(r.daemon.machineId)!
      .machine("config", { session });
    expect(config.model).toBe("fake:another-model");
  });
});

describe("an agent's model and thinking level on a remote session", () => {
  const configOf = (
    r: Awaited<ReturnType<typeof remoteWorld>>,
    session: string,
  ) =>
    r.host.product.hub.link(r.daemon.machineId)!.machine("config", { session });

  it("a chip choice survives the next wake, and an edit of the agent overrides it", async () => {
    const { models } = scriptedModels(() => say("ok"));
    const r = await remoteWorld({ models });
    const { agents, group } = await r.agents("Ada");
    await r.client.call("agents", "update", {
      agentId: agents[0]!.id,
      model: "fake:first",
      thinkingLevel: "low",
    });
    const first = await r.send(group.id, "one");
    await r.settled(group.id, first.replies[0]!.id);
    const session = sessionOf(r, group.id)!;
    expect(await configOf(r, session)).toEqual({
      model: "fake:first",
      thinkingLevel: "low",
    });

    await r.client.call("sessions", "modelSet", {
      session,
      model: "fake:chosen",
    });
    await r.client.call("sessions", "thinkingLevel", {
      session,
      level: "high",
    });
    const second = await r.send(group.id, "two");
    await r.settled(group.id, second.replies[0]!.id);
    expect(await configOf(r, session)).toEqual({
      model: "fake:chosen",
      thinkingLevel: "high",
    });

    await r.client.call("agents", "update", {
      agentId: agents[0]!.id,
      model: "fake:second",
      thinkingLevel: "medium",
    });
    expect(await configOf(r, session)).toEqual({
      model: "fake:second",
      thinkingLevel: "medium",
    });

    // Back to the model's default is an edit too: the session drops the level it had.
    await r.client.call("agents", "update", {
      agentId: agents[0]!.id,
      thinkingLevel: null,
    });
    expect(await configOf(r, session)).toEqual({
      model: "fake:second",
      thinkingLevel: "off",
    });
  });

  it("an edit while the machine is offline is a warning, not an error", async () => {
    const warnings: string[] = [];
    const { models } = scriptedModels(() => say("ok"));
    const r = await remoteWorld({ models, warn: (m) => warnings.push(m) });
    const { agents, group } = await r.agents("Ada");
    const first = await r.send(group.id, "one");
    await r.settled(group.id, first.replies[0]!.id);
    await r.daemon.link.stop();
    await until(
      () => machineView(r.client, r.daemon.machineId)?.status === "offline",
    );
    await r.client.call("agents", "update", {
      agentId: agents[0]!.id,
      model: "fake:second",
    });
    expect(warnings.join("\n")).toMatch(/could not update session/);
  });
});

describe("questions from a remote session", () => {
  const list = (r: {
    client: { section: <T>(t: string, n: string) => T | undefined };
  }) => r.client.section<InteractionView[]>("inbox", "list") ?? [];

  it("the model's own question round-trips through the inbox and resumes the run", async () => {
    const { models } = scriptedModels((request) =>
      request.lastRole === "toolResult"
        ? say(`Chose: ${request.last}`)
        : call(
            "ask_user",
            {
              question: "Which colour?",
              options: [{ title: "red" }, { title: "blue" }],
            },
            "q-1",
          ),
    );
    const r = await remoteWorld({ models });
    const { agents, group } = await r.agents("Ada");
    r.client.subscribe("inbox");
    const sent = await r.send(group.id, "paint it");
    const reply = sent.replies[0]!;

    await until(() => list(r).some((row) => row.status === "pending"));
    const pending = list(r).find((row) => row.status === "pending")!;
    expect(pending).toMatchObject({
      questionId: "q-1",
      agentId: agents[0]!.id,
      conversationId: group.id,
      replyId: reply.id,
      prompt: "Which colour?",
      options: ["red", "blue"],
    });
    expect(pending.sessionId).toBe(sessionOf(r, group.id));
    await r.settled(group.id, reply.id, ["waiting_for_input"]);

    const response: InboxResponse = { kind: "selection", selections: ["blue"] };
    const result = (await r.client.call("inbox", "answer", {
      id: pending.id,
      response,
    })) as { answered: boolean };
    expect(result.answered).toBe(true);
    const done = await r.settled(group.id, reply.id);
    expect(done.status).toBe("done");
    expect(done.text).toContain("blue");
    await until(() => list(r).some((row) => row.status === "answered"));
  });

  // TOBEREFR: see packages/TOBEREFR/TODO.md
  it.skip("a tool on the approval list asks before it runs on the daemon", async () => {
    const { models } = scriptedModels((request) =>
      request.lastRole === "toolResult"
        ? say(`The tool said: ${request.last}`)
        : call("bash", { command: "touch approved.txt" }, "call-1"),
    );
    const r = await remoteWorld({ models });
    const { group } = await r.agents("Ada");
    r.client.subscribe("inbox");
    await r.client.call("inbox", "setApprovals", { tools: ["bash"] });
    const sent = await r.send(group.id, "touch it");
    await until(() => list(r).some((row) => row.status === "pending"));
    const pending = list(r).find((row) => row.status === "pending")!;
    expect(pending.prompt).toContain("bash");
    // Not run yet.
    expect(existsSync(join(r.dir, "approved.txt"))).toBe(false);
    await r.client.call("inbox", "answer", {
      id: pending.id,
      response: { kind: "selection", selections: ["allow"] },
    });
    await r.settled(group.id, sent.replies[0]!.id);
    expect(existsSync(join(r.dir, "approved.txt"))).toBe(true);
  });

  it.skip("a refusal blocks the tool and the run carries on", async () => {
    const { models } = scriptedModels((request) =>
      request.lastRole === "toolResult"
        ? say(`The tool said: ${request.last}`)
        : call("bash", { command: "touch refused.txt" }, "call-1"),
    );
    const r = await remoteWorld({ models });
    const { group } = await r.agents("Ada");
    r.client.subscribe("inbox");
    await r.client.call("inbox", "setApprovals", { tools: ["bash"] });
    const sent = await r.send(group.id, "touch it");
    await until(() => list(r).some((row) => row.status === "pending"));
    await r.client.call("inbox", "answer", {
      id: list(r).find((row) => row.status === "pending")!.id,
      response: { kind: "selection", selections: ["deny"] },
    });
    const done = await r.settled(group.id, sent.replies[0]!.id);
    expect(done.text).toContain("did not approve");
    expect(existsSync(join(r.dir, "refused.txt"))).toBe(false);
  });
});

describe("stopping, steering and a link that fails", () => {
  it("stop ends the reply that is running on the daemon", async () => {
    const { models } = scriptedModels(() => HANG);
    const r = await remoteWorld({ models });
    const { group } = await r.agents("Ada");
    const sent = await r.send(group.id, "think forever");
    const reply = sent.replies[0]!;
    await r.settled(group.id, reply.id, ["working"]);
    await until(() => sessionOf(r, group.id) !== undefined);
    await r.client.call("conversations", "stop", {
      conversationId: group.id,
      messageId: reply.id,
    });
    const stopped = await r.settled(group.id, reply.id);
    expect(stopped.status).toBe("stopped");
  });

  it("steer joins the turn in flight: no second reply, and the model hears it", async () => {
    const first = gate();
    const { models, requests } = scriptedModels(async (request) => {
      if (request.index === 0) {
        await first.opened;
        return say("on it");
      }
      return say("now with your correction");
    });
    const r = await remoteWorld({ models });
    const { agents, group } = await r.agents("Ada");
    const sent = await r.send(group.id, "write the report");
    const reply = sent.replies[0]!;
    await r.settled(group.id, reply.id, ["working"]);
    await until(() => requests.length === 1);

    const steered = await r.send(group.id, "make it shorter", {
      mode: "steer",
    });
    expect(steered).toMatchObject({
      replies: [],
      joined: [agents[0]!.id],
      nobody: false,
    });
    first.open();
    const done = await r.settled(group.id, reply.id);
    expect(done.text).toBe("now with your correction");
    expect(
      r.rows(group.id).filter((row) => row.author === "agent"),
    ).toHaveLength(1);
    expect(requests[1]!.transcript.join("\n")).toContain("make it shorter");
  });

  it("steer that reaches the daemon after its turn ended gets a reply of its own, not a run nobody waits for", async () => {
    const { models, requests } = scriptedModels((request) =>
      say(request.index === 0 ? "on it" : "the shorter one"),
    );
    const r = await remoteWorld({ models });
    const { agents, group } = await r.agents("Ada");
    // The run's end is held on its way back: the daemon's session is idle, while the primary
    // still has the turn as running — the window between a turn ending and the word of it.
    const ended = gate();
    const delivered = gate();
    const link = r.host.product.hub.link(r.daemon.machineId)!;
    const daemon = link.daemon.bind(link);
    link.daemon = ((...args: Parameters<typeof daemon>) => {
      const answer = daemon(...args);
      if (args[0] !== "run") return answer;
      return answer.then(async (outcome) => {
        ended.open();
        await delivered.opened;
        return outcome;
      });
    }) as typeof link.daemon;

    // A failed assertion must not leave the held run (and the test's teardown) waiting.
    try {
      const sent = await r.send(group.id, "write the report");
      const reply = sent.replies[0]!;
      await ended.opened;
      expect(r.row(group.id, reply.id)?.status).toBe("working");

      const steered = await r.send(group.id, "make it shorter", {
        mode: "steer",
      });
      // The daemon refused it (no run to take it), so it is answered as a reply of its own.
      expect(steered.joined).toEqual([]);
      expect(steered.replies).toHaveLength(1);
      expect(steered.message.data).toMatchObject({
        joined: [],
        woke: [agents[0]!.id],
      });
      // Nothing started on the daemon behind the primary's back.
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(requests).toHaveLength(1);

      delivered.open();
      expect((await r.settled(group.id, reply.id)).text).toBe("on it");
      const own = await r.settled(group.id, steered.replies[0]!.id);
      expect(own).toMatchObject({ status: "done", text: "the shorter one" });
      expect(requests).toHaveLength(2);
      expect(
        requests.filter((request) =>
          request.transcript.join("\n").includes("make it shorter"),
        ),
      ).toHaveLength(1);
    } finally {
      delivered.open();
    }
  });

  it("a queued message waits behind the reply that is running, as it does at home", async () => {
    const first = gate();
    const order: string[] = [];
    const { models } = scriptedModels(async (request) => {
      order.push(request.last);
      if (request.index === 0) await first.opened;
      return say(`answer ${request.index}`);
    });
    const r = await remoteWorld({ models });
    const { group } = await r.agents("Ada");
    const one = await r.send(group.id, "first");
    await r.settled(group.id, one.replies[0]!.id, ["working"]);
    const two = await r.send(group.id, "second");
    expect(r.row(group.id, two.replies[0]!.id)?.status).toBe("queued");
    first.open();
    await r.settled(group.id, two.replies[0]!.id);
    expect(order).toHaveLength(2);
    expect(order[0]).toContain("first");
    expect(order[1]).toContain("second");
  });

  it("a link that drops mid-run fails the reply as an unknown outcome and nothing is replayed", async () => {
    const { models, requests } = scriptedModels(() => HANG);
    const r = await remoteWorld({ models });
    const { group } = await r.agents("Ada");
    const sent = await r.send(group.id, "do the thing");
    const reply = sent.replies[0]!;
    await r.settled(group.id, reply.id, ["working"]);
    await until(() => requests.length === 1);

    r.daemon.link.drop();
    const failed = await r.settled(group.id, reply.id);
    expect(failed.status).toBe("failed");
    expect(failed.text).toMatch(/link/);
    expect(failed.text).toMatch(/unknown/);
    expect(failed.text).toMatch(/Nothing was run again/);
    expect(failed.data).toMatchObject({ code: "link_lost" });

    // The daemon comes back; the reply is not started again, and the model is not asked again.
    await until(
      () => machineView(r.client, r.daemon.machineId)?.status === "online",
    );
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(requests).toHaveLength(1);
    expect(r.row(group.id, reply.id)?.status).toBe("failed");
  });
});

describe("the global session list and the mirror", () => {
  const listed = (r: {
    client: { section: <T>(t: string, n: string) => T | undefined };
  }) => r.client.section<SidebarSession[]>("sessions", "list") ?? [];

  it("lists a daemon's sessions with the machine they run on, and keeps them when it goes offline", async () => {
    const { models } = scriptedModels(() => say("noted"));
    const r = await remoteWorld({ models });
    const { group } = await r.agents("Ada");
    r.client.subscribe("sessions");
    const sent = await r.send(group.id, "one");
    await r.settled(group.id, sent.replies[0]!.id);
    const session = sessionOf(r, group.id)!;

    await until(() => listed(r).some((row) => row.id === session));
    const machine = machineView(r.client, r.daemon.machineId)!;
    const row = listed(r).find((candidate) => candidate.id === session)!;
    expect(row.machine).toBe(machine.name);
    expect(row.badges).not.toContain("offline");

    // The daemon goes away for good: its sessions stay in the list, marked unreachable.
    await r.daemon.link.stop();
    await until(
      () =>
        listed(r)
          .find((candidate) => candidate.id === session)
          ?.badges.includes("offline") === true,
    );
  });

  it("does not show the browser an event twice when a mirror warms again", async () => {
    const { models } = scriptedModels((request) =>
      say(`answer to ${request.last}`),
    );
    const r = await remoteWorld({ models });
    const { group } = await r.agents("Ada");
    const first = await r.send(group.id, "one");
    await r.settled(group.id, first.replies[0]!.id);
    const session = sessionOf(r, group.id)!;
    const target = `sessions.${session}`;
    const runEnds = () =>
      r.client.frames.filter(
        (frame) =>
          frame.type === "event" &&
          frame.target === target &&
          frame.name === "turn:run-end",
      ).length;

    r.client.subscribe(target);
    // The daemon's ring has the first run in it, replayed to the first subscriber.
    await until(() => runEnds() === 1);

    // The link drops and returns: the mirror warms again and is replayed the whole ring.
    await dropLink(r.host, r.client, r.daemon);
    const second = await r.send(group.id, "two");
    await r.settled(group.id, second.replies[0]!.id);
    await until(() => runEnds() === 2);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(runEnds()).toBe(2);
  });
});

describe("large images over the link (#960)", () => {
  const originalHome = process.env.HOME;
  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  });

  const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });

  function pngChunk(type: string, data: Buffer): Buffer {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, "ascii");
    data.copy(out, 8);
    let crc = 0xffffffff;
    for (const byte of out.subarray(4, 8 + data.length))
      crc = CRC_TABLE[(crc ^ byte) & 255]! ^ (crc >>> 8);
    out.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 8 + data.length);
    return out;
  }

  function noisePng(side: number): Buffer {
    const row = 1 + side * 3;
    const raw = Buffer.alloc(row * side);
    crypto.getRandomValues(raw);
    for (let y = 0; y < side; y += 1) raw[y * row] = 0;
    const header = Buffer.alloc(13);
    header.writeUInt32BE(side, 0);
    header.writeUInt32BE(side, 4);
    header[8] = 8;
    header[9] = 2;
    return Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      pngChunk("IHDR", header),
      pngChunk("IDAT", deflateSync(raw, { level: 1 })),
      pngChunk("IEND", Buffer.alloc(0)),
    ]);
  }

  async function uploadImage(
    r: Awaited<ReturnType<typeof remoteWorld>>,
    conversationId: string,
    bytes: Buffer,
    name: string,
    contentType = "image/png",
  ): Promise<AttachmentView> {
    const piece = 384 * 1024;
    const uploadId = crypto.randomUUID();
    const count = Math.max(1, Math.ceil(bytes.byteLength / piece));
    let result: { attachment: AttachmentView | null } = { attachment: null };
    for (let index = 0; index < count; index += 1) {
      result = (await r.client.call("conversations", "attach", {
        conversationId,
        uploadId,
        name,
        contentType,
        index,
        last: index === count - 1,
        data: bytes
          .subarray(index * piece, (index + 1) * piece)
          .toString("base64"),
      })) as typeof result;
    }
    return result.attachment!;
  }

  function assertAllFramesBounded(traffic: { in: string[]; out: string[] }) {
    expect(traffic.in.length).toBeGreaterThan(0);
    expect(traffic.out.length).toBeGreaterThan(0);
    for (const frame of [...traffic.in, ...traffic.out]) {
      expect(Buffer.byteLength(frame, "utf8")).toBeLessThanOrEqual(
        LINK_LIMITS.maxFrameBytes,
      );
    }
  }

  it.skipIf(process.platform === "win32")(
    "sends >8 MiB image attachments and multi-turn image conversations without exceeding frame limits or poisoning the session",
    async () => {
      process.env.HOME = await tempDir("eta-daemon-home-");
      const { models, requests } = scriptedModels(
        (request) => say(`seen ${request.images} images`),
        { vision: true },
      );
      const r = await remoteWorld({ models });
      const { group } = await r.agents("Ada");

      const bigPng = noisePng(1750);
      expect(bigPng.byteLength).toBeGreaterThan(8 * 1024 * 1024);
      const mediumPng = noisePng(1250);
      expect(mediumPng.byteLength).toBeLessThanOrEqual(5 * 1024 * 1024);

      const att1 = await uploadImage(r, group.id, bigPng, "big.png");
      const att2 = await uploadImage(r, group.id, mediumPng, "med1.png");
      const first = await r.send(group.id, "turn 1 images", {
        attachments: [att1.id, att2.id],
      });
      const r1 = await r.settled(group.id, first.replies[0]!.id);
      expect(r1).toMatchObject({ status: "done", text: "seen 2 images" });

      const att3 = await uploadImage(r, group.id, mediumPng, "med2.png");
      const second = await r.send(group.id, "turn 2 image", {
        attachments: [att3.id],
      });
      const r2 = await r.settled(group.id, second.replies[0]!.id);
      expect(r2).toMatchObject({ status: "done", text: "seen 3 images" });

      const third = await r.send(group.id, "plain text follow-up");
      const r3 = await r.settled(group.id, third.replies[0]!.id);
      expect(r3).toMatchObject({ status: "done", text: "seen 3 images" });

      expect(requests).toHaveLength(3);
      expect(r.traffic.in.some((f) => f.includes('"ch":"chunk"'))).toBe(true);
      expect(r.traffic.out.some((f) => f.includes('"ch":"chunk"'))).toBe(true);
      assertAllFramesBounded(r.traffic);
    },
    60_000,
  );

  it.skipIf(process.platform === "win32")(
    "steers a running remote turn with >8 MiB of images",
    async () => {
      process.env.HOME = await tempDir("eta-daemon-home-");
      const first = gate();
      const { models, requests } = scriptedModels(
        async (request) => {
          if (request.index === 0) {
            await first.opened;
            return say("first done");
          }
          return say(`steered with ${request.images} images`);
        },
        { vision: true },
      );
      const r = await remoteWorld({ models });
      const { agents, group } = await r.agents("Ada");

      const sent = await r.send(group.id, "start working");
      const reply = sent.replies[0]!;
      await r.settled(group.id, reply.id, ["working"]);
      await until(() => requests.length === 1);

      const mediumPng = noisePng(1250);
      const att1 = await uploadImage(r, group.id, mediumPng, "s1.png");
      const att2 = await uploadImage(r, group.id, mediumPng, "s2.png");
      const steered = await r.send(group.id, "look at these while running", {
        mode: "steer",
        attachments: [att1.id, att2.id],
      });
      expect(steered.joined).toEqual([agents[0]!.id]);

      first.open();
      const done = await r.settled(group.id, reply.id);
      expect(done).toMatchObject({
        status: "done",
        text: "steered with 2 images",
      });
      expect(requests[1]!.images).toBe(2);
      expect(r.traffic.in.some((f) => f.includes('"ch":"chunk"'))).toBe(true);
      expect(r.traffic.out.some((f) => f.includes('"ch":"chunk"'))).toBe(true);
      assertAllFramesBounded(r.traffic);
    },
    60_000,
  );

  it.skipIf(process.platform === "win32")(
    "supports read_image, sessions.prompt, and sessions.image with >8 MiB base64 payloads",
    async () => {
      process.env.HOME = await tempDir("eta-daemon-home-");
      let fileId = "";
      const { models, requests } = scriptedModels(
        (request) => {
          if (request.last.includes("direct big image"))
            return say("saw direct");
          if (request.lastRole === "toolResult")
            return say(`read ${request.images} images`);
          return call("read_image", { file: fileId });
        },
        { vision: true },
      );
      const r = await remoteWorld({ models });
      const { group } = await r.agents("Ada");

      const bigPng = noisePng(1750);
      const att = await uploadImage(r, group.id, bigPng, "giant.png");
      fileId = att.id;
      const sent = await r.send(group.id, "inspect with read_image", {
        attachments: [att.id],
      });
      const done = await r.settled(group.id, sent.replies[0]!.id);
      expect(done).toMatchObject({ status: "done", text: "read 2 images" });

      const session = sessionOf(r, group.id)!;
      const directBase64 = noisePng(1480).toString("base64");
      expect(directBase64.length).toBeGreaterThan(LINK_LIMITS.maxFrameBytes);

      await r.client.call("sessions", "prompt", {
        session,
        text: "direct big image",
        images: [{ mime: "image/png", dataBase64: directBase64 }],
      });
      await until(() =>
        requests.some((req) => req.last.includes("direct big image")),
      );

      let targetRow: ViewMessageRow | undefined;
      await until(async () => {
        const resynced = (await r.client.call("sessions", "resync", {
          session,
        })) as {
          state: { sections: { transcript?: { messages: ViewMessageRow[] } } };
        };
        const rows = resynced.state.sections.transcript?.messages ?? [];
        const hasReply = rows.some((row) =>
          JSON.stringify(row.message).includes("saw direct"),
        );
        if (!hasReply) return false;
        targetRow = rows.find((row) =>
          JSON.stringify(row.message).includes("direct big image"),
        );
        return targetRow !== undefined;
      });

      const parts = (targetRow!.message as { content: { type?: string }[] })
        .content;
      const imageIndex = parts.findIndex((part) => part.type === "image");
      expect(imageIndex).toBeGreaterThanOrEqual(0);

      const fetched = (await r.client.call("sessions", "image", {
        session,
        entryId: targetRow!.entryId,
        index: imageIndex,
      })) as { mimeType: string; data: string };
      expect(fetched).toEqual({ mimeType: "image/png", data: directBase64 });

      expect(r.traffic.in.some((f) => f.includes('"ch":"chunk"'))).toBe(true);
      expect(r.traffic.out.some((f) => f.includes('"ch":"chunk"'))).toBe(true);
      assertAllFramesBounded(r.traffic);
    },
    60_000,
  );

  it.skipIf(process.platform === "win32")(
    "adds a visible not-shown note instead of failing or silently dropping an undecodable large image",
    async () => {
      process.env.HOME = await tempDir("eta-daemon-home-");
      const { models, requests } = scriptedModels(() => say("acknowledged"), {
        vision: true,
      });
      const r = await remoteWorld({ models });
      const { group } = await r.agents("Ada");

      const corrupt = Buffer.alloc(6 * 1024 * 1024);
      crypto.getRandomValues(corrupt);
      const att = await uploadImage(r, group.id, corrupt, "corrupt.png");
      const sent = await r.send(group.id, "check this file", {
        attachments: [att.id],
      });
      const done = await r.settled(group.id, sent.replies[0]!.id);
      expect(done).toMatchObject({ status: "done", text: "acknowledged" });
      expect(requests[0]!.images).toBe(0);
      const transcript = requests[0]!.transcript.join("\n");
      expect(transcript).toContain("corrupt.png");
      expect(transcript).toContain("; not shown:");
    },
    60_000,
  );
});
