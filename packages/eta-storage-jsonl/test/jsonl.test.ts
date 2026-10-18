import type { MessageEntry } from "@eta/core/session";
import type { StorageService } from "@eta/core/storage";
import type { JsonlStorageOptions } from "../src/index";
import {
  mkdtemp,
  open,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { storageContract } from "@eta/core/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { JsonlStorage } from "../src/index";

let dir = "";
let counter = 0;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "eta-journal-"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

function nextPath(name: string): string {
  counter += 1;
  return join(dir, `${name}-${counter}.jsonl`);
}

interface Handle {
  storage: JsonlStorage;
  dispose: () => Promise<void>;
  reopen: () => Promise<Handle>;
}

async function openStorage(
  path: string,
  options: JsonlStorageOptions = {},
): Promise<Handle> {
  const storage = await JsonlStorage.open(path, options);
  const handle: Handle = {
    storage,
    dispose: async () => void (await storage.close()),
    reopen: async () => openStorage(path, options),
  };
  return handle;
}

function messageEntry(
  id: string,
  text: string,
  parentId: string | null = null,
): Omit<MessageEntry, "seq" | "timestamp"> {
  return {
    id,
    parentId,
    type: "message",
    message: { role: "user", content: [{ type: "text", text }], timestamp: 0 },
  };
}

const readText = (path: string) => readFile(path, "utf8");
const jsonLines = (raw: string) =>
  raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map(
      (line) =>
        JSON.parse(line) as {
          w: { kind: string; entry?: { id: string } }[];
          t: number;
        },
    );

describe("jsonlStorage — the shared contract", () => {
  storageContract(
    "jsonl",
    async () => {
      const handle = await openStorage(nextPath("contract"));
      return {
        storage: handle.storage as StorageService,
        dispose: handle.dispose,
        reopen: async () => {
          const again = await handle.reopen();
          return {
            storage: again.storage as StorageService,
            dispose: again.dispose,
            reopen: again.reopen,
          };
        },
      };
    },
    { persistent: true },
  );
});

describe("jsonlStorage — the journal on disk", () => {
  it("writes eta-agent journal lines: one {w, t} object per commit", async () => {
    const path = nextPath("lines");
    const { storage, dispose } = await openStorage(path);
    await storage.commit([
      { kind: "entry", entry: messageEntry("a", "first") },
    ]);
    await storage.commit([
      { kind: "entry", entry: messageEntry("b", "second", "a") },
      {
        kind: "value",
        op: "set",
        namespace: "session.model",
        key: "",
        value: "k3",
      },
    ]);
    await dispose();

    const lines = jsonLines(await readText(path));
    expect(lines).toHaveLength(2);
    expect(lines[0]!.w[0]!.kind).toBe("entry");
    expect(lines[0]!.w[0]!.entry!.id).toBe("a");
    expect(lines[1]!.w.map((w) => w.kind)).toEqual(["entry", "value"]);
    expect(lines.every((line) => typeof line.t === "number")).toBe(true);
  });

  it("commits survive a reopen in the exact order they were made", async () => {
    const path = nextPath("order");
    const first = await openStorage(path);
    await first.storage.commit([
      { kind: "entry", entry: messageEntry("a", "one") },
    ]);
    await first.storage.commit([
      { kind: "entry", entry: messageEntry("b", "two", "a") },
    ]);
    await first.dispose();

    const second = await openStorage(path);
    await second.storage.commit([
      { kind: "entry", entry: messageEntry("c", "three", "b") },
    ]);
    await second.dispose();

    const third = await openStorage(path);
    const entries = await third.storage.scanEntries({});
    expect(entries.map((entry) => entry.id)).toEqual(["a", "b", "c"]);
    // Sequence numbers are rebuilt in the same relative order.
    expect(entries[0]!.seq).toBeLessThan(entries[1]!.seq);
    expect(entries[1]!.seq).toBeLessThan(entries[2]!.seq);
    await third.dispose();
  });
});

describe("jsonlStorage — torn tail repair", () => {
  it("cuts a half-written last line and the cut reaches the disk", async () => {
    const path = nextPath("torn");
    const good = `${JSON.stringify({ w: [{ kind: "entry", entry: messageEntry("a", "committed") }], t: 1 })}\n`;
    // A process died with a third of a line in flight.
    const torn = `{"w":[{"kind":"entry","entry":{"id":"b"`;
    await writeFile(path, `${good}${torn}`, "utf8");

    const warnings: string[] = [];
    const handle = await openStorage(path, {
      warn: (message) => warnings.push(message),
    });
    expect(warnings.join(" ")).toContain("1 unreadable line(s)");
    // Loading reports the damage; it does not silently drop the good part.
    expect(
      (await handle.storage.scanEntries({})).map((entry) => entry.id),
    ).toEqual(["a"]);

    const repaired = await handle.storage.repairTornTail();
    expect(repaired).toEqual({
      droppedBytes: torn.length,
      droppedRecords: 1,
      trailingOnly: true,
    });
    expect(await readText(path)).toBe(good);

    // The repair is durable: a fresh handle reads a clean journal, and the
    // journal continues from there.
    const again = await handle.reopen();
    expect((await again.storage.repairTornTail()).droppedRecords).toBe(0);
    await again.storage.commit([
      { kind: "entry", entry: messageEntry("c", "after repair", "a") },
    ]);
    await again.dispose();

    const third = await openStorage(path);
    expect(
      (await third.storage.scanEntries({})).map((entry) => entry.id),
    ).toEqual(["a", "c"]);
    await third.dispose();
  });

  it("steps over a hole in the middle instead of deleting the history behind it", async () => {
    const path = nextPath("hole");
    const lines = [
      JSON.stringify({
        w: [{ kind: "entry", entry: messageEntry("a", "before") }],
        t: 1,
      }),
      `{{{ not json`,
      JSON.stringify({
        w: [{ kind: "entry", entry: messageEntry("b", "after") }],
        t: 2,
      }),
    ].join("\n");
    await writeFile(path, `${lines}\n`, "utf8");

    const handle = await openStorage(path);
    // Everything that parses is replayed, including what sits behind the hole.
    expect(
      (await handle.storage.scanEntries({})).map((entry) => entry.id),
    ).toEqual(["a", "b"]);

    const repaired = await handle.storage.repairTornTail();
    expect(repaired.trailingOnly).toBe(false);
    expect(repaired.droppedRecords).toBe(1);

    const raw = await readText(path);
    expect(raw).toContain('"a"');
    expect(raw).toContain('"b"');
    expect(raw).not.toContain("not json");
    await handle.dispose();
  });

  it("treats a parsed line without usable writes as damage", async () => {
    const path = nextPath("shape");
    await writeFile(
      path,
      `{"w":"nope","t":1}\n${JSON.stringify({ w: [{ kind: "entry", entry: messageEntry("a", "ok") }], t: 2 })}\n`,
      "utf8",
    );
    const handle = await openStorage(path);
    const repaired = await handle.storage.repairTornTail();
    expect(repaired.droppedRecords).toBe(1);
    expect(repaired.trailingOnly).toBe(false);
    expect(
      (await handle.storage.scanEntries({})).map((entry) => entry.id),
    ).toEqual(["a"]);
    await handle.dispose();
  });

  it("leaves an unreadable tail alone when another writer is already past it", async () => {
    const path = nextPath("concurrent");
    const good = `${JSON.stringify({ w: [{ kind: "entry", entry: messageEntry("a", "committed") }], t: 1 })}\n`;
    await writeFile(path, `${good}garbage`, "utf8");
    const handle = await openStorage(path);
    // Someone else grew the file between the read and the repair.
    await writeFile(path, `${good}garbage${good}`, "utf8");
    const repaired = await handle.storage.repairTornTail();
    expect(repaired).toEqual({
      droppedBytes: 0,
      droppedRecords: 0,
      trailingOnly: true,
    });
    expect(await readText(path)).toBe(`${good}garbage${good}`);
    await handle.dispose();
  });

  it("repairs a file that only ever held garbage", async () => {
    const path = nextPath("garbage");
    await writeFile(path, "half a line, no json", "utf8");
    const handle = await openStorage(path);
    const repaired = await handle.storage.repairTornTail();
    expect(repaired.droppedRecords).toBe(1);
    expect(repaired.trailingOnly).toBe(true);
    expect(await readText(path)).toBe("");
    await handle.dispose();
  });
});

describe("jsonlStorage — compaction", () => {
  it("rewrites the journal so a replay yields exactly the same state", async () => {
    const path = nextPath("compact");
    const handle = await openStorage(path);
    await handle.storage.commit([
      { kind: "entry", entry: messageEntry("a", "one") },
    ]);
    await handle.storage.commit([
      { kind: "entry", entry: messageEntry("b", "two", "a") },
    ]);
    await handle.storage.commit([
      {
        kind: "usage",
        row: { id: "u1", usage: usageOf(10, 5), adjustment: false },
      },
      { kind: "value", op: "set", namespace: "model", key: "", value: "first" },
    ]);
    await handle.storage.commit([
      {
        kind: "value",
        op: "set",
        namespace: "model",
        key: "",
        value: "second",
      },
    ]);
    await handle.storage.commit([
      {
        kind: "value",
        op: "set",
        namespace: "temp",
        key: "",
        value: "gone soon",
      },
    ]);
    await handle.storage.commit([
      { kind: "value", op: "delete", namespace: "temp", key: "" },
    ]);

    const result = await handle.storage.compactJournal();
    expect(result.rewritten).toBe(true);
    expect(result.afterBytes).toBeLessThan(result.beforeBytes);

    const raw = await readText(path);
    expect(raw).not.toContain('"first"');
    expect(raw).not.toContain("gone soon");
    expect(raw).not.toContain('"temp"');
    const lines = jsonLines(raw);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.w.map((w) => w.kind)).toEqual([
      "entry",
      "entry",
      "usage",
      "value",
    ]);
    await handle.dispose();

    // And the compacted file replays identically from a cold start.
    const again = await openStorage(path);
    expect(
      (await again.storage.scanEntries({})).map((entry) => entry.id),
    ).toEqual(["a", "b"]);
    expect((await again.storage.getStats()).usage.totalTokens).toBe(15);
    expect(
      (
        await again.storage.getValue({
          kind: "value",
          namespace: "model",
          key: "",
        })
      )?.value,
    ).toBe("second");
    await again.dispose();
  });

  it("swaps atomically and leaves no temp files behind", async () => {
    const path = nextPath("atomic");
    const handle = await openStorage(path);
    await handle.storage.commit([
      { kind: "entry", entry: messageEntry("a", "one") },
    ]);
    await handle.storage.commit([
      { kind: "value", op: "set", namespace: "k", key: "", value: "v" },
    ]);
    await handle.storage.compactJournal();
    await handle.dispose();

    const siblings = await readdir(dir);
    expect(siblings.filter((name) => name.includes(".tmp-"))).toEqual([]);
  });

  it("compacts on load once the journal passes the threshold", async () => {
    const path = nextPath("compact-load");
    const lines: string[] = [];
    for (let i = 0; i < 40; i += 1) {
      lines.push(
        JSON.stringify({
          w: [
            {
              kind: "entry",
              entry: messageEntry(`m${i}`, `message ${i}`.repeat(20)),
            },
          ],
          t: i,
        }),
      );
      lines.push(
        JSON.stringify({
          w: [
            {
              kind: "value",
              op: "set",
              namespace: "churn",
              key: "",
              value: `${i}${"x".repeat(200)}`,
            },
          ],
          t: i,
        }),
      );
    }
    const before = `${lines.join("\n")}\n`;
    await writeFile(path, before, "utf8");

    const handle = await openStorage(path, {
      compactOnLoad: true,
      compactMinBytes: 2048,
    });
    const after = await readText(path);
    expect(after.length).toBeLessThan(before.length);
    // Values collapse to the one that is alive.
    expect(
      (
        (
          await handle.storage.getValue({
            kind: "value",
            namespace: "churn",
            key: "",
          })
        )?.value as string
      ).startsWith("39"),
    ).toBe(true);
    expect(await handle.storage.scanEntries({})).toHaveLength(40);
    await handle.dispose();
  });

  it("declines to rewrite a journal that is already empty", async () => {
    const handle = await openStorage(nextPath("compact-empty"));
    const result = await handle.storage.compactJournal();
    expect(result.rewritten).toBe(false);
    expect(result.reason).toBe("empty journal");
    await handle.dispose();
  });
});

function usageOf(input: number, output: number) {
  return {
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: input + output,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

describe("jsonlStorage — fsync discipline", () => {
  /**
   * "Repaired" that lives only in this process's page cache is not a repair:
   * the next boot fails the same way. Count the actual sync calls.
   */
  async function withSyncCounting<T>(
    run: (syncs: () => number) => Promise<T>,
  ): Promise<T> {
    // Bun does not name the class in the module namespace, and the types only
    // carry the interface — take the prototype off a real handle.
    const probe = await open(join(dir, "sync-probe"), "w");
    const handlePrototype = Object.getPrototypeOf(probe) as {
      sync: () => Promise<void>;
    };
    const original = handlePrototype.sync;
    let count = 0;
    handlePrototype.sync = async function patched(this: {
      sync: () => Promise<void>;
    }) {
      count += 1;
      return original.call(this);
    };
    try {
      return await run(() => count);
    } finally {
      handlePrototype.sync = original;
      await probe.close();
    }
  }

  it("fsyncs every commit by default", async () => {
    const path = nextPath("sync-append");
    await withSyncCounting(async (syncs) => {
      const handle = await openStorage(path);
      const before = syncs();
      await handle.storage.commit([
        { kind: "entry", entry: messageEntry("a", "durable") },
      ]);
      expect(syncs()).toBeGreaterThan(before);
      // Buffered mode is the caller's bet, and then flush() pays for it.
      const buffered = await openStorage(nextPath("sync-buffered"), {
        fsyncOnCommit: false,
      });
      const beforeBuffered = syncs();
      await buffered.storage.commit([
        { kind: "entry", entry: messageEntry("b", "maybe lost") },
      ]);
      expect(syncs()).toBe(beforeBuffered);
      await buffered.storage.flush();
      expect(syncs()).toBeGreaterThan(beforeBuffered);
      await buffered.dispose();
      await handle.dispose();
    });
  });

  it("fsyncs the torn-tail cut, so the next boot sees a clean journal", async () => {
    const path = nextPath("sync-repair");
    const good = `${JSON.stringify({ w: [{ kind: "entry", entry: messageEntry("a", "committed") }], t: 1 })}\n`;
    await writeFile(path, `${good}torn`, "utf8");
    await withSyncCounting(async (syncs) => {
      const handle = await openStorage(path);
      const before = syncs();
      await handle.storage.repairTornTail();
      expect(syncs()).toBeGreaterThan(before);
      await handle.dispose();
    });
  });

  it("fsyncs the compacted journal before renaming it into place", async () => {
    const path = nextPath("sync-compact");
    await withSyncCounting(async (syncs) => {
      const handle = await openStorage(path);
      await handle.storage.commit([
        { kind: "entry", entry: messageEntry("a", "one") },
      ]);
      await handle.storage.commit([
        { kind: "value", op: "set", namespace: "k", key: "", value: "v" },
      ]);
      const before = syncs();
      await handle.storage.compactJournal();
      // Once for the temp journal, once for the directory holding the rename.
      expect(syncs() - before).toBeGreaterThanOrEqual(2);
      await handle.dispose();
    });
  });
});

describe("jsonlStorage — lifecycle", () => {
  it("refuses writes after close and is idempotent", async () => {
    const handle = await openStorage(nextPath("closed"));
    await handle.storage.close();
    await handle.storage.close();
    await expect(handle.storage.commit([])).rejects.toThrow("closed");
  });

  it("starts a journal that does not exist yet", async () => {
    const path = nextPath("fresh");
    const handle = await openStorage(path);
    expect(await handle.storage.repairTornTail()).toEqual({
      droppedBytes: 0,
      droppedRecords: 0,
      trailingOnly: true,
    });
    await handle.storage.commit([
      { kind: "entry", entry: messageEntry("a", "first") },
    ]);
    await handle.dispose();
    expect(jsonLines(await readText(path))).toHaveLength(1);
  });
});
