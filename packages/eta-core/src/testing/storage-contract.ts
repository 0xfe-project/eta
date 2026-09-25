/**
 * The StorageService contract suite (REFACTOR.md §K5).
 *
 * Every backend — memory, JSONL, whatever comes next — must pass the same
 * behavioural checks. Backends with extra guarantees (crash durability, torn
 * tails) add their own suites on top; they do not get to skip these.
 */
import { describe, expect, it } from "vitest";
import type { StorageService } from "../storage/types.ts";
import type { Entry, MessageEntry } from "../types/entries.ts";

export interface StorageContractHandle {
	storage: StorageService;
	/** Release the handle. */
	dispose: () => Promise<void>;
	/**
	 * Optional: open the same backing store again from scratch. Provided by
	 * persistent backends; the suite then checks that what was written is
	 * actually readable by a fresh process.
	 */
	reopen?: () => Promise<StorageContractHandle>;
}

export type StorageFactory = () => Promise<StorageContractHandle>;

export interface StorageContractOptions {
	/**
	 * Set for backends that persist: the suite then requires `reopen` and checks
	 * that a fresh handle sees what the old one wrote.
	 */
	persistent?: boolean;
}

/** Storage stores what the graph produced: a settled entry, sequence included. */
let seq = 0;
const messageEntry = (id: string, text: string, parentId: string | null = null): MessageEntry => ({
	id,
	parentId,
	type: "message",
	seq: (seq += 1),
	timestamp: 0,
	message: { role: "user", content: [{ type: "text", text }], timestamp: 0 },
});

const entryIds = (entries: Entry[]): string[] => entries.map((entry) => entry.id);

/** Run the shared checks against a backend. */
export function storageContract(name: string, factory: StorageFactory, options: StorageContractOptions = {}): void {
	describe(`StorageService contract — ${name}`, () => {
		it("appends and reads commits back in append order", async () => {
			const handle = await factory();
			const a = messageEntry("a", "first");
			const b = messageEntry("b", "second", "a");

			await handle.storage.append({ entries: [a] });
			await handle.storage.append({ entries: [b] });

			const journal = await handle.storage.readJournal();
			expect(journal).toHaveLength(2);
			expect(entryIds(journal[0]!.entries)).toEqual(["a"]);
			expect(entryIds(journal[1]!.entries)).toEqual(["b"]);
			expect(journal[1]!.entries[0]!.parentId).toBe("a");

			await handle.dispose();
		});

		it("keeps multi-entry commits atomic — one commit, ordered inside", async () => {
			const handle = await factory();
			await handle.storage.append({
				entries: [messageEntry("x", "ask"), messageEntry("y", "answer", "x")],
			});
			const journal = await handle.storage.readJournal();
			expect(journal).toHaveLength(1);
			expect(entryIds(journal[0]!.entries)).toEqual(["x", "y"]);
			await handle.dispose();
		});

		it("stores KV state, overwrites it, and removes it", async () => {
			const handle = await factory();
			await handle.storage.set("session.model", "pro6000/k3");
			expect(await handle.storage.get("session.model")).toBe("pro6000/k3");

			await handle.storage.set("session.model", "pro6000/gpt");
			expect(await handle.storage.get("session.model")).toBe("pro6000/gpt");

			await handle.storage.set("session.cwd", "/tmp");
			expect((await handle.storage.keys()).sort()).toEqual(["session.cwd", "session.model"]);

			await handle.storage.remove("session.cwd");
			expect(await handle.storage.get("session.cwd")).toBeUndefined();
			expect(await handle.storage.keys()).toEqual(["session.model"]);

			expect(await handle.storage.get("never/written")).toBeUndefined();
			await handle.dispose();
		});

		it("applies values that ride along with a commit", async () => {
			const handle = await factory();
			await handle.storage.append({
				entries: [messageEntry("g", "goal set")],
				values: { "goal.objective": "ship K5", "goal.status": "active" },
			});
			expect(await handle.storage.get("goal.objective")).toBe("ship K5");
			expect(await handle.storage.get("goal.status")).toBe("active");

			await handle.storage.append({ entries: [], values: { "goal.status": "achieved" } });
			expect(await handle.storage.get("goal.status")).toBe("achieved");
			await handle.dispose();
		});

		it("keeps KV and entries side by side without confusing them", async () => {
			const handle = await factory();
			await handle.storage.set("notes", { text: "kv is not history" });
			await handle.storage.append({ entries: [messageEntry("m", "history")] });

			const journal = await handle.storage.readJournal();
			expect(journal.flatMap((commit) => commit.entries).map((entry) => entry.id)).toEqual(["m"]);
			expect(await handle.storage.get("notes")).toEqual({ text: "kv is not history" });
			await handle.dispose();
		});

		it("compactJournal preserves exactly the state a replay would produce", async () => {
			const handle = await factory();
			await handle.storage.append({ entries: [messageEntry("a", "one")] });
			await handle.storage.append({ entries: [messageEntry("b", "two", "a")] });
			await handle.storage.set("k", "v1");
			await handle.storage.set("k", "v2");
			await handle.storage.set("gone", "x");
			await handle.storage.remove("gone");

			const before = await handle.storage.readJournal();
			const beforeEntries = before.flatMap((commit) => commit.entries);
			const beforeKeys = (await handle.storage.keys()).sort();

			const result = await handle.storage.compactJournal();
			expect(result.rewritten).toBe(true);

			const after = await handle.storage.readJournal();
			const afterEntries = after.flatMap((commit) => commit.entries);
			expect(entryIds(afterEntries)).toEqual(entryIds(beforeEntries));
			expect(afterEntries.map((entry) => entry.type)).toEqual(beforeEntries.map((entry) => entry.type));
			expect((await handle.storage.keys()).sort()).toEqual(beforeKeys);
			expect(await handle.storage.get("k")).toBe("v2");
			expect(await handle.storage.get("gone")).toBeUndefined();
			await handle.dispose();
		});

		if (options.persistent === true) {
			it("survives a reopen: everything flushed is readable by a fresh handle", async () => {
				const handle = await factory();
				expect(handle.reopen, `${name}: a persistent backend must provide reopen()`).toBeDefined();
				await handle.storage.append({ entries: [messageEntry("d", "survive me")] });
				await handle.storage.set("persisted", { yes: true });
				await handle.storage.flush();
				await handle.dispose();

				const again = await handle.reopen!();
				const journal = await again.storage.readJournal();
				expect(journal.flatMap((commit) => commit.entries).map((entry) => entry.id)).toEqual(["d"]);
				expect(await again.storage.get("persisted")).toEqual({ yes: true });
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
