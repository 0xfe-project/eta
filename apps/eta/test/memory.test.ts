/**
 * Memory, against a fake sidecar: what is recalled reaches the run, a finished turn is handed over
 * after it, the agent's tools call the sidecar as the agent, and a sidecar that is broken or absent
 * never changes a reply.
 */
import type { MemoryView } from "@eta/client-contracts";
import type { World } from "./support/world";
import { MEMORY_ACTIONS } from "@eta/client-contracts";
import { afterEach, describe, expect, it } from "vitest";
import { until } from "./support/client";
import { call, HANG, say, scriptedModels } from "./support/models";
import { world } from "./support/world";

interface Seen {
  method: string;
  path: string;
  agent: string | null;
  group: string | null;
  body: any;
}

type Handler = (seen: Seen) => Response | undefined;

const closers: (() => void)[] = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
});

/** A sidecar that records what it is asked and answers like the real one, unless told otherwise. */
function sidecar() {
  const seen: Seen[] = [];
  const state: {
    recalled: unknown[];
    override?: Handler | undefined;
  } = { recalled: [] };
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url);
      const text = await request.text();
      const entry: Seen = {
        method: request.method,
        path: `${url.pathname}${url.search}`,
        agent: request.headers.get("x-axp-agent-id"),
        group: request.headers.get("x-axp-group-id"),
        body: text === "" ? undefined : JSON.parse(text),
      };
      seen.push(entry);
      const overridden = state.override?.(entry);
      if (overridden !== undefined) return overridden;
      if (url.pathname === "/memory/recall")
        return Response.json({ memories: state.recalled });
      if (url.pathname === "/memory/capture")
        return new Response(null, { status: 202 });
      if (url.pathname === "/memory/mcp") {
        const { name, arguments: args } = entry.body.params;
        const reply = (result: unknown) =>
          Response.json({ jsonrpc: "2.0", id: 1, result });
        if (name === "remember")
          return reply({
            content: [
              {
                type: "text",
                text: JSON.stringify({ id: "m9", text: args.text }),
              },
            ],
          });
        if (name === "recall")
          return reply({
            content: [{ type: "text", text: "[]" }],
            structuredContent: {
              result: [
                { id: "m1", text: "tea, no sugar" },
                { id: "m2", text: "likes Go", group_context: "other" },
              ],
            },
          });
        if (args.memory_id === "gone")
          return reply({
            isError: true,
            content: [{ type: "text", text: "no such memory" }],
          });
        return reply({
          content: [
            {
              type: "text",
              text: JSON.stringify({ forgotten: args.memory_id }),
            },
          ],
        });
      }
      if (url.pathname.endsWith("/memories") && request.method === "GET")
        return Response.json({
          memories: [
            {
              id: "m1",
              text: "tea",
              score: 0.8,
              created_at: "2026-10-08T00:00:01+00:00",
              source: "agent",
              source_group_id: "c1",
            },
            { id: "m2", text: "old" },
          ],
        });
      if (url.pathname.endsWith("/memories") && request.method === "POST")
        return Response.json(
          { id: "m3", text: entry.body.text, source: "user" },
          { status: 201 },
        );
      if (request.method === "DELETE")
        return url.pathname.endsWith("/gone")
          ? Response.json({ error: { code: "NOT_FOUND" } }, { status: 404 })
          : new Response(null, { status: 204 });
      return new Response("?", { status: 404 });
    },
  });
  closers.push(() => server.stop(true));
  return {
    seen,
    state,
    url: `http://127.0.0.1:${server.port}`,
    to: (path: string) => seen.filter((entry) => entry.path.startsWith(path)),
  };
}

async function ada(w: World) {
  const agent = await w.agent("Ada");
  const project = await w.project({ stewardId: agent.id });
  const group = await w.group(project.id, [agent.id]);
  await w.watch(group.id);
  return { agent, project, group };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 100));

describe("without a sidecar", () => {
  it("has no memory target, no tools, and nothing to call", async () => {
    const { models, requests } = scriptedModels(() => say("hi"));
    const w = await world({ models });
    const hello = await w.client.hello();
    expect(hello.mounted.map((plugin) => plugin.name)).not.toContain("memory");
    expect(
      hello.ops.map((op) => op.name).filter((n) => n.startsWith("memory.")),
    ).toEqual([]);
    const { group } = await ada(w);
    const sent = await w.send(group.id, "hello");
    await w.settled(group.id, sent.replies[0]!.id);
    expect(requests[0]!.tools).not.toContain("remember");
    expect(requests[0]!.tools).not.toContain("recall");
    expect(requests[0]!.tools).not.toContain("forget");
    await expect(
      w.client.call("memory", "list", { agentId: "x" }),
    ).rejects.toThrow();
  });

  it("treats an empty address as none", async () => {
    const w = await world({ memoryUrl: "" });
    expect(
      (await w.client.hello()).mounted.map((plugin) => plugin.name),
    ).not.toContain("memory");
  });
});

describe("with a sidecar", () => {
  it("is on the pipe with its actions", async () => {
    const fake = sidecar();
    const w = await world({ memoryUrl: fake.url });
    const hello = await w.client.hello();
    expect(hello.mounted.map((plugin) => plugin.name)).toContain("memory");
    expect(hello.ops.map((op) => op.name)).toEqual(
      expect.arrayContaining(
        MEMORY_ACTIONS.map((action) => `memory.${action}`),
      ),
    );
  });

  it("puts what it recalls ahead of what the agent is told, asking as that agent in that conversation", async () => {
    const fake = sidecar();
    fake.state.recalled = [
      { id: "m1", text: "Ada takes tea without sugar", group_context: "this" },
      { id: "m2", text: "Ada likes Go", group_context: "other" },
    ];
    const { models, requests } = scriptedModels(() => say("noted"));
    const w = await world({ models, memoryUrl: fake.url });
    const { agent, group } = await ada(w);
    const sent = await w.send(group.id, "what do I drink?");
    await w.settled(group.id, sent.replies[0]!.id);

    const [recall] = fake.to("/memory/recall");
    expect(recall).toMatchObject({
      method: "POST",
      agent: agent.id,
      group: group.id,
    });
    expect(recall!.body.query).toContain("what do I drink?");
    const told = requests[0]!.last;
    expect(told).toContain("Ada takes tea without sugar");
    expect(told).toContain("Ada likes Go (from another conversation)");
    // Ahead of the briefing, which still ends with the user's words.
    expect(told.indexOf("tea without sugar")).toBeLessThan(
      told.indexOf("what do I drink?"),
    );
  });

  it("says nothing extra when nothing is remembered", async () => {
    const fake = sidecar();
    const { models, requests } = scriptedModels(() => say("ok"));
    const w = await world({ models, memoryUrl: fake.url });
    const { group } = await ada(w);
    const sent = await w.send(group.id, "hello");
    await w.settled(group.id, sent.replies[0]!.id);
    expect(requests[0]!.last).not.toContain("remember");
    expect(requests[0]!.last.startsWith("[conversation:")).toBe(true);
  });

  it("hands over the finished turn after the reply is done", async () => {
    const fake = sidecar();
    const { models } = scriptedModels(() => say("Tea it is."));
    const w = await world({ models, memoryUrl: fake.url });
    const { agent, group } = await ada(w);
    const sent = await w.send(group.id, "I like tea");
    await w.settled(group.id, sent.replies[0]!.id);
    await until(() => fake.to("/memory/capture").length === 1);
    expect(fake.to("/memory/capture")[0]).toMatchObject({
      method: "POST",
      agent: agent.id,
      group: group.id,
      body: {
        messages: [
          { role: "user", content: "I like tea" },
          { role: "assistant", content: "Tea it is." },
        ],
      },
    });
  });

  it("hands over nothing when the reply failed or was stopped", async () => {
    const fake = sidecar();
    let calls = 0;
    const { models } = scriptedModels(() => {
      calls += 1;
      return calls === 1
        ? {
            ...say("partial"),
            stopReason: "error",
            errorMessage: "invalid api key",
          }
        : HANG;
    });
    const w = await world({ models, memoryUrl: fake.url });
    const { group } = await ada(w);
    const failed = await w.send(group.id, "one");
    expect((await w.settled(group.id, failed.replies[0]!.id)).status).toBe(
      "failed",
    );
    const stopped = await w.send(group.id, "two");
    await w.settled(group.id, stopped.replies[0]!.id, ["working"]);
    await until(() => calls === 2);
    await w.client.call("conversations", "stop", { conversationId: group.id });
    expect((await w.settled(group.id, stopped.replies[0]!.id)).status).toBe(
      "stopped",
    );
    await settle();
    expect(fake.to("/memory/capture")).toEqual([]);
    // The questions were still put to it before each run.
    expect(fake.to("/memory/recall")).toHaveLength(2);
  });

  it("never changes a reply when the sidecar fails", async () => {
    const fake = sidecar();
    fake.state.override = () => new Response("boom", { status: 500 });
    const { models, requests } = scriptedModels(() => say("fine"));
    const warned: string[] = [];
    const w = await world({
      models,
      memoryUrl: fake.url,
      warn: (message) => warned.push(message),
    });
    const { group } = await ada(w);
    const sent = await w.send(group.id, "hello");
    const done = await w.settled(group.id, sent.replies[0]!.id);
    expect(done).toMatchObject({ status: "done", text: "fine" });
    expect(requests[0]!.last).toContain("hello");
    await until(() => warned.some((line) => line.includes("afterRun")));
    expect(warned.some((line) => line.includes("beforeRun"))).toBe(true);
  });

  it("never changes a reply when the sidecar is not there", async () => {
    const fake = sidecar();
    const dead = fake.url;
    closers.pop()!();
    const { models } = scriptedModels(() => say("fine"));
    const w = await world({
      models,
      memoryUrl: dead,
      warn: () => undefined,
    });
    const { group } = await ada(w);
    const sent = await w.send(group.id, "hello");
    expect(await w.settled(group.id, sent.replies[0]!.id)).toMatchObject({
      status: "done",
      text: "fine",
    });
  });
});

describe("the agent's tools", () => {
  it("call the sidecar as the agent, in the conversation, and report back", async () => {
    const fake = sidecar();
    const { models, requests } = scriptedModels((request) => {
      if (request.lastRole === "toolResult")
        return say(`result: ${request.last}`);
      const step = requests.filter((r) => r.lastRole !== "toolResult").length;
      return step <= 1
        ? call("remember", { text: "Ada likes tea" })
        : call("forget", { memoryId: "m1" });
    });
    const w = await world({ models, memoryUrl: fake.url });
    const { agent, group } = await ada(w);
    const sent = await w.send(group.id, "remember my tea");
    const done = await w.settled(group.id, sent.replies[0]!.id);
    expect(requests[0]!.tools).toEqual(
      expect.arrayContaining(["remember", "recall", "forget"]),
    );
    expect(done.text).toContain("Remembered [m9]: Ada likes tea");
    const [tool] = fake.to("/memory/mcp");
    expect(tool).toMatchObject({
      method: "POST",
      agent: agent.id,
      group: group.id,
      body: {
        method: "tools/call",
        params: { name: "remember", arguments: { text: "Ada likes tea" } },
      },
    });
  });

  it("recall lists what the sidecar found, and forget names the id", async () => {
    const fake = sidecar();
    const { models } = scriptedModels((request) => {
      if (request.lastRole === "toolResult") return say(request.last);
      return request.last.includes("forget")
        ? call("forget", { memoryId: "m1" })
        : call("recall", { query: "tea" });
    });
    const w = await world({ models, memoryUrl: fake.url });
    const { group } = await ada(w);
    const one = await w.send(group.id, "recall tea");
    const recalled = await w.settled(group.id, one.replies[0]!.id);
    expect(recalled.text).toContain("- [m1] tea, no sugar");
    expect(recalled.text).toContain(
      "- [m2] likes Go (from another conversation)",
    );
    const two = await w.send(group.id, "forget it");
    expect((await w.settled(group.id, two.replies[0]!.id)).text).toContain(
      "Forgot m1.",
    );
    expect(fake.to("/memory/mcp")[1]!.body.params).toEqual({
      name: "forget",
      arguments: { memory_id: "m1" },
    });
  });

  it("tell the model when the sidecar refuses", async () => {
    const fake = sidecar();
    const { models } = scriptedModels((request) =>
      request.lastRole === "toolResult"
        ? say(request.last)
        : call("forget", { memoryId: "gone" }),
    );
    const w = await world({ models, memoryUrl: fake.url });
    const { group } = await ada(w);
    const sent = await w.send(group.id, "forget gone");
    const done = await w.settled(group.id, sent.replies[0]!.id);
    expect(done.status).toBe("done");
    expect(done.text).toContain("no such memory");
  });
});

describe("the memory target", () => {
  it("lists with the filters the sidecar takes, in the host's vocabulary", async () => {
    const fake = sidecar();
    const w = await world({ memoryUrl: fake.url });
    const result = (await w.client.call("memory", "list", {
      agentId: "a 1",
      query: " tea ",
      source: "agent",
      conversationId: "c1",
    })) as { memories: MemoryView[] };
    expect(fake.seen.at(-1)!.path).toBe(
      "/api/memory/v1/agents/a%201/memories?q=tea&source=agent&group_id=c1",
    );
    expect(result.memories).toEqual([
      {
        id: "m1",
        text: "tea",
        score: 0.8,
        createdAt: Date.parse("2026-10-08T00:00:01+00:00"),
        source: "agent",
        conversationId: "c1",
        deletedAt: null,
        deletedBy: null,
      },
      {
        id: "m2",
        text: "old",
        score: null,
        createdAt: null,
        source: null,
        conversationId: null,
        deletedAt: null,
        deletedBy: null,
      },
    ]);
    await w.client.call("memory", "list", { agentId: "a1" });
    expect(fake.seen.at(-1)!.path).toBe("/api/memory/v1/agents/a1/memories");
    await expect(
      w.client.call("memory", "list", { agentId: "a1", source: "dream" }),
    ).rejects.toThrow(/source must be/);
    await expect(w.client.call("memory", "list", {})).rejects.toThrow(
      /needs agentId/,
    );
  });

  it("remembers by hand, and forgets", async () => {
    const fake = sidecar();
    const w = await world({ memoryUrl: fake.url });
    const added = (await w.client.call("memory", "remember", {
      agentId: "a1",
      text: " likes tea ",
    })) as { memory: MemoryView };
    expect(added.memory).toMatchObject({
      id: "m3",
      text: "likes tea",
      source: "user",
    });
    expect(
      await w.client.call("memory", "forget", { agentId: "a1", id: "m1" }),
    ).toEqual({
      id: "m1",
    });
    expect(fake.seen.at(-1)).toMatchObject({
      method: "DELETE",
      path: "/api/memory/v1/agents/a1/memories/m1",
    });
    await expect(
      w.client.call("memory", "forget", { agentId: "a1", id: "gone" }),
    ).rejects.toThrow(/404/);
  });
});
