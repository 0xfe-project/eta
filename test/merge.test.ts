import { describe, expect, it } from "vitest";
import { forkChain } from "../src/session/fork.ts";
import { EntryGraph } from "../src/session/graph.ts";
import { mergeBranch, rollback } from "../src/session/merge.ts";
import type { MessageEntry, NewEntry } from "../src/types/entries.ts";

const msg = (text: string, parentId: string | null = null): NewEntry<MessageEntry> => ({
	id: crypto.randomUUID(),
	parentId,
	type: "message",
	message: { role: "user", content: [{ type: "text", text }], timestamp: 0 },
});

const texts = (graph: EntryGraph): string[] =>
	graph.pathOldestFirst().flatMap((entry) => {
		if (entry.type !== "message") return [];
		const message = (entry as MessageEntry).message;
		if (message.role !== "user" && message.role !== "assistant" && message.role !== "toolResult") return [];
		const content = message.content;
		return Array.isArray(content)
			? content.filter((c): c is { type: "text"; text: string } => c.type === "text").map((c) => c.text)
			: [];
	});

/** Adopt a forked chain into a fresh graph, keeping entry ids. */
function adopt(source: EntryGraph, options: Parameters<typeof forkChain>[1] = {}): EntryGraph {
	const dest = new EntryGraph();
	for (const entry of [...forkChain(source, options).entries].reverse()) dest.append(entry);
	return dest;
}

/**
 * The D4 flow from eta-agent: shared history -> fork -> work on both sides ->
 * merge -> rollback. Ported to the storage-agnostic graph.
 */
function d4() {
	const main = new EntryGraph();
	const shared = main.append(msg("shared history"));
	const side = adopt(main);
	const sideEntry = side.append(msg("side work"));
	const mainWork = main.append(msg("main work"));
	return { main, side, shared, sideEntry, mainWork };
}

describe("mergeBranch", () => {
	it("appends a merge entry whose chain joins at the common ancestor", () => {
		const { main, side, shared, sideEntry, mainWork } = d4();
		const result = mergeBranch(main, side, { summary: "merge side into main" });

		expect(result.entry.type).toBe("merge");
		expect(result.entry.parentId).toBe(mainWork.id);
		expect(result.entry.mergedParentId).toBe(sideEntry.id);
		expect(result.commonAncestorId).toBe(shared.id);
		expect(result.copiedIds).toEqual([sideEntry.id]);

		// Exactly the order eta-agent's backends produced.
		expect(main.pathOldestFirst().map((entry) => entry.id)).toEqual([
			shared.id,
			mainWork.id,
			sideEntry.id,
			result.entry.id,
		]);
		expect(texts(main)).toEqual(["shared history", "main work", "side work"]);
	});

	it("copies the side-only prefix, oldest first, without moving the view early", () => {
		const main = new EntryGraph();
		const shared = main.append(msg("shared history"));
		const side = adopt(main);
		const s1 = side.append(msg("side 1"));
		const s2 = side.append(msg("side 2"));
		main.append(msg("main work"));

		const result = mergeBranch(main, side, { summary: "two side entries" });
		expect(result.copiedIds).toEqual([s1.id, s2.id]);
		expect(result.commonAncestorId).toBe(shared.id);
		expect(main.byId(s1.id)?.parentId).toBe(shared.id);
		expect(main.byId(s2.id)?.parentId).toBe(s1.id);
		expect(texts(main)).toEqual(["shared history", "main work", "side 1", "side 2"]);
	});

	it("merges a branch that never shared an entry", () => {
		const main = new EntryGraph();
		const m = main.append(msg("main work"));
		const side = new EntryGraph();
		side.append(msg("independent work"));

		const result = mergeBranch(main, side, { summary: "unrelated branch" });
		expect(result.commonAncestorId).toBeNull();
		expect(texts(main)).toEqual(["main work", "independent work"]);
		expect(main.byId(result.entry.id)?.parentId).toBe(m.id);
	});

	it("rejects merging into itself, an empty source, and a double merge", () => {
		const { main, side } = d4();
		expect(() => mergeBranch(main, main, { summary: "self" })).toThrow("cannot merge into itself");

		const empty = new EntryGraph();
		expect(() => mergeBranch(main, empty, { summary: "nothing" })).toThrow("source branch is empty");

		mergeBranch(main, side, { summary: "first" });
		expect(() => mergeBranch(main, side, { summary: "again" })).toThrow("already merged");
	});

	it("rejects a side entry whose id is already taken in the target graph", () => {
		// Rollback keeps history, so an id can linger in the graph off-path; a side
		// branch reusing it would silently overwrite. Copying must refuse instead.
		const main = new EntryGraph();
		const shared = main.append(msg("shared history"));
		const stale = main.append({ ...msg("discarded work"), id: "reused-id" });
		rollback(main, shared.id);
		expect(main.byId(stale.id)).toBeDefined();

		const side = adopt(main);
		side.append({ ...msg("side work"), id: "reused-id" });
		expect(() => mergeBranch(main, side, { summary: "colliding" })).toThrow("already exists in the target");
	});

	it("a merged branch can keep working and be merged again later", () => {
		const { main, side } = d4();
		mergeBranch(main, side, { summary: "first" });
		const after = main.append(msg("post-merge work"));
		expect(main.tipId()).toBe(after.id);
		expect(texts(main)).toEqual(["shared history", "main work", "side work", "post-merge work"]);
	});
});

describe("rollback", () => {
	it("moves the branch view back, keeping the entry and the discarded history", () => {
		const { main, side, shared, sideEntry, mainWork } = d4();
		const merge = mergeBranch(main, side, { summary: "merge side into main" });

		const result = rollback(main, mainWork.id);
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("unreachable");
		expect(result.entryId).toBe(mainWork.id);
		expect(result.droppedIds.sort()).toEqual([merge.entry.id, sideEntry.id].sort());

		expect(main.pathOldestFirst().map((entry) => entry.id)).toEqual([shared.id, mainWork.id]);
		// Dropped from the path, not deleted: the graph still holds them.
		expect(main.byId(merge.entry.id)).toBeDefined();
		expect(main.byId(sideEntry.id)).toBeDefined();
	});

	it("continues from the rolled-back tip instead of the old head", () => {
		const { main, side, mainWork } = d4();
		mergeBranch(main, side, { summary: "merge side into main" });
		rollback(main, mainWork.id);
		const next = main.append(msg("second try"));
		expect(next.parentId).toBe(mainWork.id);
		expect(texts(main)).toEqual(["shared history", "main work", "second try"]);
	});

	it("rolling back to a merge entry keeps the merged chain visible", () => {
		const { main, side } = d4();
		const merge = mergeBranch(main, side, { summary: "merge side into main" });
		main.append(msg("post-merge work"));

		const result = rollback(main, merge.entry.id);
		expect(result.ok).toBe(true);
		expect(texts(main)).toEqual(["shared history", "main work", "side work"]);
	});

	it("refuses entries that are unknown or off the current branch", () => {
		const { main, side, sideEntry } = d4();
		const unknown = rollback(main, "ghost");
		expect(unknown.ok).toBe(false);
		if (unknown.ok) throw new Error("unreachable");
		expect(unknown.reason).toContain("unknown entry");

		mergeBranch(main, side, { summary: "merge" });
		const offBranch = rollback(main, sideEntry.id);
		expect(offBranch.ok).toBe(false);
		if (offBranch.ok) throw new Error("unreachable");
		expect(offBranch.reason).toContain("not on the current branch");
	});
});

describe("fork -> merge -> rollback as one chain", () => {
	it("the whole session lifecycle reads the same at every step", () => {
		const main = new EntryGraph();
		const shared = main.append(msg("shared history"));

		// Fork at the tip, work on both sides.
		const side = adopt(main);
		side.append(msg("side work"));
		main.append(msg("main work"));

		// A fork of the *side* branch is a session of its own, no back-pointer.
		const sideFork = adopt(side);
		expect(sideFork.pathOldestFirst().length).toBe(2);

		mergeBranch(main, side, { summary: "merge side into main" });
		expect(texts(main)).toEqual(["shared history", "main work", "side work"]);

		// Undo everything back to the shared root, then redo on a fresh fork.
		const rolled = rollback(main, shared.id);
		expect(rolled.ok).toBe(true);
		expect(texts(main)).toEqual(["shared history"]);

		const side2 = adopt(main);
		side2.append(msg("side work, take two"));
		main.append(msg("main work, take two"));
		mergeBranch(main, side2, { summary: "merge side2 into main" });
		expect(texts(main)).toEqual(["shared history", "main work, take two", "side work, take two"]);
	});
});
