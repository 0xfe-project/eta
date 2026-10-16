import type { Host } from "../src/host";
import { Database } from "bun:sqlite";
/**
 * Usage accounting (REFACTOR.md §9, P1.3).
 *
 * Two claims, and they are different claims. The first is that a generation that happened is
 * counted once, under the session that asked for it, with the provider, the model and the tokens
 * it reported — including the one that failed, which the journal cannot express because a failed
 * generation never produced a row there. The second is that the windows and the retention are the
 * ones we said: 5 hours, 24 hours, 7 days, kept for 30.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assistantMessage, fakeModels } from "@eta/core/testing";
import { afterEach, describe, expect, it } from "vitest";
import { applyMigrations, loadMigrations } from "../src/db/migrations";
import { assembleHost } from "../src/host";
import { subjectOf } from "../src/usage/recorder";
import { UsageStore } from "../src/usage/store";
import { breakingModels } from "./support/hanging";

const roots: string[] = [];
const hosts: Host[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

async function scratch(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "eta-usage-"));
  roots.push(root);
  return root;
}

const USAGE = {
  input: 100,
  output: 40,
  cacheRead: 10,
  cacheWrite: 0,
  reasoning: 5,
  totalTokens: 150,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

interface Subject {
  subject: string;
  windows: {
    hours: number;
    requests: number;
    failed: number;
    total: number;
    input: number;
  }[];
  models: { provider: string; model: string; total: number }[];
}

describe("counting a generation", () => {
  it("counts a real turn under the session that asked, with its model and tokens", async () => {
    const host = await assembleHost({
      dataDir: await scratch(),
      port: 0,
      warn: () => undefined,
      models: fakeModels([
        assistantMessage({
          content: [{ type: "text", text: "hi" }],
          usage: USAGE,
        }),
      ]),
    });
    hosts.push(host);

    const created = (await (
      await fetch(`http://127.0.0.1:${host.port}/sessions`, {
        method: "POST",
        body: "{}",
      })
    ).json()) as { meta: { id: string } };
    const id = created.meta.id;
    await fetch(`http://127.0.0.1:${host.port}/sessions/${id}/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hello" }),
    });

    const body = (await (
      await fetch(`http://127.0.0.1:${host.port}/usage/agents`)
    ).json()) as {
      agents: Subject[];
    };
    expect(body.agents).toHaveLength(1);
    const [subject] = body.agents;
    expect(subject?.subject).toBe(`session:${id}`);
    const fiveHours = subject?.windows.find((window) => window.hours === 5);
    expect(fiveHours).toMatchObject({
      requests: 1,
      failed: 0,
      total: 150,
      input: 100,
    });
    // And it knows which model it was.
    expect(subject?.models[0]).toMatchObject({
      provider: "fake",
      model: "fake-model",
      total: 150,
      requests: 1,
    });
  });

  it("counts a generation that failed, which the journal has no row for", async () => {
    const host = await assembleHost({
      dataDir: await scratch(),
      port: 0,
      warn: () => undefined,
      // One scripted answer, so the second prompt finds the script exhausted — a provider that
      // refused, in the shape a test can produce.
      models: fakeModels([
        assistantMessage({
          content: [{ type: "text", text: "once" }],
          usage: USAGE,
        }),
      ]),
    });
    hosts.push(host);

    const created = (await (
      await fetch(`http://127.0.0.1:${host.port}/sessions`, {
        method: "POST",
        body: "{}",
      })
    ).json()) as { meta: { id: string } };
    const id = created.meta.id;
    const prompt = (): Promise<Response> =>
      fetch(`http://127.0.0.1:${host.port}/sessions/${id}/prompt`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "again" }),
      });

    expect((await prompt()).status).toBe(200);
    expect((await prompt()).status).toBeGreaterThanOrEqual(400);

    const body = (await (
      await fetch(`http://127.0.0.1:${host.port}/usage/agents`)
    ).json()) as {
      agents: Subject[];
    };
    const fiveHours = body.agents[0]?.windows.find(
      (window) => window.hours === 5,
    );
    expect(fiveHours).toMatchObject({ requests: 2, failed: 1 });
  });
});

describe("a provider that breaks mid-stream", () => {
  /**
   * The trap this pins down: the usage proxy sits between the kernel and the provider, and pi-ai's
   * `end(undefined)` never settles its `result()`. A proxy that answers a mid-stream throw by
   * ending the stream therefore leaves the kernel waiting forever — a run that never ends, no
   * failure and no answer. Handing the failure on as an error event is what ends it.
   */
  it("ends the run as a failure and counts it, instead of hanging", async () => {
    const breaking = breakingModels("connection reset");
    const host = await assembleHost({
      dataDir: await scratch(),
      port: 0,
      warn: () => undefined,
      models: breaking.models,
    });
    hosts.push(host);

    const created = (await (
      await fetch(`http://127.0.0.1:${host.port}/sessions`, {
        method: "POST",
        body: "{}",
      })
    ).json()) as { meta: { id: string } };
    const response = await fetch(
      `http://127.0.0.1:${host.port}/sessions/${created.meta.id}/prompt`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "hello" }),
      },
    );
    // Answered, not hung: a failure the caller can see.
    expect(response.status).toBeGreaterThanOrEqual(400);

    const body = (await (
      await fetch(`http://127.0.0.1:${host.port}/usage/agents`)
    ).json()) as { agents: Subject[] };
    const fiveHours = body.agents[0]?.windows.find(
      (window) => window.hours === 5,
    );
    expect(fiveHours).toMatchObject({ requests: 1, failed: 1 });
  });
});

describe("the subject a session counts under", () => {
  it("is the agent when the meta names one, and the session until then", () => {
    expect(subjectOf({ id: "s1" })).toBe("session:s1");
    // P2.2 puts the agent in the meta; this is the field it will be read from.
    expect(subjectOf({ id: "s1", agentId: "a1" })).toBe("a1");
    expect(subjectOf({ id: "s1", agentId: "" })).toBe("session:s1");
  });
});

describe("the windows and the retention", () => {
  const hoursAgo = (hours: number): Date =>
    new Date(Date.now() - hours * 60 * 60 * 1000);

  async function storeWithRows(): Promise<UsageStore> {
    const db = new Database(":memory:");
    applyMigrations(db, await loadMigrations());
    const store = new UsageStore(db);
    const usage = { ...USAGE, cost: USAGE.cost };
    store.record({
      subject: "a",
      provider: "p",
      model: "m",
      usage,
      at: hoursAgo(2),
    });
    store.record({
      subject: "a",
      provider: "p",
      model: "m",
      usage,
      at: hoursAgo(100),
    });
    store.record({
      subject: "a",
      provider: "p",
      model: "m",
      usage,
      at: hoursAgo(400),
    });
    return store;
  }

  it("cut 5 hours, 24 hours and 7 days, and report what each holds", async () => {
    const store = await storeWithRows();
    const [subject] = store.bySubject();
    const window = (hours: number): number | undefined =>
      subject?.windows.find((entry) => entry.hours === hours)?.requests;
    expect(window(5)).toBe(1);
    expect(window(24)).toBe(1);
    expect(window(168)).toBe(2);
    // The per-model split covers the same week.
    expect(subject?.models[0]).toMatchObject({
      provider: "p",
      model: "m",
      requests: 2,
    });
  });

  it("drops what is older than 30 days, and keeps the rest", async () => {
    const db = new Database(":memory:");
    applyMigrations(db, await loadMigrations());
    const store = new UsageStore(db);
    const usage = { ...USAGE, cost: USAGE.cost };
    store.record({
      subject: "a",
      provider: "p",
      model: "m",
      usage,
      at: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000),
    });
    store.record({
      subject: "a",
      provider: "p",
      model: "m",
      usage,
      at: new Date(Date.now() - 29 * 24 * 60 * 60 * 1000),
    });

    expect(store.prune()).toBe(1);
    const rows = db.query("SELECT COUNT(*) AS n FROM usage_hourly").get() as {
      n: number;
    };
    expect(rows.n).toBe(1);
  });
});
