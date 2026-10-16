import type { StorageService, StorageWrite } from "../storage/types";
import type { MessageEntry } from "../types/entries";
import type { Usage } from "../types/messages";
/**
 * The StorageService contract suite (REFACTOR.md §4).
 *
 * Every backend — memory, JSONL, whatever comes next — must pass the same
 * behavioural checks. Backends with extra guarantees (crash durability, torn
 * tails) add their own suites on top; they do not get to skip these.
 */
import { describe, expect, it } from "vitest";
import { setValue, value } from "../storage/types";
import { emptyUsage } from "../types/usage";

export interface StorageContractHandle {
  storage: StorageService;
  /** Release the handle. */
  dispose: () => Promise<void>;
  /**
   * Open the same backing store again from scratch. Required for persistent
   * backends; the suite then checks that what was written is actually
   * readable by a fresh process.
   */
  reopen?: () => Promise<StorageContractHandle>;
}

export type StorageFactory = () => Promise<StorageContractHandle>;

export interface StorageContractOptions {
  /** Set for backends that persist; requires `reopen` on the handle. */
  persistent?: boolean;
}

const messageEntry = (
  id: string,
  text: string,
  parentId: string | null = null,
): Omit<MessageEntry, "seq" | "timestamp"> => ({
  id,
  parentId,
  type: "message",
  message: { role: "user", content: [{ type: "text", text }], timestamp: 0 },
});

const usageOf = (input: number, output: number): Usage => ({
  ...emptyUsage(),
  input,
  output,
  totalTokens: input + output,
});

const usageRow = (
  id: string,
  input: number,
  output: number,
  entryId?: string,
) => ({
  id,
  usage: usageOf(input, output),
  adjustment: false,
  ...(entryId === undefined ? {} : { entryId }),
});

const entryIds = (entries: { id: string }[]): string[] =>
  entries.map((entry) => entry.id);

/** Run the shared checks against a backend. */
export function storageContract(
  name: string,
  factory: StorageFactory,
  options: StorageContractOptions = {},
): void {
  describe(`StorageService contract — ${name}`, () => {
    it("commits are atomic batches and assign increasing seqs", async () => {
      const handle = await factory();
      const first = await handle.storage.commit([
        { kind: "entry", entry: messageEntry("a", "first") },
        { kind: "entry", entry: messageEntry("b", "second", "a") },
      ]);
      expect(first.seqs).toHaveLength(2);
      expect(first.seqs[0]).toBe(first.firstSeq);
      expect(first.seqs[1]).toBe(first.firstSeq + 1);

      const second = await handle.storage.commit([
        { kind: "entry", entry: messageEntry("c", "third", "b") },
      ]);
      expect(second.firstSeq).toBeGreaterThan(first.seqs[1]!);
      await handle.dispose();
    });

    it("getEntries returns exactly the requested entries", async () => {
      const handle = await factory();
      await handle.storage.commit([
        { kind: "entry", entry: messageEntry("a", "one") },
        { kind: "entry", entry: messageEntry("b", "two", "a") },
      ]);
      const found = await handle.storage.getEntries(["b", "missing"]);
      expect([...found.keys()]).toEqual(["b"]);
      const entry = found.get("b")!;
      expect(entry.parentId).toBe("a");
      expect(entry.seq).toBeGreaterThan(0);
      expect(entry.timestamp).toBeGreaterThan(0);
      await handle.dispose();
    });

    it("values are namespaced, overwritten by key, and prefix-scannable", async () => {
      const handle = await factory();
      await handle.storage.commit([
        setValue(value<string>("session.model"), "k3"),
        setValue(value<string>("session.meta", "cwd"), "/tmp"),
        setValue(value<string>("session.meta", "name"), "alpha"),
        setValue(value<number>("other"), 1),
      ]);
      expect(
        (await handle.storage.getValue(value<string>("session.meta", "cwd")))
          ?.value,
      ).toBe("/tmp");

      await handle.storage.commit([
        setValue(value<string>("session.meta", "name"), "beta"),
      ]);
      expect(
        (await handle.storage.getValue(value<string>("session.meta", "name")))
          ?.value,
      ).toBe("beta");

      const listed = await handle.storage.listValues(
        value<unknown>("session.meta"),
      );
      expect(listed.map((stored) => stored.address.key).sort()).toEqual([
        "cwd",
        "name",
      ]);

      await handle.storage.commit([
        { kind: "value", op: "delete", namespace: "session.meta", key: "cwd" },
      ]);
      expect(
        await handle.storage.getValue(value<string>("session.meta", "cwd")),
      ).toBeUndefined();
      await handle.dispose();
    });

    it("usage rows accumulate into stats; a repeated id is a correction", async () => {
      const handle = await factory();
      await handle.storage.commit([
        { kind: "usage", row: usageRow("u1", 100, 50) },
      ]);
      await handle.storage.commit([
        { kind: "usage", row: usageRow("u2", 200, 80) },
      ]);
      let stats = await handle.storage.getStats();
      expect(stats.usage.input).toBe(300);
      expect(stats.usage.output).toBe(130);

      // Same id, restated usage: the totals move by the delta, not by the row.
      await handle.storage.commit([
        {
          kind: "usage",
          row: { ...usageRow("u2", 220, 80), adjustment: true },
        },
      ]);
      stats = await handle.storage.getStats();
      expect(stats.usage.input).toBe(320);
      await handle.dispose();
    });

    it("stats count message entries and not other kinds", async () => {
      const handle = await factory();
      await handle.storage.commit([
        { kind: "entry", entry: messageEntry("m1", "hello") },
        {
          kind: "entry",
          entry: {
            id: "g1",
            parentId: "m1",
            type: "goal",
            payload: { kind: "set", objective: "x" },
          },
        } as StorageWrite,
      ]);
      const stats = await handle.storage.getStats();
      expect(stats.messageCount).toBe(1);
      await handle.dispose();
    });

    it("scanEntries filters by type and seq range, in either order", async () => {
      const handle = await factory();
      const a = await handle.storage.commit([
        { kind: "entry", entry: messageEntry("a", "one") },
      ]);
      const b = await handle.storage.commit([
        { kind: "entry", entry: messageEntry("b", "two", "a") },
        {
          kind: "entry",
          entry: {
            id: "g",
            parentId: "b",
            type: "goal",
            payload: { kind: "set", objective: "x" },
          },
        } as StorageWrite,
      ]);
      const all = await handle.storage.scanEntries({});
      expect(entryIds(all)).toEqual(["a", "b", "g"]);

      const messages = await handle.storage.scanEntries({
        type: "message",
        order: "desc",
      });
      expect(entryIds(messages)).toEqual(["b", "a"]);

      const ranged = await handle.storage.scanEntries({
        fromSeq: b.firstSeq,
        order: "asc",
      });
      expect(entryIds(ranged)).toEqual(["b", "g"]);
      expect(a.firstSeq).toBeGreaterThan(0);
      await handle.dispose();
    });

    it("scanUsage respects seq ranges and order", async () => {
      const handle = await factory();
      await handle.storage.commit([
        { kind: "usage", row: usageRow("u1", 1, 1) },
      ]);
      await handle.storage.commit([
        { kind: "usage", row: usageRow("u2", 2, 2) },
      ]);
      const asc = await handle.storage.scanUsage({});
      expect(asc.map((row) => row.id)).toEqual(["u1", "u2"]);
      const desc = await handle.storage.scanUsage({ order: "desc", limit: 1 });
      expect(desc.map((row) => row.id)).toEqual(["u2"]);
      await handle.dispose();
    });

    it("scanBranch walks the chain and splices merged chains in", async () => {
      const handle = await factory();
      await handle.storage.commit([
        { kind: "entry", entry: messageEntry("root", "shared") },
        { kind: "entry", entry: messageEntry("side", "side work", "root") },
        { kind: "entry", entry: messageEntry("main", "main work", "root") },
        {
          kind: "entry",
          entry: {
            id: "m",
            parentId: "main",
            type: "merge",
            mergedParentId: "side",
            summary: "merge",
          },
        } as StorageWrite,
      ]);
      const path = await handle.storage.scanBranch({
        start: "m",
        order: "oldestFirst",
      });
      expect(entryIds(path)).toEqual(["root", "main", "side", "m"]);

      const fromRoot = await handle.storage.scanBranch({
        start: "m",
        stopAtId: "side",
        order: "newestFirst",
      });
      expect(entryIds(fromRoot)).toEqual(["m", "side"]);
      await handle.dispose();
    });

    it("compactJournal preserves exactly the state a replay would produce", async () => {
      const handle = await factory();
      await handle.storage.commit([
        { kind: "entry", entry: messageEntry("a", "one") },
      ]);
      await handle.storage.commit([
        { kind: "entry", entry: messageEntry("b", "two", "a") },
      ]);
      await handle.storage.commit([
        { kind: "usage", row: usageRow("u1", 10, 5) },
      ]);
      await handle.storage.commit([setValue(value<string>("k"), "v1")]);
      await handle.storage.commit([setValue(value<string>("k"), "v2")]);
      await handle.storage.commit([setValue(value<string>("gone"), "x")]);
      await handle.storage.commit([
        { kind: "value", op: "delete", namespace: "k", key: "" },
      ]);
      await handle.storage.commit([setValue(value<string>("k"), "v3")]);

      const before = await handle.storage.scanEntries({});
      const beforeUsage = await handle.storage.scanUsage({});
      const beforeStats = await handle.storage.getStats();

      const result = await handle.storage.compactJournal();
      expect(result.rewritten).toBe(true);

      expect(entryIds(await handle.storage.scanEntries({}))).toEqual(
        entryIds(before),
      );
      expect((await handle.storage.scanUsage({})).map((row) => row.id)).toEqual(
        beforeUsage.map((row) => row.id),
      );
      expect(await handle.storage.getStats()).toEqual(beforeStats);
      expect((await handle.storage.getValue(value<string>("k")))?.value).toBe(
        "v3",
      );
      await handle.dispose();
    });

    if (options.persistent === true) {
      it("survives a reopen: everything committed is readable by a fresh handle", async () => {
        const handle = await factory();
        expect(
          handle.reopen,
          `${name}: a persistent backend must provide reopen()`,
        ).toBeDefined();
        await handle.storage.commit([
          { kind: "entry", entry: messageEntry("d", "survive me") },
        ]);
        await handle.storage.commit([
          { kind: "usage", row: usageRow("u", 7, 3) },
          setValue(value<string>("persisted"), "yes"),
        ]);
        await handle.storage.flush();
        await handle.dispose();

        const again = await handle.reopen!();
        const entries = await again.storage.scanEntries({});
        expect(entryIds(entries)).toEqual(["d"]);
        expect(
          (await again.storage.getValue(value<string>("persisted")))?.value,
        ).toBe("yes");
        expect((await again.storage.getStats()).usage.totalTokens).toBe(10);
        await again.dispose();
      });
    }

    it("is idempotent on close", async () => {
      const handle = await factory();
      await handle.storage.close();
      await handle.storage.close();
      await handle.dispose();
    });
  });
}
