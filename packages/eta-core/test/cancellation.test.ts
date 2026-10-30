/**
 * Who decides that a run was cancelled (issue #64).
 *
 * The run's own gate does — not the name of whatever the provider or a tool
 * threw. A provider that ends with a plain `Error("aborted")` once the signal
 * fires has stopped because it was asked to, and the run reports `aborted`; the
 * same error with nobody having asked is still a fault. Every test here
 * synchronises on the effect actually having started (a deferred the fake
 * resolves), so the abort lands mid-effect without guessing at timing.
 */
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { assistantMessage, fakeModels } from "@eta/core/testing";
import { describe, expect, it } from "vitest";
import { Kernel, Runner } from "../src/index";
import { kernelOn } from "../src/types/events";

const userMsg = (text: string) => ({
  role: "user" as const,
  content: [{ type: "text" as const, text }],
  timestamp: 0,
});

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

type Ending = (signal: AbortSignal) => unknown;

/**
 * A stream that says nothing until the run's signal fires, then ends the way
 * `ending` says: a rejection (the thrown value), or — when `ending` returns a
 * message — a settled stream whose result is that message.
 */
function waitingStream(
  signal: AbortSignal | undefined,
  ending: Ending,
  mode: "reject" | "settle",
) {
  const fired = new Promise<void>((resolve) => {
    if (signal?.aborted === true) resolve();
    else signal?.addEventListener("abort", () => resolve(), { once: true });
  });
  let settled: unknown;
  return {
    [Symbol.asyncIterator]: () => ({
      next: async () => {
        await fired;
        if (mode === "reject") throw ending(signal!);
        settled = ending(signal!);
        return { done: true, value: undefined };
      },
    }),
    result: async () => settled,
  };
}

/**
 * A model layer whose first request waits for the abort and ends per `ending`;
 * every later request answers from `script`, so the next run can be checked.
 */
function cancellableModels(
  ending: Ending,
  mode: "reject" | "settle" = "reject",
  script: AssistantMessage[] = [],
) {
  const fake = fakeModels(script);
  const requested = deferred();
  const signals: (AbortSignal | undefined)[] = [];
  const scripted = fake.streamSimple;
  let first = true;
  fake.streamSimple = (model, context, options) => {
    signals.push(options?.signal);
    if (!first) return scripted(model, context, options);
    first = false;
    requested.resolve();
    return waitingStream(options?.signal, ending, mode) as never;
  };
  return { models: fake, requested: requested.promise, signals };
}

function setup(models: ReturnType<typeof fakeModels>) {
  const kernel = Kernel.create({
    config: {
      model: { provider: "p", modelId: "m" },
      // One attempt: a settled error must decide the run, not schedule a retry.
      retryPolicy: { enabled: false, maxRetries: 0, baseDelayMs: 0 },
    },
  });
  const runner = new Runner(kernel, { models });
  const runEnds: { status: string; error?: string }[] = [];
  const toolEnds: { toolCallId: string; isError: boolean; result: unknown }[] =
    [];
  const on = kernelOn(kernel.ctx);
  on("turn:run-end", (event) => {
    runEnds.push({
      status: event.status,
      ...(event.error === undefined ? {} : { error: event.error }),
    });
  });
  on("tool:end", (event) => {
    toolEnds.push({
      toolCallId: event.toolCallId,
      isError: event.isError,
      result: event.result,
    });
  });
  return { kernel, runner, runEnds, toolEnds };
}

const plainAborted = () => new Error("aborted");

describe("a provider cancelled by this run", () => {
  it("ends as aborted when it rejects with a plain Error after the abort", async () => {
    const { models, requested } = cancellableModels(plainAborted, "reject", [
      assistantMessage({ content: [{ type: "text", text: "the next run" }] }),
    ]);
    const { kernel, runner, runEnds } = setup(models);
    kernel.inject(userMsg("go"));
    const run = runner.run();
    await requested;
    runner.abort();
    const result = await run;
    expect(result.status).toBe("aborted");
    expect(result.error).toBeUndefined();
    // Exactly one run end, and it is the abort.
    expect(runEnds).toEqual([{ status: "aborted" }]);
    expect(runner.running).toBe(false);

    // The runner is free: the next run gets a fresh gate and completes.
    kernel.inject(userMsg("again"));
    const next = await runner.run();
    expect(next.status).toBe("completed");
    expect(runEnds.map((end) => end.status)).toEqual(["aborted", "completed"]);
    void kernel.dispose();
  });

  it("ends as aborted when it rejects with the signal's own reason", async () => {
    const { models, requested } = cancellableModels((signal) => signal.reason);
    const { kernel, runner, runEnds } = setup(models);
    kernel.inject(userMsg("go"));
    const run = runner.run();
    await requested;
    runner.abort();
    expect((await run).status).toBe("aborted");
    expect(runEnds).toEqual([{ status: "aborted" }]);
    void kernel.dispose();
  });

  it("ends as aborted when it settles with an error stop after the abort", async () => {
    const { models, requested } = cancellableModels(
      () =>
        assistantMessage({
          stopReason: "error",
          errorMessage: "request aborted by the client",
          content: [],
        }),
      "settle",
    );
    const { kernel, runner, runEnds } = setup(models);
    kernel.inject(userMsg("go"));
    const run = runner.run();
    await requested;
    runner.abort();
    const result = await run;
    expect(result.status).toBe("aborted");
    expect(result.error).toBeUndefined();
    expect(runEnds).toEqual([{ status: "aborted" }]);
    void kernel.dispose();
  });

  it("still honours an AbortError", async () => {
    const { models, requested } = cancellableModels(() =>
      Object.assign(new Error("The operation was aborted"), {
        name: "AbortError",
      }),
    );
    const { kernel, runner, runEnds } = setup(models);
    kernel.inject(userMsg("go"));
    const run = runner.run();
    await requested;
    runner.abort();
    expect((await run).status).toBe("aborted");
    expect(runEnds).toEqual([{ status: "aborted" }]);
    void kernel.dispose();
  });

  it("judges each run by its own signal, never the previous run's", async () => {
    const { models, requested, signals } = cancellableModels(
      plainAborted,
      "reject",
      [assistantMessage({ content: [{ type: "text", text: "fine" }] })],
    );
    const { kernel, runner } = setup(models);
    kernel.inject(userMsg("go"));
    const run = runner.run();
    await requested;
    runner.abort();
    await run;

    // The second run's provider fails for real: the first run's aborted signal
    // must not turn that into a cancellation.
    models.streamSimple = (_model, _context, options) => {
      signals.push(options?.signal);
      throw new Error("aborted");
    };
    kernel.inject(userMsg("again"));
    await expect(runner.run()).rejects.toThrow("aborted");
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]).not.toBe(signals[0]);
    expect(signals[1]?.aborted).toBe(false);
    void kernel.dispose();
  });
});

describe("a provider that fails without being cancelled", () => {
  it("keeps the failure contract for a plain Error, whatever it says", async () => {
    const models = fakeModels([]);
    models.streamSimple = () => {
      throw new Error("aborted");
    };
    const { kernel, runner, runEnds } = setup(models);
    kernel.inject(userMsg("go"));
    await expect(runner.run()).rejects.toThrow("aborted");
    // Not reported as an abort.
    expect(runEnds.some((end) => end.status === "aborted")).toBe(false);
    void kernel.dispose();
  });

  it("does not take a TimeoutError for the user's cancellation", async () => {
    const models = fakeModels([]);
    models.streamSimple = () => {
      throw Object.assign(new Error("The operation timed out"), {
        name: "TimeoutError",
      });
    };
    const { kernel, runner, runEnds } = setup(models);
    kernel.inject(userMsg("go"));
    await expect(runner.run()).rejects.toThrow("timed out");
    expect(runEnds.some((end) => end.status === "aborted")).toBe(false);
    void kernel.dispose();
  });

  it("reports an error stop as failed", async () => {
    const models = fakeModels([
      assistantMessage({
        stopReason: "error",
        errorMessage: "aborted",
        content: [],
      }),
    ]);
    const { kernel, runner, runEnds } = setup(models);
    kernel.inject(userMsg("go"));
    const result = await runner.run();
    expect(result.status).toBe("failed");
    expect(runEnds).toEqual([{ status: "failed", error: "aborted" }]);
    void kernel.dispose();
  });

  it("still treats an AbortError as cancellation (the existing contract)", async () => {
    const models = fakeModels([]);
    models.streamSimple = () => {
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    };
    const { kernel, runner, runEnds } = setup(models);
    kernel.inject(userMsg("go"));
    expect((await runner.run()).status).toBe("aborted");
    expect(runEnds).toEqual([{ status: "aborted" }]);
    void kernel.dispose();
  });
});

describe("a tool cancelled by this run", () => {
  const callingTool = (...ids: string[]) =>
    assistantMessage({
      stopReason: "toolUse",
      content: ids.map((id) => ({
        type: "toolCall" as const,
        id,
        name: "wait",
        arguments: {},
      })),
    });

  function waitingTool(ending: Ending) {
    const started = deferred();
    let settled = false;
    return {
      started: started.promise,
      settled: () => settled,
      tool: {
        name: "wait",
        execute: (_args: unknown, call: { signal?: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            started.resolve();
            call.signal?.addEventListener(
              "abort",
              () => {
                settled = true;
                reject(ending(call.signal!));
              },
              { once: true },
            );
          }),
      },
    };
  }

  it("reports the cancellation, not the tool's own message, and the run ends aborted", async () => {
    const models = fakeModels([
      callingTool("c1"),
      assistantMessage({ content: [{ type: "text", text: "the next run" }] }),
    ]);
    const { kernel, runner, runEnds, toolEnds } = setup(models);
    const waiting = waitingTool(() => new Error("aborted"));
    kernel.tools.register(waiting.tool);
    kernel.inject(userMsg("go"));
    const run = runner.run();
    await waiting.started;
    runner.abort();
    const result = await run;
    expect(waiting.settled()).toBe(true);
    expect(result.status).toBe("aborted");
    expect(runEnds).toEqual([{ status: "aborted" }]);
    // The call that started got its end: a cancellation, not a tool failure.
    expect(toolEnds).toHaveLength(1);
    expect(toolEnds[0]?.isError).toBe(true);
    expect(JSON.stringify(toolEnds[0]?.result)).toContain("cancelled");
    expect(JSON.stringify(toolEnds[0]?.result)).not.toContain('"aborted"');

    kernel.inject(userMsg("again"));
    expect((await runner.run()).status).toBe("completed");
    void kernel.dispose();
  });

  it("treats a parallel batch the same: every started call settles and reports", async () => {
    const models = fakeModels([callingTool("c1", "c2")]);
    const { kernel, runner, runEnds, toolEnds } = setup(models);
    kernel.config.update({ toolExecution: "parallel" });
    const waiting = waitingTool((signal) => signal.reason);
    kernel.tools.register(waiting.tool);
    kernel.inject(userMsg("go"));
    const run = runner.run();
    await waiting.started;
    runner.abort();
    expect((await run).status).toBe("aborted");
    expect(runEnds).toEqual([{ status: "aborted" }]);
    expect(toolEnds.map((end) => [end.toolCallId, end.isError])).toEqual([
      ["c1", true],
      ["c2", true],
    ]);
    void kernel.dispose();
  });

  it("keeps a tool's failure a tool result when nobody cancelled", async () => {
    const models = fakeModels([
      callingTool("c1"),
      assistantMessage({ content: [{ type: "text", text: "ok" }] }),
    ]);
    const { kernel, runner, runEnds, toolEnds } = setup(models);
    kernel.tools.register({
      name: "wait",
      execute: () => {
        throw new Error("aborted");
      },
    });
    kernel.inject(userMsg("go"));
    expect((await runner.run()).status).toBe("completed");
    expect(runEnds).toEqual([{ status: "completed" }]);
    expect(toolEnds[0]?.result).toEqual({ isError: true, content: "aborted" });
    void kernel.dispose();
  });
  it("does not run the tool calls of a generation that came back aborted", async () => {
    // What a stop looks like from the inside: the stream is cut, and the
    // assistant message is not history — its arguments may be half-written, so
    // the turn records no entry for it. The batch used to run anyway, and its
    // result *was* recorded: a tool result whose call never arrived, which a
    // provider refuses every later request for (HTTP 400, the session dead).
    const models = fakeModels([
      assistantMessage({
        stopReason: "aborted",
        content: [
          { type: "toolCall" as const, id: "c1", name: "wait", arguments: {} },
        ],
      }),
    ]);
    const { kernel, runner, runEnds, toolEnds } = setup(models);
    const ran: string[] = [];
    kernel.tools.register({
      name: "wait",
      execute: () => {
        ran.push("wait");
        return "done";
      },
    });
    kernel.inject(userMsg("go"));

    expect((await runner.run()).status).toBe("aborted");
    expect(runEnds).toEqual([{ status: "aborted" }]);
    expect(ran).toEqual([]);
    expect(toolEnds).toEqual([]);
    void kernel.dispose();
  });
});
