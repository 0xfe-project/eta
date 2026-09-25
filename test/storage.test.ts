import { describe, expect, it } from "vitest";
import { MemoryStorage, STORAGE_METHODS, storageContract } from "../src/index.ts";
import type { MessageEntry } from "../src/types/entries.ts";

describe("StorageService interface shape", () => {
	it("exposes exactly the agreed method surface", () => {
		expect([...STORAGE_METHODS].sort()).toMatchInlineSnapshot(`
			[
			  "append",
			  "close",
			  "compactJournal",
			  "flush",
			  "get",
			  "keys",
			  "readJournal",
			  "remove",
			  "repairTornTail",
			  "set",
			]
		`);
	});

	it("a commit is plain data — it round-trips through JSON unchanged", async () => {
		const commit = {
			entries: [
				{
					id: "e1",
					parentId: null,
					seq: 1,
					timestamp: 0,
					type: "message",
					message: { role: "user", content: [{ type: "text", text: "hi" }], timestamp: 0 },
				} satisfies MessageEntry,
			],
			values: { "session.model": "pro6000/k3" },
			deletes: ["stale"],
		};
		expect(JSON.parse(JSON.stringify(commit))).toEqual(commit);
		expect(Object.keys(commit).sort()).toMatchInlineSnapshot(`
			[
			  "deletes",
			  "entries",
			  "values",
			]
		`);
	});

	it("reports journal size, compaction outcome, and repair outcome as data", async () => {
		const storage = new MemoryStorage();
		await storage.append({ entries: [] });
		expect(storage.bytes()).toBeGreaterThan(0);

		const compacted = await storage.compactJournal();
		expect(Object.keys(compacted).sort()).toMatchInlineSnapshot(`
			[
			  "afterBytes",
			  "beforeBytes",
			  "rewritten",
			]
		`);

		const repaired = await storage.repairTornTail();
		expect(Object.keys(repaired).sort()).toMatchInlineSnapshot(`
			[
			  "droppedBytes",
			  "droppedRecords",
			  "trailingOnly",
			]
		`);
		await storage.close();
	});
});

// The shared behavioural suite: every backend runs the same checks.
storageContract("memory", async () => {
	const storage = new MemoryStorage();
	return { storage, dispose: async () => void (await storage.close()) };
});

describe("MemoryStorage specifics", () => {
	it("rejects writes after close", async () => {
		const storage = new MemoryStorage();
		await storage.close();
		await expect(storage.append({ entries: [] })).rejects.toThrow("closed");
		await expect(storage.set("k", 1)).rejects.toThrow("closed");
	});

	it("hands out copies, so a caller cannot edit the journal in place", async () => {
		const storage = new MemoryStorage();
		await storage.set("meta", { list: [1] });
		const journal = await storage.readJournal();
		journal.length = 0;
		expect(await storage.readJournal()).toHaveLength(1);

		const value = (await storage.get("meta")) as { list: number[] };
		value.list.push(2);
		expect(((await storage.get("meta")) as { list: number[] }).list).toEqual([1]);
		await storage.close();
	});
});
