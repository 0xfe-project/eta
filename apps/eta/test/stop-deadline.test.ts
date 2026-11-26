/**
 * Stop is the user's: a reply they stopped ends, whether or not its run listens.
 *
 * A run that does not end when told to (a model stream or a tool that ignores the abort, a daemon
 * whose stop never arrives, a link that went down) used to leave the reply `stopping` for good.
 * These tests are about what the user sees: the reply's status and the words that say why.
 */
import type { MessageView } from "@eta/client-contracts";
import type { RemoteWorld } from "./support/remote";
import type { World } from "./support/world";
import { createRuntimeRegistry } from "@botiverse/oar";
import { scriptedRuntime } from "@botiverse/oar/testing";
import { createOarRuntimes } from "@eta/runtime-oar";
import { describe, expect, it } from "vitest";
import { until } from "./support/client";
import { machineView } from "./support/daemon";
import { tempDir } from "./support/host";
import { call, gate, HANG, say, scriptedModels } from "./support/models";
import { remoteWorld, sessionOf } from "./support/remote";
import { world } from "./support/world";

/** How long these tests give a run to stop before the host stops it itself. */
const GRACE = 300;

async function ada(w: World) {
  const agent = await w.agent("Ada");
  const project = await w.project();
  const group = await w.group(project.id, [agent.id]);
  await w.watch(group.id);
  return { agent, project, group };
}

const stop = async (w: World, conversationId: string, messageId?: string) =>
  (
    (await w.client.call("conversations", "stop", {
      conversationId,
      ...(messageId === undefined ? {} : { messageId }),
    })) as { stopped: MessageView[] }
  ).stopped;

/** A model that answers when the test lets it, and never hears an abort. */
function deaf() {
  const late = gate();
  const { models, requests } = scriptedModels(async (request) => {
    if (request.index === 0) {
      await late.opened;
      return say("the words that came too late");
    }
    return say(`answer ${request.index}`);
  });
  return { models, requests, late };
}

/**
 * Make the daemon's stops go nowhere, as on a link that is dying but not yet called dead: the
 * `sessions.abort` call never comes back (`refuse` makes it fail instead), and the run's own call
 * carries no cancel.
 */
function loseStops(r: RemoteWorld, refuse?: string): void {
  const link = r.host.product.hub.link(r.daemon.machineId)!;
  const call = link.pipe.call.bind(link.pipe);
  link.pipe.call = ((...args: Parameters<typeof call>) =>
    args[0] === "sessions" && args[1] === "abort"
      ? refuse === undefined
        ? new Promise(() => undefined)
        : Promise.reject(new Error(refuse))
      : call(...args)) as typeof link.pipe.call;
  const daemon = link.daemon.bind(link);
  link.daemon = ((method: string, params: unknown, options?: object) =>
    daemon(method as never, params as never, {
      ...options,
      signal: undefined,
    })) as typeof link.daemon;
}

describe("a run that does not stop when told to", () => {
  it("ends as stopped within five seconds, and says it was stopped here", async () => {
    const { models, requests, late } = deaf();
    const w = await world({ models });
    try {
      const { group } = await ada(w);
      const sent = await w.send(group.id, "think forever");
      const reply = sent.replies[0]!;
      await w.settled(group.id, reply.id, ["working"]);
      await until(() => requests.length === 1);

      const asked = Date.now();
      expect(
        (await stop(w, group.id, reply.id)).map((row) => row.status),
      ).toEqual(["stopping"]);
      const ended = await w.settled(group.id, reply.id);
      const took = Date.now() - asked;
      expect(ended.status).toBe("stopped");
      expect(took).toBeGreaterThanOrEqual(4_500);
      expect(took).toBeLessThan(6_500);
      expect(ended.data.stopNote).toMatch(
        /Ada (on .* )?did not stop when asked/,
      );
    } finally {
      late.open();
    }
  }, 15_000);

  it("keeps what the run says afterwards out of the conversation", async () => {
    const { models, requests, late } = deaf();
    const w = await world({ models, replies: { stopGraceMs: GRACE } });
    const { group } = await ada(w);
    const sent = await w.send(group.id, "think forever");
    const reply = sent.replies[0]!;
    await w.settled(group.id, reply.id, ["working"]);
    await until(() => requests.length === 1);
    await stop(w, group.id, reply.id);
    const ended = await w.settled(group.id, reply.id);
    expect(ended.status).toBe("stopped");

    late.open();
    await new Promise((resolve) => setTimeout(resolve, 200));
    const after = w.row(group.id, reply.id)!;
    expect(after.status).toBe("stopped");
    expect(after.text).not.toContain("too late");
    expect(after.revision).toBe(ended.revision);
  });

  it("stopped again while stopping, ends at once", async () => {
    const { models, requests, late } = deaf();
    // A grace far longer than the test: only the second stop can end it in time.
    const w = await world({ models, replies: { stopGraceMs: 60_000 } });
    try {
      const { group } = await ada(w);
      const sent = await w.send(group.id, "think forever");
      const reply = sent.replies[0]!;
      await w.settled(group.id, reply.id, ["working"]);
      await until(() => requests.length === 1);
      await stop(w, group.id, reply.id);
      await w.settled(group.id, reply.id, ["stopping"]);

      const again = await stop(w, group.id, reply.id);
      expect(again.map((row) => row.status)).toEqual(["stopped"]);
      const ended = await w.settled(group.id, reply.id);
      expect(ended.status).toBe("stopped");
      expect(ended.data.stopNote).toMatch(
        /Ada (on .* )?did not stop when asked/,
      );
    } finally {
      late.open();
    }
  });

  it("does not keep the agent's next message waiting once the old run is let go of", async () => {
    const { models, requests, late } = deaf();
    const w = await world({ models, replies: { stopGraceMs: GRACE } });
    const { group } = await ada(w);
    const first = await w.send(group.id, "think forever");
    await w.settled(group.id, first.replies[0]!.id, ["working"]);
    await until(() => requests.length === 1);
    await stop(w, group.id, first.replies[0]!.id);
    await w.settled(group.id, first.replies[0]!.id);

    // The old run ends a moment later, as a slow one does; the next message is answered.
    const second = await w.send(group.id, "are you there?");
    setTimeout(() => late.open(), 100);
    const answered = await w.settled(group.id, second.replies[0]!.id);
    expect(answered).toMatchObject({ status: "done", text: "answer 1" });
    expect(w.row(group.id, first.replies[0]!.id)?.status).toBe("stopped");
  });

  it("a next message to an agent whose stopped run never ends fails and says why, instead of waiting forever", async () => {
    const { models, requests, late } = deaf();
    const w = await world({ models, replies: { stopGraceMs: GRACE } });
    try {
      const { group } = await ada(w);
      const first = await w.send(group.id, "think forever");
      await w.settled(group.id, first.replies[0]!.id, ["working"]);
      await until(() => requests.length === 1);
      await stop(w, group.id, first.replies[0]!.id);
      await w.settled(group.id, first.replies[0]!.id);

      const second = await w.send(group.id, "are you there?");
      const failed = await w.settled(group.id, second.replies[0]!.id);
      expect(failed.status).toBe("failed");
      expect(failed.text).toMatch(/still busy with the reply you stopped/);
    } finally {
      late.open();
    }
  });
});

describe("a run waiting on a tool that never settles", () => {
  /**
   * The reply is stopped, and the run it was on is waiting on a tool that will not come back (a
   * script parked on a promise nothing resolves). Being told to stop is enough: the tool call is
   * reported cancelled, the run ends, and the agent is free for the next message at once — not
   * "still busy with the reply you stopped" until the grace runs out.
   */
  it("frees the agent as soon as the stop is heard, without waiting out the grace", async () => {
    const { models, requests } = scriptedModels((request) =>
      request.index === 0
        ? call("esmrun", { script: "await new Promise(() => {});" })
        : say("answer after the stop"),
    );
    const w = await world({ models, replies: { stopGraceMs: GRACE } });
    const { group } = await ada(w);
    const first = await w.send(group.id, "run something that never comes back");
    const reply = first.replies[0]!;
    await w.settled(group.id, reply.id, ["working"]);
    // The tool call is in flight and nothing the run does will settle it.
    await until(() => requests.length === 1);

    await stop(w, group.id, reply.id);
    const ended = await w.settled(group.id, reply.id);
    expect(ended.status).toBe("stopped");

    // What the user hits next: the message they send once the reply is stopped. Without the fix
    // the run is still waiting on the tool, so this one is refused as "still busy".
    const second = await w.send(group.id, "are you there?");
    const answered = await w.settled(group.id, second.replies[0]!.id);
    expect(answered).toMatchObject({
      status: "done",
      text: "answer after the stop",
    });
    // Not "stopped here after the grace": the run heard the stop and ended by itself.
    expect(ended.data.stopNote).toBeUndefined();
  }, 30_000);
});

describe("a reply on Claude Code that is stopped", () => {
  /** A host whose Claude Code is a script that works until told to stop, or never stops. */
  async function onClaude(listens: boolean) {
    const late = gate();
    const started = gate();
    const w = await world({
      replies: { stopGraceMs: GRACE },
      runtimes: createOarRuntimes({
        registry: createRuntimeRegistry([
          scriptedRuntime({
            id: "claude",
            turn: async (turn) => {
              started.open();
              await (listens
                ? new Promise((resolve) =>
                    turn.signal.addEventListener("abort", resolve),
                  )
                : late.opened);
              turn.say("the words that came too late");
            },
          }),
        ]),
      }),
    });
    const agent = await w.agent("Ada", { runtime: "claude" });
    const project = await w.project();
    const group = await w.group(project.id, [agent.id]);
    await w.watch(group.id);
    return { w, group, started, late };
  }

  it("ends as stopped when the runtime stops", async () => {
    const { w, group, started } = await onClaude(true);
    const sent = await w.send(group.id, "work");
    const reply = sent.replies[0]!;
    await w.settled(group.id, reply.id, ["working"]);
    await started.opened;
    await stop(w, group.id, reply.id);
    const ended = await w.settled(group.id, reply.id);
    expect(ended.status).toBe("stopped");
    expect(ended.data.stopNote).toBeUndefined();
  });

  it("ends as stopped at once even when the runtime's own work ignores the stop: oar ends the turn", async () => {
    const { w, group, started, late } = await onClaude(false);
    try {
      const sent = await w.send(group.id, "work");
      const reply = sent.replies[0]!;
      await w.settled(group.id, reply.id, ["working"]);
      await started.opened;
      const asked = Date.now();
      await stop(w, group.id, reply.id);
      const ended = await w.settled(group.id, reply.id);
      expect(ended.status).toBe("stopped");
      expect(Date.now() - asked).toBeLessThan(GRACE);
      expect(ended.data.stopNote).toBeUndefined();
    } finally {
      late.open();
    }
  });
});

describe("a reply on another machine that is stopped", () => {
  it("ends within the grace when the stop never reaches the daemon", async () => {
    const { models, requests } = scriptedModels(() => HANG);
    const r = await remoteWorld({ models, replies: { stopGraceMs: GRACE } });
    const { group } = await r.agents("Ada");
    const sent = await r.send(group.id, "think forever");
    const reply = sent.replies[0]!;
    await r.settled(group.id, reply.id, ["working"]);
    await until(() => requests.length === 1);
    loseStops(r);

    await stop(r, group.id, reply.id);
    const ended = await r.settled(group.id, reply.id);
    expect(ended.status).toBe("stopped");
    expect(ended.data.stopNote).toMatch(/Ada (on .* )?did not stop when asked/);
  });

  it("says so on the reply when the stop cannot be sent, and ends it", async () => {
    const { models, requests } = scriptedModels(() => HANG);
    const r = await remoteWorld({ models, replies: { stopGraceMs: 60_000 } });
    const { group } = await r.agents("Ada");
    const sent = await r.send(group.id, "think forever");
    const reply = sent.replies[0]!;
    await r.settled(group.id, reply.id, ["working"]);
    await until(() => requests.length === 1);
    // The daemon refuses the stop, as one that lost the session would.
    loseStops(r, "no such session over there");

    await stop(r, group.id, reply.id);
    const ended = await r.settled(group.id, reply.id);
    expect(ended.status).toBe("stopped");
    expect(ended.data.stopNote).toMatch(/Could not tell .* to stop Ada/);
    expect(ended.data.stopNote).toMatch(/no such session over there/);
  });
});

describe("a link that goes down", () => {
  it("ends every reply on that machine at once, and says the link was lost", async () => {
    const { models, requests } = scriptedModels(() => HANG);
    const r = await remoteWorld({ models, replies: { stopGraceMs: 60_000 } });
    const { agents, group } = await r.agents("Ada", "Bea");
    const sent = await r.send(group.id, "both of you", {
      mentions: agents.map((agent) => agent.id),
    });
    const [one, two] = sent.replies;
    await r.settled(group.id, one!.id, ["working"]);
    await r.settled(group.id, two!.id, ["working"]);
    await until(() => requests.length === 2);
    // One of them is being stopped when the link goes; the stop has not got there.
    loseStops(r);
    await stop(r, group.id, one!.id);
    await r.settled(group.id, one!.id, ["stopping"]);

    const machine = machineView(r.client, r.daemon.machineId)!.name;
    const cut = Date.now();
    r.daemon.link.drop();
    const [a, b] = await Promise.all([
      r.settled(group.id, one!.id),
      r.settled(group.id, two!.id),
    ]);
    expect(Date.now() - cut).toBeLessThan(5_000);
    expect(a.status).toBe("stopped");
    expect(a.data.stopNote).toContain(`The link to ${machine} was lost`);
    expect(b.status).toBe("failed");
    expect(b.text).toContain(`The link to ${machine}`);
  });

  it("lets the agent answer again once the link is back", async () => {
    const { models, requests } = scriptedModels((request) =>
      request.index === 0 ? HANG : say("back again"),
    );
    const r = await remoteWorld({ models });
    const { group } = await r.agents("Ada");
    const sent = await r.send(group.id, "do the thing");
    await r.settled(group.id, sent.replies[0]!.id, ["working"]);
    await until(() => requests.length === 1);

    r.daemon.link.drop();
    await r.settled(group.id, sent.replies[0]!.id);
    await until(
      () => machineView(r.client, r.daemon.machineId)?.status === "online",
    );
    const next = await r.send(group.id, "and now?");
    const answered = await r.settled(group.id, next.replies[0]!.id);
    expect(answered).toMatchObject({ status: "done", text: "back again" });
  });
});

describe("a daemon whose run nobody waits for", () => {
  it("stops it, so the session's next run is its own", async () => {
    const { models, requests } = scriptedModels((request) =>
      request.index <= 1 ? HANG : say("the next one"),
    );
    const r = await remoteWorld({ models });
    const { group } = await r.agents("Ada");
    const first = await r.send(group.id, "warm up");
    await until(() => requests.length === 1);
    await r.client.call("conversations", "stop", { conversationId: group.id });
    await r.settled(group.id, first.replies[0]!.id);
    const session = sessionOf(r, group.id)!;
    const link = r.host.product.hub.link(r.daemon.machineId)!;

    // A run the primary then stops waiting for: its call is cancelled, as a lost link does.
    const cancel = new AbortController();
    const abandoned = link.daemon(
      "run",
      { session, text: "think forever" },
      { signal: cancel.signal },
    );
    await until(() => requests.length === 2);
    cancel.abort();
    await expect(abandoned).rejects.toThrow();

    const next = (await link.daemon("run", {
      session,
      text: "and now?",
    })) as { status: string; text: string };
    expect(next).toMatchObject({ status: "completed", text: "the next one" });
  });
});

describe("a restart", () => {
  it("ends a reply left stopping as stopped, not as a failure", async () => {
    const dataDir = await tempDir();
    const { models } = scriptedModels(() => HANG);
    const first = await world({ dataDir, models });
    const { group } = await ada(first);
    const sent = await first.send(group.id, "one");
    const id = sent.replies[0]!.id;
    await first.settled(group.id, id, ["working"]);
    first.host.db.exec(
      `UPDATE message SET status = 'stopping' WHERE id = '${id}'`,
    );
    const copy = await tempDir();
    first.host.db.exec(`VACUUM INTO '${copy}/eta.sqlite'`);

    const restarted = await world({ dataDir: copy });
    await restarted.watch(group.id);
    const row = restarted.row(group.id, id)!;
    expect(row.status).toBe("stopped");
    expect(row.data.stopNote).toMatch(/restarted/);
  });
});
