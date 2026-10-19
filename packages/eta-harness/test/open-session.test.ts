/**
 * Opening a session (REFACTOR.md §K5).
 *
 * The end-to-end claim of this file: everything a session was — its history, its
 * branch tip, its goal, its ledger, its configuration, its usage totals — comes
 * back from the journal through one call, and the session keeps working
 * afterwards. Before this, "restart" was four hand-wired steps in a test and
 * nothing in the library.
 */
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { KernelConfig } from "@eta/core";
import type { StorageService } from "@eta/core/storage";
import { SessionLog } from "@eta/core/session";
import { MemoryStorage, setValue, value } from "@eta/core/storage";
import { assistantMessage, fakeModels } from "@eta/core/testing";
import { describe, expect, it } from "vitest";
import { openSession, RunPump } from "../src/index";
import { SESSION_CONFIG, TASKS_STATE } from "../src/testing";

const userMsg = (text: string) => ({
  role: "user" as const,
  content: [{ type: "text" as const, text }],
  timestamp: 0,
});

const answer = (text: string): AssistantMessage =>
  assistantMessage({
    content: [{ type: "text", text }],
    stopReason: "stop",
    usage: {
      input: 100,
      output: 20,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 120,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  });

const textsOf = (
  messages: readonly { role?: string; content?: unknown }[],
): string[] =>
  messages.flatMap((message) =>
    message.role === "user" && Array.isArray(message.content)
      ? (message.content as { type?: string; text?: string }[])
          .filter((part) => part.type === "text")
          .map((part) => part.text ?? "")
      : [],
  );

/** A session that has lived: a run, a goal, a ledger, a config, a merge, a rollback. */
async function livedSession(storage: StorageService) {
  const opened = await openSession({
    storage,
    models: fakeModels([]),
    config: { model: { provider: "p", modelId: "m" }, activeToolNames: [] },
  });
  // A run.
  const first = await openSession({
    storage,
    models: fakeModels([answer("the first answer")]),
    config: { model: { provider: "p", modelId: "m" } },
  });
  first.kernel.inject(userMsg("first question"));
  await first.runner.run();
  first.stop();

  // A goal, a ledger, and a configuration — all three durable through the journal.
  opened.kernel.goal.set("ship the kernel");
  opened.kernel.tasks.create("write the assembly");
  opened.kernel.tasks.create("test the assembly", { deps: ["t1"] });
  opened.kernel.tasks.update("t2", { status: "in_progress" });
  opened.kernel.config.update({ thinkingLevel: "high", activeToolNames: [] });
  await opened.journaling.flush();

  // A side branch, merged, then rolled back — the branch view moves and the
  // journal has to remember where it stopped.
  const log = await SessionLog.load(storage);
  const tip = log.graph.tipId()!;
  const side = log.recordMessage(userMsg("side exploration"));
  log.graph.setTip(tip);
  await log.commit();
  await log.merge(side.id, { summary: "merge the side exploration" });
  await log.rollback(tip);
  opened.stop();
  void opened.kernel.dispose();
  return { mergedTipId: side.id, rollbackTo: tip };
}

describe("openSession", () => {
  it("restores history, tip, goal, ledger, and config from the journal", async () => {
    const storage = new MemoryStorage();
    const { mergedTipId, rollbackTo } = await livedSession(storage);

    const reopened = await openSession({
      storage,
      models: fakeModels([]),
      config: { model: { provider: "p", modelId: "other" } },
    });

    // Configuration: the journal's word, not the caller's default.
    expect(reopened.configRestored).toBe(true);
    expect(reopened.config.model).toEqual({ provider: "p", modelId: "m" });
    expect(reopened.config.thinkingLevel).toBe("high");
    expect(reopened.kernel.config.read("thinkingLevel")).toBe("high");

    // Goal: replayed from its entries.
    expect(reopened.kernel.goal.current?.objective).toBe("ship the kernel");
    expect(reopened.kernel.goal.current?.status).toBe("active");

    // Ledger: restored, malformed rows and all, with ids intact.
    expect(reopened.tasks).toEqual({ kept: 2, dropped: [] });
    expect(reopened.kernel.tasks.get("t2")).toMatchObject({
      content: "test the assembly",
      status: "in_progress",
    });
    expect(reopened.kernel.tasks.get("t1")?.blocks).toEqual(["t2"]);

    // Branch view: the rollback is where the session stopped, so the side chain
    // and the merge entry are in the journal but not on the path.
    expect(reopened.log.graph.tipId()).toBe(rollbackTo);
    expect(reopened.log.graph.has(mergedTipId)).toBe(true);
    expect(reopened.orphans).toBe(0);

    // Transcript and totals: what the run left behind, rebuilt by replay.
    expect(textsOf(reopened.transcript)).toEqual(["first question"]);
    const stats = await storage.getStats();
    expect(stats.messageCount).toBeGreaterThan(0);
    expect(stats.usage.totalTokens).toBe(120);
    reopened.stop();
    void reopened.kernel.dispose();
  });

  it("a brand-new session is the same call over an empty journal", async () => {
    const storage = new MemoryStorage();
    const opened = await openSession({
      storage,
      models: fakeModels([]),
      config: { model: { provider: "p", modelId: "m" } },
    });
    expect(opened.configRestored).toBe(false);
    expect(opened.config.model).toEqual({ provider: "p", modelId: "m" });
    expect(opened.tasks).toBeUndefined();
    expect(opened.transcript).toEqual([]);
    expect(opened.orphans).toBe(0);
    expect(opened.log.graph.tipId()).toBeNull();
    opened.stop();
    void opened.kernel.dispose();
  });

  it("keeps the goal durable from here on: a transition lands as an entry", async () => {
    const storage = new MemoryStorage();
    const opened = await openSession({
      storage,
      models: fakeModels([]),
      config: { model: { provider: "p", modelId: "m" } },
    });
    opened.kernel.goal.set("record me");
    opened.kernel.goal.pause("waiting");
    await opened.journaling.flush();
    opened.stop();

    const again = await openSession({
      storage,
      models: fakeModels([]),
      config: { model: { provider: "p", modelId: "m" } },
    });
    expect(again.kernel.goal.current?.objective).toBe("record me");
    expect(again.kernel.goal.current?.status).toBe("paused");
    again.stop();
    void again.kernel.dispose();
  });

  it("a restored session keeps working: a new run continues on it", async () => {
    const storage = new MemoryStorage();
    await livedSession(storage);

    // The restored session takes a follow-up, sees the replayed history, and
    // appends to the same journal.
    const entriesBefore = (await storage.scanEntries({})).length;
    const fake = fakeModels([answer("the second answer")]);
    const reopened = await openSession({
      storage,
      models: fake,
      config: { model: { provider: "p", modelId: "m" } },
    });
    const pump = new RunPump(reopened.kernel, reopened.runner);
    pump.start();
    reopened.kernel.inject(userMsg("second question"));
    await new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        if (!reopened.runner.running && reopened.kernel.inboxDepth === 0) {
          clearInterval(timer);
          resolve();
        }
      }, 5);
    });
    // The provider saw the restored history, not an empty context.
    const sent = fake.calls[0]!.context.messages;
    expect(textsOf(sent as never)).toEqual([
      "first question",
      "second question",
    ]);
    // The new turn hung off the rolled-back tip and is in the journal.
    expect((await storage.scanEntries({})).length).toBeGreaterThan(
      entriesBefore,
    );
    expect(reopened.runner.getTranscript().length).toBeGreaterThanOrEqual(4);
    pump.stop();
    reopened.stop();
    void reopened.kernel.dispose();
  });

  it("names the config it could not find, so a host can tell start from restart", async () => {
    const storage = new MemoryStorage();
    // A journal with history but no configuration value (an imported session).
    const log = SessionLog.create(storage);
    log.recordMessage(userMsg("from another machine"));
    log.recordMessage(answer("and its answer") as never);
    await log.commit();
    expect(await storage.getValue(SESSION_CONFIG)).toBeUndefined();

    const opened = await openSession({
      storage,
      models: fakeModels([]),
      config: {
        model: { provider: "p", modelId: "m" },
        thinkingLevel: "medium",
      },
    });
    expect(opened.configRestored).toBe(false);
    expect(opened.config.thinkingLevel).toBe("medium");
    expect(textsOf(opened.transcript)).toEqual(["from another machine"]);
    opened.stop();
    void opened.kernel.dispose();
  });

  it("a session whose state values are foreign is not poisoned by them", async () => {
    const storage = new MemoryStorage();
    // Someone wrote garbage where the ledger lives (a hand-edited journal, an
    // older schema): the restore path is what has to survive it.
    await storage.commit([setValue(TASKS_STATE, "not a list" as never)]);
    await storage.commit([
      setValue(SESSION_CONFIG, { nonsense: true } as never),
    ]);
    const opened = await openSession({
      storage,
      models: fakeModels([]),
      config: { model: { provider: "p", modelId: "m" } },
    });
    // A non-array ledger is a total drop, and the config value is taken as-is
    // (a host that wrote it owns its shape).
    expect(opened.tasks).toEqual({ kept: 0, dropped: ["root"] });
    opened.stop();
    void opened.kernel.dispose();
  });

  it("a config value names the same fields a live session writes", async () => {
    const storage = new MemoryStorage();
    const opened = await openSession({
      storage,
      models: fakeModels([]),
      config: { model: { provider: "p", modelId: "m" } },
    });
    opened.kernel.config.update({ thinkingLevel: "low" });
    await opened.journaling.flush();
    const written = (await storage.getValue(
      value<KernelConfig>("eta.session.config"),
    ))!.value;
    // Everything KernelConfig carries is there: a partial write would come back
    // as a session with defaults it never had.
    expect(Object.keys(written).sort()).toEqual(
      Object.keys(opened.config).sort(),
    );
    expect(written.retryPolicy).toEqual(opened.config.retryPolicy);
    expect(written.compaction).toEqual(opened.config.compaction);
    opened.stop();
    void opened.kernel.dispose();
  });
});
