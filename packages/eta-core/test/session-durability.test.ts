/**
 * Session operations are durable (REFACTOR.md §K4 + §K5).
 *
 * fork/merge/rollback were pure graph operations: a merge entry never reached
 * the journal, and a rollback moved the tip in memory only — so a reload
 * rebuilt the wrong branch. What is pinned here: a merge is a journaled entry,
 * a rollback writes the branch tip as a value, and a reload resumes exactly
 * where the session was — including the new tip a later run hangs off.
 */
import { describe, expect, it } from "vitest";
import { SESSION_TIP, SessionLog } from "@eta/core/session";
import {
  MemoryStorage,
  type StorageService,
  setValue,
  value,
} from "@eta/core/storage";

const userMsg = (text: string) => ({
  role: "user" as const,
  content: [{ type: "text" as const, text }],
  timestamp: 0,
});

const textsOf = (log: SessionLog): string[] =>
  log.graph.pathOldestFirst().flatMap((entry) => {
    if (entry.type !== "message") return [];
    const message = entry.message;
    if (
      message.role !== "user" &&
      message.role !== "assistant" &&
      message.role !== "toolResult"
    )
      return [];
    const content = message.content;
    if (typeof content === "string") return [content];
    return content
      .filter(
        (part): part is { type: "text"; text: string } => part.type === "text",
      )
      .map((part) => part.text);
  });

/**
 * One journal holding a shared root, a side branch, and main-line work — the
 * shape a session has after someone explored an alternative and came back.
 */
async function withBranches(storage: StorageService = new MemoryStorage()) {
  const log = SessionLog.create(storage);
  const root = log.recordMessage(userMsg("shared history"));
  await log.commit();

  // A side branch written into the same journal; the tip goes back to main.
  const main = log.recordMessage(userMsg("main work"));
  const side = log.recordMessage(userMsg("side work"));
  void side;
  log.graph.setTip(main.id);
  await log.commit();
  return { log, storage, root, main, side };
}

describe("merge is durable", () => {
  it("journals the merge entry, and a reload reads the merged history", async () => {
    const { log, storage, root, main, side } = await withBranches();
    const merge = await log.merge(side.id, { summary: "merge side into main" });

    expect(merge.type).toBe("merge");
    expect(merge.mergedParentId).toBe(side.id);
    expect(textsOf(log)).toEqual(["shared history", "main work", "side work"]);

    const reloaded = await SessionLog.load(storage);
    expect(reloaded.graph.tipId()).toBe(merge.id);
    expect(reloaded.graph.pathOldestFirst().map((entry) => entry.id)).toEqual([
      root.id,
      main.id,
      side.id,
      merge.id,
    ]);
    expect(textsOf(reloaded)).toEqual([
      "shared history",
      "main work",
      "side work",
    ]);
    // The transcript the model would be sent sees the merged history too.
    expect(JSON.stringify(reloaded.transcript())).toContain("side work");
  });

  it("refuses the merges that make no sense, without writing anything", async () => {
    const { log, storage, side } = await withBranches();
    const before = (await storage.scanEntries({})).length;
    await expect(log.merge("ghost", { summary: "nothing" })).rejects.toThrow(
      "not in this journal",
    );
    await expect(
      log.merge(side.id, { summary: "first" }),
    ).resolves.toBeDefined();
    // The side branch is visible now, so merging it a second time is refused.
    await expect(log.merge(side.id, { summary: "again" })).rejects.toThrow(
      "already part of this history",
    );
    expect((await storage.scanEntries({})).length).toBe(before + 1);
  });

  it("a merge of the current tip is refused", async () => {
    const { log } = await withBranches();
    const tip = log.graph.tipId()!;
    await expect(log.merge(tip, { summary: "self" })).rejects.toThrow(
      "cannot merge into itself",
    );
  });
});

describe("rollback is durable", () => {
  it("writes the tip as a value, and a reload resumes at the rolled-back entry", async () => {
    const { log, storage, root, main, side } = await withBranches();
    const merge = await log.merge(side.id, { summary: "merge side into main" });

    const result = await log.rollback(main.id);
    expect(result).toEqual({
      ok: true,
      entryId: main.id,
      droppedIds: expect.arrayContaining([side.id, merge.id]),
    });

    // The tip value is what a reload needs; entries stay in the journal.
    expect((await storage.getValue(SESSION_TIP))?.value).toBe(main.id);
    expect((await storage.scanEntries({})).length).toBe(4);

    const reloaded = await SessionLog.load(storage);
    expect(reloaded.graph.tipId()).toBe(main.id);
    expect(reloaded.graph.pathOldestFirst().map((entry) => entry.id)).toEqual([
      root.id,
      main.id,
    ]);
    expect(textsOf(reloaded)).toEqual(["shared history", "main work"]);
  });

  it("a message recorded after a rollback hangs off the rolled-back tip", async () => {
    const { log, storage, main } = await withBranches();
    await log.rollback(main.id);
    const next = log.recordMessage(userMsg("after the rollback"));
    await log.commit();
    expect(next.parentId).toBe(main.id);

    const reloaded = await SessionLog.load(storage);
    expect(reloaded.graph.tipId()).toBe(next.id);
    expect(textsOf(reloaded)).toEqual([
      "shared history",
      "main work",
      "after the rollback",
    ]);
  });

  it("the rolled-back tip outlives an unrelated journal append", async () => {
    const { log, storage, main } = await withBranches();
    await log.rollback(main.id);
    // Someone writes to the journal without touching the branch (a value write,
    // say): the tip value, not the newest entry, is still the truth.
    await storage.commit([
      setValue(value<string>("session.name"), "still rolled back"),
    ]);
    const reloaded = await SessionLog.load(storage);
    expect(reloaded.graph.tipId()).toBe(main.id);
  });

  it("refuses an unknown or off-branch entry, and moves nothing", async () => {
    const { log, storage, side } = await withBranches();
    const tipBefore = log.graph.tipId();
    const entriesBefore = (await storage.scanEntries({})).length;
    // `side` exists but is not on the current (main) chain.
    const off = await log.rollback(side.id);
    expect(off.ok).toBe(false);
    const unknown = await log.rollback("ghost");
    expect(unknown.ok).toBe(false);
    expect(log.graph.tipId()).toBe(tipBefore);
    expect((await storage.getValue(SESSION_TIP))?.value).toBe(tipBefore);
    expect((await storage.scanEntries({})).length).toBe(entriesBefore);
  });

  it("a tip value naming an entry the journal no longer holds is ignored", async () => {
    const { log, storage, main, side } = await withBranches();
    await log.rollback(main.id);
    // Somebody trimmed the journal behind us: the tip value now dangles.
    await storage.commit([
      {
        kind: "value",
        op: "set",
        namespace: SESSION_TIP.namespace,
        key: SESSION_TIP.key,
        value: "gone",
      },
    ]);
    const reloaded = await SessionLog.load(storage);
    expect(reloaded.orphans).toBe(0);
    // The newest entry wins rather than the reload failing — which is exactly
    // the case a rollback needs the tip value to override.
    expect(reloaded.graph.tipId()).toBe(side.id);
    expect(reloaded.graph.tipId()).not.toBe(main.id);
  });
});

describe("fork reads the journal", () => {
  it("returns the prefix chain for a destination to adopt, writing nothing", async () => {
    const { log, storage, root, main } = await withBranches();
    const before = (await storage.scanEntries({})).length;
    const fork = log.forkAt(main.id);
    expect(fork.tipId).toBe(main.id);
    expect(fork.entries.map((entry) => entry.id)).toEqual([main.id, root.id]);
    expect((await storage.scanEntries({})).length).toBe(before);
  });

  it("the adopted chain carries on as its own history", async () => {
    const { log, main, side } = await withBranches();
    const fork = log.forkAt(main.id);
    const dest = SessionLog.create(new MemoryStorage());
    for (const entry of [...fork.entries].reverse()) dest.record(entry);
    await dest.commit();
    expect(dest.graph.tipId()).toBe(main.id);
    expect(textsOf(dest)).toEqual(["shared history", "main work"]);

    const next = dest.recordMessage(userMsg("fork work"));
    await dest.commit();
    expect(next.parentId).toBe(main.id);
    // The source journal is untouched by the fork: the same tip, and the side
    // branch it holds is still off the path (that is why it can be merged).
    expect(textsOf(log)).toEqual(["shared history", "main work"]);
    expect(log.graph.has(side.id)).toBe(true);
  });

  it("defaults to the current tip, and both fork positions work", async () => {
    const { log, main, root } = await withBranches();
    expect(log.forkAt().tipId).toBe(log.graph.tipId());
    // "at" keeps the selected entry; "before" stops at its parent but still
    // copies the history behind it.
    expect(
      log.forkAt(main.id, { position: "at" }).entries.map((entry) => entry.id),
    ).toEqual([main.id, root.id]);
    expect(
      log
        .forkAt(main.id, { position: "before" })
        .entries.map((entry) => entry.id),
    ).toEqual([root.id]);
    expect(log.forkAt(root.id, { position: "before" }).entries).toEqual([]);
  });
});

describe("the tip value", () => {
  it("names the newest entry when nothing was rolled back", async () => {
    const { log, storage } = await withBranches();
    expect((await storage.getValue(SESSION_TIP))?.value).toBe(
      log.graph.tipId(),
    );
  });

  it("is written once per movement, not once per commit", async () => {
    const { log, storage } = await withBranches();
    // A commit that does not move the tip writes no new row.
    await storage.commit([
      setValue(value<string>("session.name"), "still here"),
    ]);
    const before = await storage.scanEntries({});
    log.recordMessage(userMsg("one more"));
    await log.commit();
    expect((await storage.scanEntries({})).length).toBe(before.length + 1);
    expect((await storage.getValue(SESSION_TIP))?.value).toBe(
      log.graph.tipId(),
    );
  });

  it("a fresh journal with no entries has no tip value", async () => {
    const storage = new MemoryStorage();
    SessionLog.create(storage);
    expect(await storage.getValue(SESSION_TIP)).toBeUndefined();
    expect((await SessionLog.load(storage)).graph.tipId()).toBeNull();
  });
});
