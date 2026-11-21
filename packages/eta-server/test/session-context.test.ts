import type { ContextReading } from "@eta/client-contracts";
import { displayContext } from "@eta/client-contracts";
import { emptyUsage, kernelEmit, withUsageEvidence } from "@eta/core";
import { fakeModels } from "@eta/core/testing";
import { expect, it } from "vitest";
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
    expect(displayContext(reading(), meta.id, "zh").label).toBe("约 13%");
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
