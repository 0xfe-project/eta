/**
 * Usage: every generation a session makes is counted with the agent and conversation it was made
 * for, the sums are reads of those rows, and nothing older than thirty days is kept.
 */
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentUsage, UsageSections } from "@eta/client-contracts";
import type { UsageEntry } from "../src/usage/store";
import type { World } from "./support/world";
import { USAGE_WINDOWS } from "@eta/client-contracts";
import { describe, expect, it } from "vitest";
import { applyMigrations, loadMigrations, openDatabase } from "../src/db";
import { UsageStore } from "../src/usage/store";
import { until } from "./support/client";
import { tempDir } from "./support/host";
import { call, say, scriptedModels } from "./support/models";
import { world } from "./support/world";

/** A settled answer with a bill: the tokens, the cost, and who answered. */
function billed(
  message: AssistantMessage,
  bill: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    reasoning?: number;
    cost?: number;
    provider?: string;
    model?: string;
  } = {},
): AssistantMessage {
  const input = bill.input ?? 0;
  const output = bill.output ?? 0;
  const cacheRead = bill.cacheRead ?? 0;
  const cacheWrite = bill.cacheWrite ?? 0;
  return {
    ...message,
    provider: bill.provider ?? "acme",
    model: bill.model ?? "m1",
    usage: {
      input,
      output,
      cacheRead,
      cacheWrite,
      ...(bill.reasoning === undefined ? {} : { reasoning: bill.reasoning }),
      totalTokens: input + output + cacheRead + cacheWrite,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: bill.cost ?? 0,
      },
    },
  };
}

async function ada(w: World, name = "Ada") {
  const agent = await w.agent(name);
  const project = await w.project({ stewardId: agent.id });
  const group = await w.group(project.id, [agent.id]);
  await w.watch(group.id);
  return { agent, project, group };
}

/** What a client that subscribes to `usage` holds. */
const sections = (w: World): Partial<UsageSections> => ({
  agents: w.client.section<AgentUsage[]>("usage", "agents"),
  models: w.client.section<UsageSections["models"]>("usage", "models"),
  days: w.client.section<UsageSections["days"]>("usage", "days"),
});

const rows = (w: World) =>
  w.host.db.query("SELECT * FROM usage ORDER BY id").all() as Record<
    string,
    unknown
  >[];

const today = () => new Date().toISOString().slice(0, 10);

describe("the usage target", () => {
  it("is on the pipe, empty at first", async () => {
    const w = await world();
    const hello = await w.client.hello();
    expect(hello.mounted.map((plugin) => plugin.name)).toContain("usage");
    w.client.subscribe("usage");
    await until(() => sections(w).agents !== undefined);
    expect(sections(w)).toEqual({ agents: [], models: [], days: [] });
  });
});

describe("generations made for an agent", () => {
  it("are recorded with its agent, conversation and session, and summed", async () => {
    const { models } = scriptedModels((request) =>
      request.lastRole === "toolResult"
        ? billed(say("done"), {
            input: 200,
            output: 30,
            cacheRead: 100,
            cost: 0.02,
          })
        : billed(call("conversation_info", {}), {
            input: 100,
            output: 20,
            cacheWrite: 5,
            reasoning: 7,
            cost: 0.0125,
          }),
    );
    const w = await world({ models });
    const { agent, group } = await ada(w);
    w.client.subscribe("usage");
    const sent = await w.send(group.id, "hello");
    await w.settled(group.id, sent.replies[0]!.id);

    // Two generations: the one that asked for a tool, and the one that answered.
    expect(rows(w)).toMatchObject([
      {
        agent_id: agent.id,
        conversation_id: group.id,
        provider: "acme",
        model: "m1",
        input: 100,
        output: 20,
        cache_write: 5,
        reasoning: 7,
        total: 125,
        cost: 0.0125,
        status: "ok",
        error: null,
      },
      { input: 200, output: 30, cache_read: 100, total: 330, status: "ok" },
    ]);
    const sessionId = rows(w)[0]!.session_id;
    expect(rows(w)[1]!.session_id).toBe(sessionId);

    const totals = {
      requests: 2,
      failed: 0,
      input: 300,
      output: 50,
      cacheRead: 100,
      cacheWrite: 5,
      reasoning: 7,
      total: 455,
      cost: 0.0325,
    };
    await until(() => sections(w).days?.length === 1);
    const [usage] = sections(w).agents!;
    expect(usage).toMatchObject({ agentId: agent.id });
    for (const window of USAGE_WINDOWS)
      expect(usage!.windows[window]).toEqual(totals);
    expect(usage!.models).toEqual([
      { provider: "acme", model: "m1", ...totals },
    ]);
    expect(sections(w).models).toEqual(usage!.models);
    expect(sections(w).days).toEqual([{ day: today(), ...totals }]);
  });

  it("are told apart by agent and by model", async () => {
    const { models } = scriptedModels((request) =>
      request.agent === "Ada"
        ? billed(say("a"), { input: 10, output: 1, cost: 0.1 })
        : billed(say("b"), {
            input: 40,
            output: 4,
            cost: 0.4,
            provider: "other",
            model: "m2",
          }),
    );
    const w = await world({ models });
    const one = await ada(w, "Ada");
    const bob = await w.agent("Bob");
    const two = await w.group(one.project.id, [bob.id]);
    await w.watch(two.id);
    w.client.subscribe("usage");
    const first = await w.send(one.group.id, "hi");
    const second = await w.send(two.id, "hi", { mentions: [bob.id] });
    await w.settled(one.group.id, first.replies[0]!.id);
    await w.settled(two.id, second.replies[0]!.id);
    await until(() => sections(w).agents?.length === 2);

    const byAgent = Object.fromEntries(
      sections(w).agents!.map((agent) => [agent.agentId, agent]),
    );
    expect(byAgent[one.agent.id]!.windows["30d"]).toMatchObject({
      requests: 1,
      total: 11,
      cost: 0.1,
    });
    expect(byAgent[bob.id]!.models).toMatchObject([
      { provider: "other", model: "m2", total: 44 },
    ]);
    // The busiest first; the models, all agents together, the same way.
    expect(sections(w).agents!.map((agent) => agent.agentId)).toEqual([
      bob.id,
      one.agent.id,
    ]);
    expect(
      sections(w).models!.map((model) => `${model.provider}:${model.model}`),
    ).toEqual(["other:m2", "acme:m1"]);
    expect(sections(w).days).toMatchObject([
      { requests: 2, total: 55, cost: 0.5 },
    ]);
  });

  it("are still counted after the agent's session was closed and opened again", async () => {
    const { models } = scriptedModels(() => billed(say("ok"), { input: 5 }));
    const w = await world({ models });
    const { agent, group } = await ada(w);
    const first = await w.send(group.id, "one");
    await w.settled(group.id, first.replies[0]!.id);
    // New instructions make the next wake close the session and open it again.
    await w.client.call("agents", "update", {
      agentId: agent.id,
      instructions: "Be brief.",
    });
    const second = await w.send(group.id, "two");
    await w.settled(group.id, second.replies[0]!.id);
    expect(rows(w).map((row) => [row.agent_id, row.input])).toEqual([
      [agent.id, 5],
      [agent.id, 5],
    ]);
  });

  it("count a provider's error, with its words, as a failed request", async () => {
    const { models } = scriptedModels(() => ({
      ...billed(say(""), { provider: "acme", model: "m1" }),
      stopReason: "error",
      errorMessage: "invalid api key",
    }));
    const w = await world({ models });
    const { agent, group } = await ada(w);
    w.client.subscribe("usage");
    const sent = await w.send(group.id, "hello");
    const failed = await w.settled(group.id, sent.replies[0]!.id);
    expect(failed.status).toBe("failed");

    expect(rows(w)).toMatchObject([
      { status: "error", error: "invalid api key", total: 0 },
    ]);
    await until(() => sections(w).agents?.length === 1);
    expect(sections(w).agents![0]).toMatchObject({ agentId: agent.id });
    expect(sections(w).agents![0]!.windows["5h"]).toMatchObject({
      requests: 1,
      failed: 1,
    });
  });

  it("count a generation that was stopped as a request, not as a failure", async () => {
    // What a provider reports when the run's signal fired mid-generation: the tokens already
    // spent are on the bill.
    const { models } = scriptedModels(() => ({
      ...billed(say("half an ans"), { input: 50, output: 3 }),
      stopReason: "aborted",
    }));
    const w = await world({ models });
    const { group } = await ada(w);
    w.client.subscribe("usage");
    const sent = await w.send(group.id, "think forever");
    await w.settled(group.id, sent.replies[0]!.id);
    expect(rows(w)).toMatchObject([
      { status: "aborted", error: null, input: 50, output: 3 },
    ]);
    await until(() => sections(w).agents?.length === 1);
    expect(sections(w).agents![0]!.windows["5h"]).toMatchObject({
      requests: 1,
      failed: 0,
      total: 53,
    });
  });
});

describe("generations made for no agent", () => {
  it("are counted under no agent and no conversation", async () => {
    const w = await world();
    w.client.subscribe("usage");
    const created = (await w.client.call("sessions", "create", {})) as {
      session: string;
    };
    await w.client.call("sessions", "prompt", {
      session: created.session,
      text: "hello",
    });
    await until(() => rows(w).length === 1);
    expect(rows(w)[0]).toMatchObject({
      session_id: created.session,
      agent_id: null,
      conversation_id: null,
      provider: "fake",
      model: "fake-model",
      status: "ok",
    });
    await until(() => sections(w).agents?.length === 1);
    expect(sections(w).agents![0]!.agentId).toBeNull();
  });
});

describe("retention", () => {
  const DAY = 24 * 3_600_000;

  it("drops what is older than thirty days when the host starts, and keeps the rest", async () => {
    const dataDir = await tempDir();
    const first = await world({ dataDir });
    const entry = (age: number) =>
      first.host.db
        .query(
          `INSERT INTO usage (at, session_id, provider, model, total, status)
           VALUES (?, 's', 'p', 'm', 1, 'ok')`,
        )
        .run(Date.now() - age);
    entry(31 * DAY);
    entry(29 * DAY);
    entry(0);
    const copy = await tempDir();
    first.host.db.exec(`VACUUM INTO '${copy}/eta.sqlite'`);

    const restarted = await world({ dataDir: copy });
    const kept = restarted.host.db
      .query<{ at: number }, []>("SELECT at FROM usage ORDER BY at")
      .all()
      .map((row) => Date.now() - row.at);
    expect(kept).toHaveLength(2);
    expect(kept[0]).toBeGreaterThan(28 * DAY);
    expect(kept[1]).toBeLessThan(DAY);
  });
});

describe("the sums", () => {
  const NOW = Date.UTC(2026, 9, 18, 12, 0, 0);
  const HOUR = 3_600_000;

  function open(clock: { now: number } = { now: NOW }) {
    const db = openDatabase(":memory:");
    applyMigrations(db, loadMigrations());
    return { db, store: new UsageStore(db, () => clock.now), clock };
  }

  const entry = (at: number, extra: Partial<UsageEntry> = {}): UsageEntry => ({
    at,
    sessionId: "s1",
    agentId: "a1",
    conversationId: "c1",
    provider: "p",
    model: "m",
    input: 10,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    total: 10,
    cost: 0.1,
    status: "ok",
    error: null,
    ...extra,
  });

  it("cut each window from now", () => {
    const { store } = open();
    store.record(entry(NOW - 1 * HOUR));
    store.record(entry(NOW - 6 * HOUR));
    store.record(entry(NOW - 25 * HOUR));
    store.record(entry(NOW - 8 * 24 * HOUR));
    store.record(entry(NOW - 31 * 24 * HOUR));
    const [agent] = store.agents();
    expect(
      USAGE_WINDOWS.map((window) => agent!.windows[window].requests),
    ).toEqual([1, 2, 3, 4]);
    expect(agent!.windows["30d"].cost).toBeCloseTo(0.4);
  });

  it("keep sessions with no agent together, and rank agents by their month", () => {
    const { store } = open();
    store.record(entry(NOW, { agentId: null, sessionId: "bare-1" }));
    store.record(entry(NOW, { agentId: null, sessionId: "bare-2", total: 5 }));
    store.record(entry(NOW, { agentId: "a1", total: 100 }));
    store.record(entry(NOW - 2 * 24 * HOUR, { agentId: "a2", total: 1000 }));
    expect(store.agents().map((agent) => agent.agentId)).toEqual([
      "a2",
      "a1",
      null,
    ]);
    // An agent with nothing lately still has its month, and zeros where it has none.
    const quiet = store.agents()[0]!;
    expect(quiet.windows["24h"]).toMatchObject({ requests: 0, total: 0 });
    expect(quiet.windows["7d"]).toMatchObject({ requests: 1, total: 1000 });
    expect(store.agents()[2]!.windows["5h"]).toMatchObject({
      requests: 2,
      total: 15,
    });
  });

  it("group days in UTC, oldest first, with none for a quiet day", () => {
    const { store } = open();
    store.record(entry(Date.UTC(2026, 9, 18, 23, 59, 59)));
    store.record(entry(Date.UTC(2026, 9, 17, 0, 0, 1)));
    store.record(entry(Date.UTC(2026, 9, 17, 23, 0, 0)));
    store.record(entry(Date.UTC(2026, 9, 12, 8, 0, 0)));
    expect(store.days().map((day) => [day.day, day.requests])).toEqual([
      ["2026-10-12", 1],
      ["2026-10-17", 2],
      ["2026-10-18", 1],
    ]);
  });

  it("round a sum of costs to the millionth", () => {
    const { store } = open();
    for (const cost of [0.1, 0.2]) store.record(entry(NOW, { cost }));
    expect(store.models()[0]!.cost).toBe(0.3);
  });

  it("prune what is past the retention, and do it again once a day as rows arrive", () => {
    const { db, store, clock } = open();
    store.record(entry(NOW - 29 * 24 * HOUR));
    store.record(entry(NOW - 31 * 24 * HOUR));
    // The first row's insert pruned nothing older than itself; the second arrived inside the day.
    expect(db.query("SELECT COUNT(*) AS n FROM usage").get()).toEqual({ n: 2 });
    expect(store.prune()).toBe(1);
    expect(db.query("SELECT COUNT(*) AS n FROM usage").get()).toEqual({ n: 1 });

    // Two days on, the next record sweeps by itself: both rows are past the month by then.
    store.record(entry(NOW - 29 * 24 * HOUR - 1));
    clock.now += 2 * 24 * HOUR;
    store.record(entry(clock.now));
    expect(db.query("SELECT COUNT(*) AS n FROM usage").get()).toEqual({ n: 1 });
  });

  it("count a failure as failed and a stop as neither", () => {
    const { store } = open();
    store.record(entry(NOW, { status: "error", error: "boom", total: 0 }));
    store.record(entry(NOW, { status: "aborted" }));
    store.record(entry(NOW));
    expect(store.models()[0]).toMatchObject({ requests: 3, failed: 1 });
  });
});
