import type { KernelTool } from "../src/kernel/tools";
import { Context } from "cordis";
import { describe, expect, it } from "vitest";
import { ToolService } from "../src/kernel/tools";

function withTools() {
  const ctx = new Context();
  const tools = new ToolService(ctx);
  return {
    tools,
    dispose: () => void ctx.fiber.dispose(),
  };
}

const echo: KernelTool<string, string> = {
  name: "echo",
  execute: (args) => `echo:${args}`,
};

describe("tool service", () => {
  it("registers, lists, and unregisters; unregister returns whether it removed something", () => {
    const { tools, dispose } = withTools();
    expect(tools.names()).toEqual([]);
    const off = tools.register(echo);
    expect(tools.names()).toEqual(["echo"]);
    expect(tools.get("echo")).toBe(echo);
    off();
    expect(tools.names()).toEqual([]);
    expect(tools.unregister("echo")).toBe(false);
    dispose();
  });

  it("a returned unregister closure does not clobber a re-registered tool", () => {
    const { tools, dispose } = withTools();
    const offA = tools.register(echo);
    const replacement: KernelTool = { name: "echo", execute: () => "v2" };
    tools.register(replacement);
    offA();
    expect(tools.get("echo")).toBe(replacement);
    dispose();
  });

  it("hot registration: a tool added mid-session runs on the very next execute()", async () => {
    const { tools, dispose } = withTools();
    const call = { turn: 1, toolCallId: "c1" };
    const before = await tools.execute("echo", "x", call);
    expect(before).toMatchObject({
      isError: true,
      content: "unknown tool: echo",
    });
    tools.register(echo);
    const after = await tools.execute("echo", "x", call);
    expect(after).toBe("echo:x");
    dispose();
  });

  it("middleware before can rewrite args; after can rewrite the result", async () => {
    const { tools, dispose } = withTools();
    tools.register(echo);
    const detach = tools.use({
      name: "rewrite",
      before: (_name, args) => ({ ok: true, args: `[${args}]` }),
      after: (_name, _args, result) => `<${result}>`,
    });
    const out = await tools.execute("echo", "x", { turn: 1, toolCallId: "c1" });
    expect(out).toBe("<echo:[x]>");
    detach();
    const plain = await tools.execute("echo", "x", {
      turn: 1,
      toolCallId: "c2",
    });
    expect(plain).toBe("echo:x");
    dispose();
  });

  it("middleware before can block a call and the tool never runs", async () => {
    const { tools, dispose } = withTools();
    let ran = false;
    tools.register({
      name: "danger",
      execute: () => {
        ran = true;
        return "ran";
      },
    });
    tools.use({
      name: "gate",
      before: () => ({ ok: false, blockReason: "not today" }),
    });
    const out = await tools.execute(
      "danger",
      {},
      { turn: 1, toolCallId: "c1" },
    );
    expect(out).toMatchObject({
      isError: true,
      content: "blocked by gate: not today",
    });
    expect(ran).toBe(false);
    dispose();
  });

  it("middleware after sees what a tool threw, as the result the model will read", async () => {
    const { tools } = withTools();
    tools.register({
      name: "boom",
      execute: () => {
        throw new Error("the secret is hunter2");
      },
    });
    tools.use({
      name: "scrub",
      after: (_name, _args, result) => ({
        ...(result as object),
        content: "scrubbed",
      }),
    });
    expect(
      await tools.execute("boom", {}, { turn: 1, toolCallId: "c1" }),
    ).toEqual({
      isError: true,
      content: "scrubbed",
    });
  });

  it("middleware ordering: before runs outer→inner, after runs inner→outer", async () => {
    const { tools, dispose } = withTools();
    const order: string[] = [];
    tools.register({ name: "t", execute: () => order.push("tool") });
    tools.use({
      name: "outer",
      before: () => {
        order.push("outer:before");
        return { ok: true, args: {} };
      },
      after: () => {
        order.push("outer:after");
      },
    });
    tools.use({
      name: "inner",
      before: () => {
        order.push("inner:before");
        return { ok: true, args: {} };
      },
      after: () => {
        order.push("inner:after");
      },
    });
    await tools.execute("t", {}, { turn: 1, toolCallId: "c1" });
    expect(order).toEqual([
      "outer:before",
      "inner:before",
      "tool",
      "inner:after",
      "outer:after",
    ]);
    dispose();
  });

  it("a batch ends on abort even when a tool's promise never settles", async () => {
    const { tools, dispose } = withTools();
    tools.register({
      name: "hang",
      execute: () => new Promise(() => undefined),
    });
    let drained = false;
    const controller = new AbortController();
    const batch = tools.executeBatch(
      [{ id: "c1", name: "hang", arguments: {} }],
      {
        execution: "sequential",
        turn: 1,
        signal: controller.signal,
        track: (work) => {
          void work.finally(() => {
            drained = true;
          });
          return work;
        },
      },
    );
    setTimeout(() => controller.abort(), 50);
    const settled = await Promise.race([
      batch,
      new Promise((resolve) => setTimeout(resolve, 1500, "still pending")),
    ]);
    expect(settled).toEqual([
      {
        id: "c1",
        result: {
          isError: true,
          content: "Tool execution was cancelled before completion.",
        },
      },
    ]);
    // What the run's abort drains is the same promise: it settles too.
    expect(drained).toBe(true);
    dispose();
  });

  it("the parallel path ends the same way", async () => {
    const { tools, dispose } = withTools();
    tools.register({
      name: "hang",
      execute: () => new Promise(() => undefined),
    });
    const controller = new AbortController();
    const batch = tools.executeBatch(
      [
        { id: "c1", name: "hang", arguments: {} },
        { id: "c2", name: "echo", arguments: "x" },
      ],
      { execution: "parallel", turn: 1, signal: controller.signal },
    );
    setTimeout(() => controller.abort(), 50);
    const settled = await Promise.race([
      batch,
      new Promise((resolve) => setTimeout(resolve, 1500, "still pending")),
    ]);
    expect(settled).not.toBe("still pending");
    expect((settled as { id: string }[])[0]).toEqual({
      id: "c1",
      result: {
        isError: true,
        content: "Tool execution was cancelled before completion.",
      },
    });
    dispose();
  });

  it("a cooperative tool supplies a synchronous partial result on abort in sequential and parallel batches", async () => {
    const { tools, dispose } = withTools();
    tools.register({
      name: "coop",
      execute: (_args, call) => {
        call.onAbortResult?.(() => ({
          isError: true,
          content: "partial from coop",
          details: { partial: true },
        }));
        return new Promise(() => undefined);
      },
    });
    tools.register({
      name: "hang",
      execute: () => new Promise(() => undefined),
    });

    const parallelController = new AbortController();
    const parallelBatch = tools.executeBatch(
      [
        { id: "c1", name: "coop", arguments: {} },
        { id: "c2", name: "hang", arguments: {} },
      ],
      {
        execution: "parallel",
        turn: 1,
        signal: parallelController.signal,
      },
    );
    setTimeout(() => parallelController.abort(), 30);
    const parallelResults = await parallelBatch;
    expect(parallelResults).toEqual([
      {
        id: "c1",
        result: {
          isError: true,
          content: "partial from coop",
          details: { partial: true },
        },
      },
      {
        id: "c2",
        result: {
          isError: true,
          content: "Tool execution was cancelled before completion.",
        },
      },
    ]);

    const seqController = new AbortController();
    const seqBatch = tools.executeBatch(
      [
        { id: "s1", name: "coop", arguments: {} },
        { id: "s2", name: "echo", arguments: "never" },
      ],
      {
        execution: "sequential",
        turn: 1,
        signal: seqController.signal,
      },
    );
    setTimeout(() => seqController.abort(), 30);
    const seqResults = await seqBatch;
    expect(seqResults).toEqual([
      {
        id: "s1",
        result: {
          isError: true,
          content: "partial from coop",
          details: { partial: true },
        },
      },
      {
        id: "s2",
        result: {
          isError: true,
          content: "Tool execution was cancelled before completion.",
        },
      },
    ]);
    dispose();
  });

  it("an onAbortResult callback that throws falls back to the default aborted result", async () => {
    const { tools, dispose } = withTools();
    tools.register({
      name: "broken-snap",
      execute: (_args, call) => {
        call.onAbortResult?.(() => {
          throw new Error("snapshot failed");
        });
        return new Promise(() => undefined);
      },
    });
    const controller = new AbortController();
    const batch = tools.executeBatch(
      [{ id: "c1", name: "broken-snap", arguments: {} }],
      { execution: "parallel", turn: 1, signal: controller.signal },
    );
    setTimeout(() => controller.abort(), 30);
    expect(await batch).toEqual([
      {
        id: "c1",
        result: {
          isError: true,
          content: "Tool execution was cancelled before completion.",
        },
      },
    ]);
    dispose();
  });

  it("a detached middleware stops participating", async () => {
    const { tools, dispose } = withTools();
    tools.register(echo);
    const detach = tools.use({ name: "spy", after: (_n, _a, r) => `${r}!` });
    expect(
      await tools.execute("echo", "x", { turn: 1, toolCallId: "c1" }),
    ).toBe("echo:x!");
    detach();
    expect(
      await tools.execute("echo", "x", { turn: 1, toolCallId: "c2" }),
    ).toBe("echo:x");
    dispose();
  });
});
