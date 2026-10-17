import type { Host } from "../src/host";
/**
 * What a session is made of (FRONTEND_REFACTOR.md §6, P7).
 *
 * Three reads the right panel is built on: the system prompt with its stable/adaptive split, the
 * tools the session can actually call, and what the conversation has spent so far. They are reads
 * of live services, so a test asserts numbers *after* a run, and a session that is not open gets
 * a 404 — "no numbers yet" is not "used nothing".
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assistantMessage, fakeModels } from "@eta/core/testing";
import { afterEach, describe, expect, it } from "vitest";
import { assembleHost } from "../src/host";

const roots: string[] = [];
const hosts: Host[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

async function scratch(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "eta-inspect-"));
  roots.push(root);
  return root;
}

const answer = (text: string) =>
  assistantMessage({
    content: [{ type: "text", text }],
    usage: {
      input: 120,
      output: 30,
      cacheRead: 40,
      cacheWrite: 10,
      totalTokens: 200,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  });

async function start(dataDir: string): Promise<Host> {
  const host = await assembleHost({
    dataDir,
    port: 0,
    warn: () => undefined,
    models: fakeModels([answer("first"), answer("second")]),
  });
  hosts.push(host);
  return host;
}

const url = (host: Host, path: string): string =>
  `http://127.0.0.1:${host.port}${path}`;

const post = (host: Host, path: string, body: unknown) =>
  fetch(url(host, path), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

async function openSession(host: Host): Promise<string> {
  const created = await post(host, "/sessions", {});
  expect(created.status).toBe(201);
  const { meta } = (await created.json()) as { meta: { id: string } };
  const said = await post(host, `/sessions/${meta.id}/prompt`, {
    text: "say something",
  });
  expect(said.status).toBe(200);
  return meta.id;
}

describe("a session, described to a panel", () => {
  it("splits its prompt into what can be cached and what is rewritten", async () => {
    const host = await start(await scratch());
    const id = await openSession(host);
    const prompt = (await (
      await fetch(url(host, `/sessions/${id}/prompt`))
    ).json()) as {
      sections: { name: string; stable: boolean; chars: number }[];
      stable_chars: number;
      adaptive_chars: number;
      blocks: number;
    };
    // Named blocks, each with its size: the panel shows the names and the numbers, not the text.
    expect(prompt.blocks).toBe(prompt.sections.length);
    expect(prompt.sections.every((section) => section.chars > 0)).toBe(true);
    expect(prompt.sections.some((section) => section.stable)).toBe(true);
    expect(prompt.stable_chars).toBeGreaterThan(0);
    expect(prompt.adaptive_chars).toBeGreaterThanOrEqual(0);
  });

  it("lists the tools it can call, and which of them the model is offered", async () => {
    const host = await start(await scratch());
    const id = await openSession(host);
    const tools = (await (
      await fetch(url(host, `/sessions/${id}/tools`))
    ).json()) as {
      tools: string[];
      active: string[];
      blocked: string[];
      asked: number;
      refused: number;
    };
    expect(tools.tools.length).toBeGreaterThan(0);
    // What the session pinned is what the model sees; anything else is registered but unreachable,
    // and the panel says which is which instead of showing one list that means neither.
    expect(tools.active.length).toBeGreaterThan(0);
    expect([...tools.active, ...tools.blocked].sort()).toEqual(
      [...tools.tools].sort(),
    );
    // Nothing was asked and nothing was refused in this conversation: zeros, and they mean "none",
    // not "not measured".
    expect(tools.asked).toBe(0);
    expect(tools.refused).toBe(0);
  });

  it("adds up what the conversation spent, from its own messages", async () => {
    const host = await start(await scratch());
    const id = await openSession(host);
    const usage = (await (
      await fetch(url(host, `/sessions/${id}/usage`))
    ).json()) as {
      input: number;
      output: number;
      cache_read: number;
      cache_write: number;
      turns: number;
      compactions: number;
      model: string | null;
    };
    expect(usage.input).toBe(120);
    expect(usage.output).toBe(30);
    expect(usage.cache_read).toBe(40);
    expect(usage.cache_write).toBe(10);
    expect(usage.turns).toBe(1);
    expect(usage.compactions).toBe(0);
    expect(usage.model).toContain(":");
  });

  it("says a session is not open rather than reporting zeros", async () => {
    const host = await start(await scratch());
    for (const path of ["prompt", "tools", "usage"]) {
      const response = await fetch(url(host, `/sessions/nope/${path}`));
      expect(response.status).toBe(404);
      expect(
        ((await response.json()) as { error: { code: string } }).error.code,
      ).toBe("NO_SUCH_SESSION");
    }
  });
});
