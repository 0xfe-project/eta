/**
 * A failed run leaves a record (eta #60).
 *
 * The failed generation is not history — it is never sent back to the model — but the
 * fact that the run failed, and why, is: one `run_failed` entry per failed run, landed
 * by the run boundary's flush, so `turn:run-end` reporting `failed` means the record is
 * already durable. A cancelled run is `aborted` and a clean one is `completed`; neither
 * leaves a failure record.
 */

import { type KernelModels, kernelOn, Runner } from "@eta/core";
import { type Entry, type RunFailedEntry, SessionLog } from "@eta/core/session";
import { MemoryStorage } from "@eta/core/storage";
import { assistantMessage, fakeModels } from "@eta/core/testing";
import { describe, expect, it } from "vitest";
import { journaledKernel } from "../src/testing";

const userMsg = (text: string) => ({
  role: "user" as const,
  content: [{ type: "text" as const, text }],
  timestamp: 0,
});

/** A provider failure the retry policy does not retry, with half an answer already streamed. */
const providerFailure = () =>
  assistantMessage({
    content: [{ type: "text", text: "half an answer" }],
    stopReason: "error",
    errorMessage: "401 Unauthorized: invalid api key",
  });

function session(models: KernelModels, storage = new MemoryStorage()) {
  const log = SessionLog.create(storage);
  const { kernel, journaling } = journaledKernel(log, {
    config: { model: { provider: "p", modelId: "m" } },
  });
  const runner = new Runner(kernel, { models, journal: journaling });
  const ends: {
    runId: string;
    status: string;
    error?: string;
    durable: boolean;
  }[] = [];
  kernelOn(kernel.ctx)("turn:run-end", (event) => {
    // Read at the moment the signal fires: nothing may still be waiting for a commit.
    const failure = log.graph
      .pathOldestFirst()
      .find((entry) => entry.type === "run_failed");
    ends.push({
      ...event,
      durable:
        log.pending.length === 0 &&
        (event.status !== "failed" || failure !== undefined),
    });
  });
  return { storage, log, kernel, journaling, runner, ends };
}

const failuresIn = (entries: readonly Entry[]): RunFailedEntry[] =>
  entries.filter(
    (entry): entry is RunFailedEntry => entry.type === "run_failed",
  );

describe("a failed run is recorded", () => {
  it("a provider failure leaves exactly one durable record, and no half message", async () => {
    const models = fakeModels([providerFailure()]);
    const s = session(models);
    s.kernel.inject(userMsg("go"));
    const result = await s.runner.run();
    expect(result.status).toBe("failed");
    expect(models.calls).toHaveLength(1);

    // On disk without an explicit flush: the run boundary landed it.
    const stored = await s.storage.scanEntries({});
    const failures = failuresIn(stored);
    expect(failures).toHaveLength(1);
    expect(failures[0]!.payload).toEqual({
      runId: s.ends[0]!.runId,
      error: "401 Unauthorized: invalid api key",
    });
    expect(failures[0]!.timestamp).toBeGreaterThan(0);
    expect(JSON.stringify(stored)).not.toContain("half an answer");
    expect(stored.filter((entry) => entry.type === "message")).toHaveLength(1);
    // The end signal fired after the record was durable.
    expect(s.ends).toEqual([
      expect.objectContaining({ status: "failed", durable: true }),
    ]);
    void s.kernel.dispose();
  });

  it("model_unavailable is recorded the same way", async () => {
    const fake = fakeModels([]);
    const models: KernelModels = { ...fake, getModel: () => undefined };
    const s = session(models);
    s.kernel.inject(userMsg("go"));
    const result = await s.runner.run();
    expect(result.status).toBe("failed");
    const failures = failuresIn(await s.storage.scanEntries({}));
    expect(failures).toHaveLength(1);
    expect(failures[0]!.payload.error).toBe("model_unavailable: p/m");
    expect(failures[0]!.payload.runId).toBe(s.ends[0]!.runId);
    expect(s.ends[0]!.durable).toBe(true);
    void s.kernel.dispose();
  });

  it("survives a reload, and a retry never sends the failure to the model", async () => {
    const models = fakeModels([
      providerFailure(),
      assistantMessage({ content: [{ type: "text", text: "fine" }] }),
    ]);
    const s = session(models);
    s.kernel.inject(userMsg("go"));
    await s.runner.run();

    // Reopen from the same storage: the record is there, the transcript does not hold it.
    const reloaded = await SessionLog.load(s.storage);
    expect(failuresIn(reloaded.graph.pathOldestFirst())).toHaveLength(1);
    const replayed = JSON.stringify(reloaded.transcript());
    expect(replayed).not.toContain("401 Unauthorized");
    expect(replayed).not.toContain("half an answer");

    // The retry (on the live session) sends the user turns and nothing about the failure.
    s.kernel.inject(userMsg("try again"));
    const retry = await s.runner.run();
    expect(retry.status).toBe("completed");
    const sent = JSON.stringify(models.calls.at(-1)?.context.messages);
    expect(sent).toContain("try again");
    expect(sent).not.toContain("401 Unauthorized");
    expect(sent).not.toContain("half an answer");
    expect(sent).not.toContain("run_failed");
    // The completed retry adds no failure record of its own.
    expect(failuresIn(await s.storage.scanEntries({}))).toHaveLength(1);
    void s.kernel.dispose();

    // A runner rebuilt from the reloaded journal sends the same clean context.
    const rebuiltModels = fakeModels([
      assistantMessage({ content: [{ type: "text", text: "ok" }] }),
    ]);
    const again = await SessionLog.load(s.storage);
    const { kernel, journaling } = journaledKernel(again, {
      config: { model: { provider: "p", modelId: "m" } },
    });
    const runner = new Runner(kernel, {
      models: rebuiltModels,
      journal: journaling,
      initialTranscript: again.transcript(),
    });
    kernel.inject(userMsg("after restart"));
    await runner.run();
    const resent = JSON.stringify(rebuiltModels.calls[0]?.context.messages);
    expect(resent).toContain("after restart");
    expect(resent).not.toContain("401 Unauthorized");
    void kernel.dispose();
  });

  it("each failed run gets its own record, once", async () => {
    const models = fakeModels([providerFailure(), providerFailure()]);
    const s = session(models);
    s.kernel.inject(userMsg("one"));
    await s.runner.run();
    s.kernel.inject(userMsg("two"));
    await s.runner.run();
    await s.journaling.flush();
    const failures = failuresIn(await s.storage.scanEntries({}));
    expect(failures.map((entry) => entry.payload.runId)).toEqual(
      s.ends.map((end) => end.runId),
    );
    expect(new Set(failures.map((entry) => entry.payload.runId)).size).toBe(2);
    void s.kernel.dispose();
  });
});

describe("runs that did not fail leave no failure record", () => {
  it("a completed run", async () => {
    const s = session(
      fakeModels([
        assistantMessage({ content: [{ type: "text", text: "done" }] }),
      ]),
    );
    s.kernel.inject(userMsg("go"));
    expect((await s.runner.run()).status).toBe("completed");
    expect(failuresIn(await s.storage.scanEntries({}))).toEqual([]);
    void s.kernel.dispose();
  });

  it("an aborted run", async () => {
    const models = fakeModels([
      assistantMessage({
        stopReason: "toolUse",
        content: [{ type: "toolCall", id: "c1", name: "stop", arguments: {} }],
      }),
    ]);
    let runner: Runner | undefined;
    const s = session(models);
    runner = s.runner;
    // The cancel lands mid-run, the way a user's stop does: from inside a tool call.
    s.kernel.tools.register({
      name: "stop",
      execute: async () => {
        runner?.abort();
        return "stopped";
      },
    });
    s.kernel.inject(userMsg("go"));
    expect((await s.runner.run()).status).toBe("aborted");
    expect(failuresIn(await s.storage.scanEntries({}))).toEqual([]);
    void s.kernel.dispose();
  });
});
