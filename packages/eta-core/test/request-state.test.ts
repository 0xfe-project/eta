/**
 * The request surface (REFACTOR.md §2.4, ported from eta-agent's
 * LaneRequestState + Config resolution chain).
 *
 * Two promises are being kept here. A request reads its configuration live, so
 * a model or thinking level changed mid-session reaches the next request and a
 * side request can ask what the run would send without capturing anything. And
 * the prompt/tool context/projection chain is resolvable rather than fixed, so
 * plugins own their text and their environment while the kernel stays empty of
 * both.
 */

import type { Entry } from "../src/index";
import { assistantMessage, fakeModels } from "@eta/core/testing";
import { describe, expect, it } from "vitest";
import { Kernel, MemoryStorage, Runner, SessionLog } from "../src/index";

const userMsg = (text: string) => ({
  role: "user" as const,
  content: [{ type: "text" as const, text }],
  timestamp: 0,
});

describe("requestState", () => {
  it("reports what a request would carry, read live", async () => {
    const kernel = Kernel.create({
      config: {
        model: { provider: "p", modelId: "m" },
        thinkingLevel: "low",
        activeToolNames: ["read"],
      },
    });
    const fake = fakeModels([]);
    fake.getModel = (provider, id) => ({ provider, id }) as never;
    kernel.tools.register({
      name: "read",
      description: "read a file",
      execute: () => "ok",
    });
    const runner = new Runner(kernel, {
      models: fake,
      systemPrompt: "you are eta",
    });

    const before = await runner.requestState();
    expect(before.model?.id).toBe("m");
    expect(before.thinkingLevel).toBe("low");
    expect(before.tools.map((tool) => tool.name)).toEqual(["read"]);
    expect(before.missingToolNames).toEqual([]);
    expect(before.systemPrompt).toBe("you are eta");
    expect(before.retryPolicy).toEqual(kernel.config.read("retryPolicy"));

    // The user changes their mind: the snapshot follows, it does not cache.
    kernel.config.update({
      thinkingLevel: "high",
      model: { provider: "p", modelId: "other" },
    });
    kernel.tools.register({ name: "bash", execute: () => "ok" });
    kernel.config.update({ activeToolNames: ["bash", "ghost"] });
    const after = await runner.requestState();
    expect(after.model?.id).toBe("other");
    expect(after.thinkingLevel).toBe("high");
    expect(after.tools.map((tool) => tool.name)).toEqual(["bash"]);
    expect(after.missingToolNames).toEqual(["ghost"]);
    void kernel.dispose();
  });

  it("offers everything registered when no selection is configured", async () => {
    const kernel = Kernel.create({
      config: { model: { provider: "p", modelId: "m" } },
    });
    const fake = fakeModels([]);
    kernel.tools.register({ name: "a", execute: () => "a" });
    kernel.tools.register({ name: "b", execute: () => "b" });
    const runner = new Runner(kernel, { models: fake });
    const state = await runner.requestState();
    expect(state.tools.map((tool) => tool.name).sort()).toEqual(["a", "b"]);
    expect(state.missingToolNames).toEqual([]);
    void kernel.dispose();
  });

  it("a side request sees the model changed while a run is in flight", async () => {
    const kernel = Kernel.create({
      config: { model: { provider: "p", modelId: "first" } },
    });
    const seen: (string | undefined)[] = [];
    const fake = fakeModels([
      assistantMessage({
        stopReason: "toolUse",
        content: [{ type: "toolCall", id: "c1", name: "peek", arguments: {} }],
      }),
      assistantMessage({ content: [{ type: "text", text: "done" }] }),
    ]);
    // A model per id, so the two reads can tell the models apart.
    fake.getModel = (provider, id) => ({ provider, id }) as never;
    const runner = new Runner(kernel, { models: fake });
    kernel.tools.register({
      name: "peek",
      execute: async () => {
        // Mid-run: ask what the next request would carry, then change the model.
        seen.push(
          (await runner.requestState()).model?.id as string | undefined,
        );
        kernel.config.update({ model: { provider: "p", modelId: "second" } });
        seen.push(
          (await runner.requestState()).model?.id as string | undefined,
        );
        return "peeked";
      },
    });
    kernel.inject(userMsg("go"));
    await runner.run();
    expect(seen).toEqual(["first", "second"]);
    void kernel.dispose();
  });
});

describe("the resolution chain", () => {
  it("systemPrompt is a string or a resolver over the tool context", async () => {
    const kernel = Kernel.create({
      config: { model: { provider: "p", modelId: "m" } },
    });
    const fake = fakeModels([assistantMessage(), assistantMessage()]);

    const asString = new Runner(kernel, {
      models: fake,
      systemPrompt: "static prompt",
    });
    expect((await asString.requestState()).systemPrompt).toBe("static prompt");

    const asResolver = new Runner(kernel, {
      models: fake,
      toolContext: { workspace: "/w" },
      systemPrompt: (toolContext) =>
        `workspace ${(toolContext as { workspace: string }).workspace}`,
    });
    expect((await asResolver.requestState()).systemPrompt).toBe("workspace /w");
    void kernel.dispose();
  });

  it("toolContext is a value or a resolver, and reaches the tools", async () => {
    const kernel = Kernel.create({
      config: { model: { provider: "p", modelId: "m" } },
    });
    const fake = fakeModels([
      assistantMessage({
        stopReason: "toolUse",
        content: [{ type: "toolCall", id: "c1", name: "where", arguments: {} }],
      }),
      assistantMessage({ content: [{ type: "text", text: "done" }] }),
    ]);
    let resolved = 0;
    const runner = new Runner(kernel, {
      models: fake,
      toolContext: () => {
        resolved += 1;
        return { cwd: "/workspace" };
      },
    });
    let seen: unknown;
    kernel.tools.register({
      name: "where",
      execute: (_args, call) => {
        seen = call.toolContext;
        return "here";
      },
    });
    kernel.inject(userMsg("go"));
    await runner.run();
    expect(seen).toEqual({ cwd: "/workspace" });
    expect(resolved).toBeGreaterThan(0);
    void kernel.dispose();
  });

  it("entryProjectors teach the transcript about plugin entry kinds", async () => {
    const storage = new MemoryStorage();
    // A plugin-added entry kind, written straight to the journal.
    await storage.commit([
      {
        kind: "entry",
        entry: {
          id: "note-1",
          parentId: null,
          type: "note",
          text: "remember this",
        } as unknown as Entry,
      },
      {
        kind: "entry",
        entry: {
          id: "m1",
          parentId: "note-1",
          type: "message",
          message: userMsg("hello"),
        },
      },
    ]);
    const log = await SessionLog.load(storage);

    // Without a projector the unknown kind is simply not part of the transcript.
    expect(log.transcript().map((message) => message.role)).toEqual(["user"]);

    const projected = log.transcript({
      note: (entry) => ({
        role: "user",
        content: [
          { type: "text", text: (entry as unknown as { text: string }).text },
        ],
        timestamp: 0,
      }),
    });
    expect(projected.map((message) => message.role)).toEqual(["user", "user"]);
    expect(JSON.stringify(projected)).toContain("remember this");
  });

  it("a missing projection for a summary still fails loudly", async () => {
    const kernel = Kernel.create({
      config: { model: { provider: "p", modelId: "m" } },
    });
    const fake = fakeModels([]);
    const runner = new Runner(kernel, { models: fake });
    runner.replaceContext("summary", { tokensBefore: 0 });
    kernel.inject(userMsg("go"));
    await expect(runner.run()).rejects.toThrow(
      "toProviderMessages is required",
    );
    void kernel.dispose();
  });
});

describe("configured tools", () => {
  it("fails the run when a selected tool has no implementation", async () => {
    const kernel = Kernel.create({
      config: {
        model: { provider: "p", modelId: "m" },
        activeToolNames: ["read", "ghost"],
      },
    });
    const fake = fakeModels([assistantMessage()]);
    kernel.tools.register({ name: "read", execute: () => "ok" });
    const runner = new Runner(kernel, { models: fake });
    kernel.inject(userMsg("go"));
    const result = await runner.run();
    expect(result.status).toBe("failed");
    expect(result.error).toBe("configured_tools_unavailable: ghost");
    // Nothing was asked of the model: the toolset itself was wrong.
    expect(fake.calls).toHaveLength(0);
    void kernel.dispose();
  });

  it("offers only the selected tools to the provider", async () => {
    const kernel = Kernel.create({
      config: {
        model: { provider: "p", modelId: "m" },
        activeToolNames: ["read"],
      },
    });
    const fake = fakeModels([assistantMessage()]);
    kernel.tools.register({ name: "read", execute: () => "ok" });
    kernel.tools.register({ name: "bash", execute: () => "ok" });
    const runner = new Runner(kernel, { models: fake });
    kernel.inject(userMsg("go"));
    await runner.run();
    expect(fake.calls[0]!.context.tools?.map((tool) => tool.name)).toEqual([
      "read",
    ]);
    void kernel.dispose();
  });
});
