import { mkdtemp, open, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type MessageEntry, type StorageService, storageContract } from "@eta/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { JsonlStorage, type JsonlStorageOptions } from "../src/index.ts";

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

async function openStorage(path: string, options: JsonlStorageOptions = {}): Promise<Handle> {
	const storage = await JsonlStorage.open(path, options);
	const handle: Handle = {
		storage,
		dispose: async () => void (await storage.close()),
		reopen: async () => openStorage(path, options),
	};
	return handle;
}

let seq = 0;
function messageEntry(id: string, text: string, parentId: string | null = null): MessageEntry {
	seq += 1;
	return {
		id,
		parentId,
		type: "message",
		seq,
		timestamp: 0,
		message: { role: "user", content: [{ type: "text", text }], timestamp: 0 },
	};
}

const readText = (path: string) => readFile(path, "utf8");
const jsonLines = (raw: string) =>
	raw
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as { entries: { id: string }[]; values?: Record<string, unknown> });

describe("JsonlStorage — the shared contract", () => {
	storageContract(
		"jsonl",
		async () => {
			const handle = await openStorage(nextPath("contract"));
			return {
				storage: handle.storage as StorageService,
				dispose: handle.dispose,
				reopen: async () => {
					const again = await handle.reopen();
					return { storage: again.storage as StorageService, dispose: again.dispose, reopen: again.reopen };
				},
			};
		},
		{ persistent: true },
	);
});

describe("JsonlStorage — the journal on disk", () => {
	it("writes one inspectable JSON line per commit", async () => {
		const path = nextPath("lines");
		const { storage, dispose } = await openStorage(path);
		await storage.append({ entries: [messageEntry("a", "first")] });
		await storage.append({ entries: [messageEntry("b", "second", "a")], values: { "session.model": "k3" } });
		await dispose();

		const lines = jsonLines(await readText(path));
		expect(lines).toHaveLength(2);
		expect(lines[0]!.entries.map((entry) => entry.id)).toEqual(["a"]);
		expect(lines[1]!.entries.map((entry) => entry.id)).toEqual(["b"]);
		expect(await readText(path)).toContain("\n");
	});

	it("appends survive a reopen in the exact order they were made", async () => {
		const path = nextPath("order");
		const first = await openStorage(path);
		await first.storage.append({ entries: [messageEntry("a", "one")] });
		await first.storage.append({ entries: [messageEntry("b", "two", "a")] });
		await first.dispose();

		const second = await openStorage(path);
		await second.storage.append({ entries: [messageEntry("c", "three", "b")] });
		await second.dispose();

		const third = await openStorage(path);
		const ids = (await third.storage.readJournal()).flatMap((commit) => commit.entries.map((entry) => entry.id));
		expect(ids).toEqual(["a", "b", "c"]);
		expect(await third.storage.get("nothing")).toBeUndefined();
		await third.dispose();
	});
});

describe("JsonlStorage — torn tail repair", () => {
	it("cuts a half-written last line and the cut reaches the disk", async () => {
		const path = nextPath("torn");
		const good = `${JSON.stringify({ entries: [messageEntry("a", "committed")] })}\n`;
		// A process died with a third of a line in flight.
		const torn = `{"entries":[{"id":"b","par`;
		await writeFile(path, `${good}${torn}`, "utf8");

		const warnings: string[] = [];
		const handle = await openStorage(path, { warn: (message) => warnings.push(message) });
		expect(warnings.join(" ")).toContain("1 unreadable line(s)");
		// Loading reports the damage; it does not silently drop the good part.
		const ids = (await handle.storage.readJournal()).flatMap((commit) => commit.entries.map((e) => e.id));
		expect(ids).toEqual(["a"]);

		const repaired = await handle.storage.repairTornTail();
		expect(repaired).toEqual({ droppedBytes: torn.length, droppedRecords: 1, trailingOnly: true });
		expect(await readText(path)).toBe(good);

		// The repair is durable: a fresh handle reads a clean journal, and the
		// journal continues from there.
		const again = await handle.reopen();
		expect((await again.storage.repairTornTail()).droppedRecords).toBe(0);
		await again.storage.append({ entries: [messageEntry("c", "after repair", "a")] });
		await again.dispose();

		const third = await openStorage(path);
		expect((await third.storage.readJournal()).flatMap((commit) => commit.entries.map((entry) => entry.id))).toEqual([
			"a",
			"c",
		]);
		await third.dispose();
	});

	it("steps over a hole in the middle instead of deleting the history behind it", async () => {
		const path = nextPath("hole");
		const lines = [
			JSON.stringify({ entries: [messageEntry("a", "before")] }),
			`{{{ not json`,
			JSON.stringify({ entries: [messageEntry("b", "after")] }),
		].join("\n");
		await writeFile(path, `${lines}\n`, "utf8");

		const handle = await openStorage(path);
		// Everything that parses is replayed, including what sits behind the hole.
		const ids = (await handle.storage.readJournal()).flatMap((commit) => commit.entries.map((e) => e.id));
		expect(ids).toEqual(["a", "b"]);

		const repaired = await handle.storage.repairTornTail();
		expect(repaired.trailingOnly).toBe(false);
		expect(repaired.droppedRecords).toBe(1);

		const raw = await readText(path);
		expect(raw).toContain('"a"');
		expect(raw).toContain('"b"');
		expect(raw).not.toContain("not json");
		expect(jsonLines(raw).flatMap((commit) => commit.entries.map((entry) => entry.id))).toEqual(["a", "b"]);
		await handle.dispose();
	});

	it("treats a parsed line without a usable entries array as damage", async () => {
		const path = nextPath("shape");
		await writeFile(path, `{"entries":"nope"}\n${JSON.stringify({ entries: [messageEntry("a", "ok")] })}\n`, "utf8");
		const handle = await openStorage(path);
		const repaired = await handle.storage.repairTornTail();
		expect(repaired.droppedRecords).toBe(1);
		expect(repaired.trailingOnly).toBe(false);
		expect((await handle.storage.readJournal()).flatMap((commit) => commit.entries.map((entry) => entry.id))).toEqual(
			["a"],
		);
		await handle.dispose();
	});

	it("leaves an unreadable tail alone when another writer is already past it", async () => {
		const path = nextPath("concurrent");
		const good = `${JSON.stringify({ entries: [messageEntry("a", "committed")] })}\n`;
		await writeFile(path, `${good}garbage`, "utf8");
		const handle = await openStorage(path);
		// Someone else grew the file between the read and the repair.
		await writeFile(path, `${good}garbage${good}`, "utf8");
		const repaired = await handle.storage.repairTornTail();
		expect(repaired).toEqual({ droppedBytes: 0, droppedRecords: 0, trailingOnly: true });
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

describe("JsonlStorage — compaction", () => {
	it("rewrites the journal so a replay yields exactly the same state", async () => {
		const path = nextPath("compact");
		const handle = await openStorage(path);
		await handle.storage.append({ entries: [messageEntry("a", "one")] });
		await handle.storage.append({ entries: [messageEntry("b", "two", "a")] });
		await handle.storage.set("model", "first");
		await handle.storage.set("model", "second");
		await handle.storage.set("temp", "gone soon");
		await handle.storage.remove("temp");

		const before = await handle.storage.readJournal();
		const beforeIds = before.flatMap((commit) => commit.entries.map((entry) => entry.id));

		const result = await handle.storage.compactJournal();
		expect(result.rewritten).toBe(true);
		expect(result.afterBytes).toBeLessThan(result.beforeBytes);

		const raw = await readText(path);
		expect(raw).not.toContain("first");
		expect(raw).not.toContain("gone soon");
		const lines = jsonLines(raw);
		expect(lines.flatMap((commit) => commit.entries.map((entry) => entry.id))).toEqual(beforeIds);
		expect(lines[lines.length - 1]!.values).toEqual({ model: "second" });
		await handle.dispose();

		// And the compacted file replays identically from a cold start.
		const again = await openStorage(path);
		expect((await again.storage.readJournal()).flatMap((commit) => commit.entries.map((entry) => entry.id))).toEqual(
			beforeIds,
		);
		expect(await again.storage.get("model")).toBe("second");
		expect(await again.storage.keys()).toEqual(["model"]);
		await again.dispose();
	});

	it("swaps atomically and leaves no temp files behind", async () => {
		const path = nextPath("atomic");
		const handle = await openStorage(path);
		await handle.storage.append({ entries: [messageEntry("a", "one")] });
		await handle.storage.set("k", "v");
		await handle.storage.compactJournal();
		await handle.dispose();

		const siblings = await readdir(dir);
		expect(siblings.filter((name) => name.startsWith(`${path.split("/").pop()}tmp`))).toEqual([]);
		expect(siblings.filter((name) => name.includes(".tmp-"))).toEqual([]);
	});

	it("compacts on load once the journal passes the threshold", async () => {
		const path = nextPath("compact-load");
		const lines: string[] = [];
		for (let i = 0; i < 40; i += 1) {
			lines.push(JSON.stringify({ entries: [messageEntry(`m${i}`, `message ${i}`.repeat(20))] }));
			lines.push(JSON.stringify({ entries: [], values: { churn: `${i}${"x".repeat(200)}` } }));
		}
		const before = `${lines.join("\n")}\n`;
		await writeFile(path, before, "utf8");

		const handle = await openStorage(path, { compactOnLoad: true, compactMinBytes: 2048 });
		const after = await readText(path);
		expect(after.length).toBeLessThan(before.length);
		// Values collapse to the one that is alive.
		expect(((await handle.storage.get("churn")) as string).startsWith("39")).toBe(true);
		expect(
			(await handle.storage.readJournal()).flatMap((commit) => commit.entries.map((entry) => entry.id)),
		).toHaveLength(40);
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

describe("JsonlStorage — fsync discipline", () => {
	/**
	 * "Repaired" that lives only in this process's page cache is not a repair:
	 * the next boot fails the same way. Count the actual sync calls.
	 */
	async function withSyncCounting<T>(run: (syncs: () => number) => Promise<T>): Promise<T> {
		// Bun does not name the class in the module namespace, and the types only
		// carry the interface — take the prototype off a real handle.
		const probe = await open(join(dir, "sync-probe"), "w");
		const handlePrototype = Object.getPrototypeOf(probe) as { sync: () => Promise<void> };
		const original = handlePrototype.sync;
		let count = 0;
		handlePrototype.sync = async function patched(this: { sync: () => Promise<void> }) {
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

	it("fsyncs every append by default", async () => {
		const path = nextPath("sync-append");
		await withSyncCounting(async (syncs) => {
			const handle = await openStorage(path);
			const before = syncs();
			await handle.storage.append({ entries: [messageEntry("a", "durable")] });
			expect(syncs()).toBeGreaterThan(before);
			// Buffered mode is the caller's bet, and then flush() pays for it.
			const buffered = await openStorage(nextPath("sync-buffered"), { fsyncOnAppend: false });
			const beforeBuffered = syncs();
			await buffered.storage.append({ entries: [messageEntry("b", "maybe lost")] });
			expect(syncs()).toBe(beforeBuffered);
			await buffered.storage.flush();
			expect(syncs()).toBeGreaterThan(beforeBuffered);
			await buffered.dispose();
			await handle.dispose();
		});
	});

	it("fsyncs the torn-tail cut, so the next boot sees a clean journal", async () => {
		const path = nextPath("sync-repair");
		const good = `${JSON.stringify({ entries: [messageEntry("a", "committed")] })}\n`;
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
			await handle.storage.append({ entries: [messageEntry("a", "one")] });
			await handle.storage.set("k", "v");
			const before = syncs();
			await handle.storage.compactJournal();
			// Once for the temp journal, once for the directory holding the rename.
			expect(syncs() - before).toBeGreaterThanOrEqual(2);
			await handle.dispose();
		});
	});
});

describe("JsonlStorage — lifecycle", () => {
	it("refuses writes after close and is idempotent", async () => {
		const handle = await openStorage(nextPath("closed"));
		await handle.storage.close();
		await handle.storage.close();
		await expect(handle.storage.append({ entries: [] })).rejects.toThrow("closed");
		await expect(handle.storage.set("k", 1)).rejects.toThrow("closed");
	});

	it("starts a journal that does not exist yet", async () => {
		const path = nextPath("fresh");
		const handle = await openStorage(path);
		expect(await handle.storage.repairTornTail()).toEqual({ droppedBytes: 0, droppedRecords: 0, trailingOnly: true });
		await handle.storage.append({ entries: [messageEntry("a", "first")] });
		await handle.dispose();
		expect(jsonLines(await readText(path))).toHaveLength(1);
	});
});
