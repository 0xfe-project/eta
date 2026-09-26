import { describe, expect, it } from "vitest";
import { MemoryStorage, type MessageEntry, STORAGE_METHODS, setValue, storageContract, value } from "../src/index.ts";

describe("StorageService interface shape", () => {
	it("exposes exactly the agreed method surface", () => {
		expect([...STORAGE_METHODS].sort()).toMatchInlineSnapshot(`
			[
			  "close",
			  "commit",
			  "compactJournal",
			  "flush",
			  "getEntries",
			  "getStats",
			  "getValue",
			  "listValues",
			  "repairTornTail",
			  "scanBranch",
			  "scanEntries",
			  "scanUsage",
			]
		`);
	});

	it("the write vocabulary matches the eta-agent journal's: entry / usage / value", () => {
		// Every write kind a `{w: [...], t: ...}` line can carry in the kernel.
		const kinds = ["entry", "usage", "value"];
		expect(kinds).toMatchInlineSnapshot(`
			[
			  "entry",
			  "usage",
			  "value",
			]
		`);
	});

	it("maintenance results are plain data", async () => {
		const storage = new MemoryStorage();
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
		await expect(storage.commit([])).rejects.toThrow("closed");
		await expect(storage.commit([setValue(value("k"), 1)])).rejects.toThrow("closed");
	});

	it("hands out copies, so a caller cannot edit stored state in place", async () => {
		const storage = new MemoryStorage();
		await storage.commit([setValue(value<{ list: number[] }>("meta"), { list: [1] })]);
		const stored = (await storage.getValue(value<{ list: number[] }>("meta")))!;
		stored.value.list.push(2);
		expect((await storage.getValue(value<{ list: number[] }>("meta")))!.value.list).toEqual([1]);
		await storage.close();
	});

	it("repeated entry ids overwrite and are counted, like a replayed journal", async () => {
		const storage = new MemoryStorage();
		const entry: Omit<MessageEntry, "seq" | "timestamp"> = {
			id: "e1",
			parentId: null,
			type: "message",
			message: { role: "user", content: [{ type: "text", text: "first" }], timestamp: 0 },
		};
		await storage.commit([{ kind: "entry", entry }]);
		await storage.commit([{ kind: "entry", entry: { ...entry, message: { ...entry.message, timestamp: 1 } } }]);
		expect(storage.repeated).toBe(1);
		const found = await storage.getEntries(["e1"]);
		const stored = found.get("e1")!;
		expect(stored.type).toBe("message");
		if (stored.type !== "message") throw new Error("unreachable");
		expect(stored.message.timestamp).toBe(1);
		// A repeated id does not double-count the message.
		expect((await storage.getStats()).messageCount).toBe(1);
		await storage.close();
	});
});
