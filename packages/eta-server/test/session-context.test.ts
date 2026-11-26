import type { ContextReading, GenerationRate } from "@eta/client-contracts";
import type {
  AssistantMessage,
  AssistantMessageEvent,
  RunDelegateContext,
  Usage,
} from "@eta/core";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { displayContext } from "@eta/client-contracts";
import { emptyUsage, kernelEmit, kernelOn, withUsageEvidence } from "@eta/core";
import { setValue, value } from "@eta/core/storage";
import { fakeModels } from "@eta/core/testing";
import { JsonlStorage } from "@eta/storage-jsonl";
import { expect, it, vi } from "vitest";
import { FileSessionStore, JOURNAL_FILE } from "../src/file-store";
import { SessionManager } from "../src/manager";
import { MemorySessionStore } from "../src/memory-store";

it("estimates managed history against the resolved model and clears it at model and compaction boundaries", async () => {
  const fake = fakeModels([]);
  const manager = new SessionManager({
    store: new MemorySessionStore(),
    modelsFor: () => ({
      ...fake,
      getModel: (provider, id) => ({
        ...fake.getModel(provider, id)!,
        contextWindow: 128000,
      }),
    }),
  });
  try {
    const { session, meta } = await manager.create({
      cwd: "/work",
      model: "fake:fake-model",
    });
    session.runner.adoptTranscript([
      { role: "user", content: "a".repeat(64000), timestamp: 1 },
    ]);
    const reading = () =>
      session.view.snapshot().sections.context as ContextReading;
    expect(displayContext(reading(), meta.id, "zh").label).toBe(
      "约 13% · 上次查询",
    );
    session.kernel.config.setModel("fake", "other");
    expect(reading()).toMatchObject({ reason: "model", used: null });
    kernelEmit(session.kernel.ctx)("compaction:end", {
      runId: "r",
      endedAt: 3,
      reason: "manual",
      status: "completed",
    });
    expect(reading()).toMatchObject({ reason: "compacted", compactedAt: 3 });
  } finally {
    await manager.closeAll();
  }
});

it("reopens the per-field ledger, preserving explicit zeros and treating older normalized zeros as unknown", async () => {
  const manager = new SessionManager({
    store: new MemorySessionStore(),
    modelsFor: () => fakeModels([]),
  });
  try {
    const { session, meta } = await manager.create({ cwd: "/work" });
    await session.journaling.recordUsage({ ...emptyUsage(), input: 100 });
    expect(session.view.snapshot().sections.spend).toEqual({
      input: { value: 100, coverage: "complete" },
      output: null,
      cache: null,
    });
    await session.journaling.recordUsage(
      withUsageEvidence(emptyUsage(), {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
      }),
    );
    await manager.close(meta.id);
    const restored = await manager.session(meta.id);
    expect(restored?.session.view.snapshot().sections.spend).toEqual({
      input: { value: 100, coverage: "complete" },
      output: { value: 0, coverage: "partial" },
      cache: { value: 0, coverage: "partial" },
    });
  } finally {
    await manager.closeAll();
  }
});

/** Drives one generation through the frames a provider stream emits, on a clock the test sets. */
async function scriptedGeneration() {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(0);
  const manager = new SessionManager({
    store: new MemorySessionStore(),
    modelsFor: () => fakeModels([]),
  });
  const { session } = await manager.create({ cwd: "/work" });
  const emit = kernelEmit(session.kernel.ctx);
  const message = (text: string, usage: Usage = emptyUsage()) =>
    ({
      role: "assistant",
      content: [{ type: "text", text }],
      api: "fake",
      provider: "fake",
      model: "fake-model",
      usage,
      stopReason: "stop",
      timestamp: 0,
    }) satisfies AssistantMessage;
  const frame = (at: number, text: string) => {
    vi.setSystemTime(at);
    const partial = message(text);
    emit("message:update", {
      runId: "r",
      turnId: "t",
      message: partial,
      event: {
        type: "text_delta",
        contentIndex: 0,
        delta: text,
        partial,
      } satisfies AssistantMessageEvent,
    });
  };
  const start = () => emit("message:start", { runId: "r", turnId: "t" });
  start();
  return {
    start,
    frame,
    end(at: number, text: string, usage: Usage) {
      vi.setSystemTime(at);
      emit("message:end", { runId: "r", message: message(text, usage) });
    },
    rate: () => session.view.snapshot().sections.rate as GenerationRate | null,
    async [Symbol.asyncDispose]() {
      vi.useRealTimers();
      await manager.closeAll();
    },
  };
}

it("estimates a streaming generation at most once a second, then reports its measured rate", async () => {
  await using run = await scriptedGeneration();
  run.frame(0, "a".repeat(4));
  run.frame(500, "a".repeat(400));
  expect(run.rate()).toBeNull();
  // 200 estimated tokens one second after the first output.
  run.frame(1000, "a".repeat(800));
  expect(run.rate()).toEqual({ tokensPerSec: 200, basis: "estimate" });
  run.frame(1999, "a".repeat(1600));
  expect(run.rate()).toEqual({ tokensPerSec: 200, basis: "estimate" });
  run.frame(2000, "a".repeat(2000));
  expect(run.rate()).toEqual({ tokensPerSec: 250, basis: "estimate" });
  // 300 reported output tokens over the two seconds from first to last output.
  run.end(2000, "a".repeat(2000), { ...emptyUsage(), output: 300 });
  expect(run.rate()).toEqual({ tokensPerSec: 150, basis: "measured" });
});

it("shows no rate when a generation starts until its first estimate", async () => {
  await using run = await scriptedGeneration();
  run.frame(0, "a".repeat(4));
  run.frame(2000, "a".repeat(800));
  run.end(2000, "a".repeat(800), { ...emptyUsage(), output: 100 });
  expect(run.rate()).toEqual({ tokensPerSec: 50, basis: "measured" });
  // The next generation of the turn drops the last one's rate rather than showing it as its own.
  run.start();
  expect(run.rate()).toBeNull();
  run.frame(3000, "a".repeat(4));
  run.frame(3999, "a".repeat(400));
  expect(run.rate()).toBeNull();
  run.frame(4000, "a".repeat(800));
  expect(run.rate()).toEqual({ tokensPerSec: 200, basis: "estimate" });
});

it("keeps an ended generation an estimate when the provider reports no output", async () => {
  await using run = await scriptedGeneration();
  run.frame(0, "a".repeat(4));
  run.frame(2000, "a".repeat(800));
  run.end(2000, "a".repeat(800), emptyUsage());
  expect(run.rate()).toEqual({ tokensPerSec: 100, basis: "estimate" });
});

function deferred<T>() {
  let signal!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    signal = resolve;
  });
  return { promise, signal };
}

const ADDRESS = value<{ reading: ContextReading }>("eta.session-context");

async function runtimeJournal(
  run: (context: RunDelegateContext) => Promise<void>,
  runtime = "codex",
) {
  const root = await mkdtemp(join(tmpdir(), "eta-context-"));
  const models = fakeModels([]);
  const warnings: string[] = [];
  let native = "thread-a";
  const open = () => {
    const store = new FileSessionStore({ root });
    const manager = new SessionManager({
      store,
      modelsFor: () => models,
      warn: (message) => warnings.push(message),
      runtimes: {
        open: (input) => ({
          models,
          delegate: {
            run: async (context) => {
              await input.remember(native);
              await run(context);
              return { status: "completed" };
            },
          },
          dispose: async () => {},
        }),
      },
    });
    return { store, manager };
  };
  let current = open();
  const created = await current.manager.create({
    cwd: root,
    runtime,
    model: `${runtime}:one`,
  });
  const id = created.meta.id;
  let session = created.session;
  const start = () => {
    session.kernel.nextRun("test");
    return session.runner.run();
  };
  const path = join(root, id, JOURNAL_FILE);
  return {
    id,
    path,
    start,
    warnings,
    get session() {
      return session;
    },
    get storage() {
      return current.store.open(id).then((stored) => stored!.storage);
    },
    read: () => session.view.snapshot().sections.context as ContextReading,
    changeNative: (id: string) => {
      native = id;
    },
    restart: async () => {
      await current.manager.closeAll();
      await current.store.close();
      current = open();
      session = (await current.manager.session(id))!.session;
    },
    stop: async () => {
      await current.manager.closeAll();
      await current.store.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

function sample(
  context: RunDelegateContext,
  used: number | null,
  patch: {
    runId?: string;
    nativeSessionId?: string;
    observedAt?: number;
    window?: number | null;
  } = {},
) {
  context.emit("context:observed", {
    runId: context.runId,
    nativeSessionId: "thread-a",
    model: "one",
    observedAt: Date.now(),
    used,
    window: 475_000,
    ...patch,
  });
}

async function readFromDisk(path: string) {
  const disk = await JsonlStorage.open(path);
  try {
    return (await disk.getValue(ADDRESS))?.value;
  } finally {
    await disk.close();
  }
}

it("publishes the final coalesced record only after an independent journal can read it", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  const started = deferred<RunDelegateContext>();
  const finish = deferred<void>();
  let runs = 0;
  const host = await runtimeJournal(async (context) => {
    if (++runs > 1) {
      sample(context, 99, { runId: (await started.promise).runId });
      sample(context, null, { window: null });
      return;
    }
    sample(context, 130_000);
    started.signal(context);
    await finish.promise;
  });
  try {
    const on = kernelOn(host.session.kernel.ctx);
    let atEnd: ReturnType<typeof readFromDisk> | undefined;
    on("turn:run-end", () => {
      atEnd = readFromDisk(host.path);
    });
    const running = host.start();
    const context = await started.promise;
    await host.session.journaling.flush();
    expect(await readFromDisk(host.path)).toBeUndefined();

    sample(context, 135_000);
    await vi.advanceTimersByTimeAsync(5000);
    await host.session.journaling.flush();
    expect((await readFromDisk(host.path))?.reading.used).toBe(135_000);
    const storage = await host.storage;
    const commits = vi.spyOn(storage, "commit");
    await vi.advanceTimersByTimeAsync(100);
    sample(context, 139_000);
    await vi.advanceTimersByTimeAsync(100);
    sample(context, 139_000);
    const final = host.read();
    expect(final).toMatchObject({ observation: "live", runId: context.runId });
    expect(displayContext(final, host.id, "zh-CN").label).toBe("29%");
    finish.signal();
    await expect(running).resolves.toMatchObject({ status: "completed" });
    expect((await atEnd)?.reading).toEqual(final);

    const valueWrites = () =>
      commits.mock.calls.flatMap(([writes]) =>
        writes.filter(
          (write) =>
            write.kind === "value" && write.namespace === ADDRESS.namespace,
        ),
      );
    expect(valueWrites()).toHaveLength(1);
    await host.session.journaling.flush(context.runId);
    await vi.advanceTimersByTimeAsync(5000);
    const previous = { ...final, observation: "last-observed" };
    await host.session.journaling.flush();
    expect(valueWrites()).toHaveLength(1);

    let atStart: unknown;
    on("turn:run-start", () => {
      atStart = host.read();
    });
    await host.start();
    expect(atStart).toEqual(previous);
    expect(host.read()).toEqual(previous);
    expect(valueWrites()).toHaveLength(1);
    await host.restart();
    expect(host.read()).toEqual(previous);
    expect(displayContext(host.read(), host.id, "zh-CN").detail).toContain(
      new Date(final.observedAt).toLocaleString("zh-CN"),
    );
  } finally {
    finish.signal();
    await host.stop();
    vi.useRealTimers();
  }
});

it.each(["model", "nativeSession", "compacted"] as const)(
  "keeps the %s invalidation durable after a run without a replacement reading",
  async (boundary) => {
    let runs = 0;
    const host = await runtimeJournal(async (context) => {
      if (++runs === 1) sample(context, 1_000);
      else if (boundary === "compacted") {
        const at = Date.now();
        context.emit("context:invalidated", {
          runId: context.runId,
          nativeSessionId: "thread-a",
          reason: "compacted",
          at,
          compactedAt: at,
        });
        sample(context, 8_000, { observedAt: at - 1 });
      } else if (boundary === "nativeSession") {
        sample(context, 9_000); // Still from the former native session.
      }
    });
    try {
      await host.start();
      if (boundary === "model")
        host.session.kernel.config.setModel("codex", "two");
      if (boundary === "nativeSession") host.changeNative("thread-b");
      await host.start();
      expect(host.read()).toMatchObject({ reason: boundary, used: null });
      expect((await readFromDisk(host.path))?.reading).toMatchObject({
        reason: boundary,
        used: null,
      });
      await host.restart();
      expect(host.read()).toMatchObject({ reason: boundary, used: null });
      expect(displayContext(host.read(), host.id, "zh").label).toBe("N/A");
    } finally {
      await host.stop();
    }
  },
);

it("drops a record belonging to a different member and reports a failed write without changing the run result", async () => {
  const host = await runtimeJournal(async (context) => sample(context, 100));
  try {
    const storage = await host.storage;
    const commit = storage.commit.bind(storage);
    const spy = vi
      .spyOn(storage, "commit")
      .mockImplementation(async (writes) => {
        if (
          writes.some(
            (write) =>
              write.kind === "value" && write.namespace === ADDRESS.namespace,
          )
        )
          throw new Error("write unavailable");
        return await commit(writes);
      });
    await expect(host.start()).resolves.toMatchObject({ status: "completed" });
    expect(host.warnings).toContain(
      "[eta-journal] value commit failed (eta.session-context)",
    );
    expect(await readFromDisk(host.path)).toBeUndefined();
    spy.mockRestore();
    await host.start();
    const saved = await readFromDisk(host.path);
    await host.session.journaling.writeValues([
      setValue(ADDRESS, {
        ...saved,
        reading: { ...saved!.reading, session: "different" },
      }),
    ]);
    await host.restart();
    expect(host.read()).toMatchObject({ reason: "missing", used: null });
    expect(await readFromDisk(host.path)).toBeUndefined();
  } finally {
    await host.stop();
  }
});

it("preserves a failing run's journal entry when its context KV write fails", async () => {
  const host = await runtimeJournal(async (context) => {
    sample(context, 100);
    throw new Error("runtime failed");
  });
  try {
    const storage = await host.storage;
    const commit = storage.commit.bind(storage);
    vi.spyOn(storage, "commit").mockImplementation(async (writes) => {
      if (
        writes.some(
          (write) =>
            write.kind === "value" && write.namespace === ADDRESS.namespace,
        )
      )
        throw new Error("write unavailable");
      return await commit(writes);
    });
    await expect(host.start()).resolves.toMatchObject({
      status: "failed",
      error: "runtime failed",
    });
    const disk = await JsonlStorage.open(host.path);
    try {
      expect(await disk.scanEntries({ type: "run_failed" })).toEqual([
        expect.objectContaining({
          payload: expect.objectContaining({ error: "runtime failed" }),
        }),
      ]);
    } finally {
      await disk.close();
    }
  } finally {
    await host.stop();
  }
});

it("rejects a saved reading on reopen when the journal has a newer compaction boundary", async () => {
  const host = await runtimeJournal(async (context) => sample(context, 100));
  try {
    await host.start();
    host.session.log.record({
      id: "new-boundary",
      parentId: null,
      type: "compaction",
      summary: "compacted",
      retainedTail: [],
      tokensBefore: 100,
    });
    await host.session.journaling.flush();
    expect((await readFromDisk(host.path))?.reading.used).toBe(100);
    await host.restart();
    expect(host.read()).toMatchObject({ reason: "compacted", used: null });
    expect((await readFromDisk(host.path))?.reading.reason).toBe("compacted");
  } finally {
    await host.stop();
  }
});

it.each(["claude", "codex", "pi"])(
  "reopens zero from %s according to the runtime's reporting semantics",
  async (runtime) => {
    const host = await runtimeJournal(
      async (context) => sample(context, 0),
      runtime,
    );
    try {
      await host.start();
      expect((await readFromDisk(host.path))?.reading.used).toBe(0);
      await host.restart();
      if (runtime === "claude") {
        expect(host.read()).toMatchObject({ used: null, reason: "missing" });
        expect((await readFromDisk(host.path))?.reading.reason).toBe("missing");
      } else {
        expect(host.read()).toMatchObject({
          used: 0,
          observation: "last-observed",
        });
      }
    } finally {
      await host.stop();
    }
  },
);
