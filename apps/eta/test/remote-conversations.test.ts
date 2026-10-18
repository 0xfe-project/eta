import type { InboxResponse, InteractionView } from "@eta/client-contracts";
/**
 * A conversation in a project on another machine.
 *
 * Every test runs a real daemon against a real host. The reply's session lives on the daemon (its
 * kernel, its journal and its tools are there), the models are the primary's (scripted here, and
 * the daemon has none), and the browser is a wire client of the primary that watches the session
 * as it would a local one.
 */
import type { KernelModels } from "@eta/core";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { until } from "./support/client";
import { machineView } from "./support/daemon";
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
      expect.arrayContaining(["mention", "conversation_info", "bash", "read"]),
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

  it("its file and shell tools work on the daemon's machine", async () => {
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
            assignee: "user",
          }),
    );
    const r = await remoteWorld({ models });
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

  it("publish_artifact reads the files on the daemon's machine, through the link", async () => {
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
    await new Promise((resolve) => setTimeout(resolve, 100));
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
    await until(() => stateFrames(r, session) > 0);

    r.daemon.link.drop();
    await until(
      () => machineView(r.client, r.daemon.machineId)?.status === "offline",
    );
    await until(
      () => machineView(r.client, r.daemon.machineId)?.status === "online",
    );
    const second = await r.send(group.id, "after the drop");
    await r.settled(group.id, second.replies[0]!.id);
    await until(() =>
      JSON.stringify(
        r.client.frames.filter(
          (frame) =>
            frame.type === "state" && frame.target === `sessions.${session}`,
        ),
      ).includes("answer to"),
    );
    // The reply that ran after the reconnect is in what the browser was shown.
    await until(() =>
      r.traffic.in.some((text) => text.includes("after the drop")),
    );
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
    await r.client.call("projects", "setSteward", {
      projectId: r.remoteProject.id,
      agentId: zed.id,
    });
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

  it("a tool on the approval list asks before it runs on the daemon", async () => {
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

  it("a refusal blocks the tool and the run carries on", async () => {
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
