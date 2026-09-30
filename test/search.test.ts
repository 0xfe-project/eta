/**
 * Search and history (S27).
 *
 * Both walk a session's *branch*, not its file: an entry the branch does not include is history the
 * user rewound past, and showing it would be showing something the session no longer says.
 *
 * The paging rule is the one worth being careful about — the cursor is a sequence number, exclusive,
 * and a page has to be the `limit` messages *before* it. An off-by-one there shows a duplicate row
 * at every page boundary, which is the kind of bug a reader notices and cannot explain.
 */
import type { Entry } from "@eta/core";
import { describe, expect, it } from "vitest";
import { branchMessages, firstHit, historyOf, messageText } from "../src/search";

/** A message entry, in the shape the journal holds. */
function message(id: string, seq: number, text: string, parentId: string | null): Entry {
	return {
		id,
		seq,
		parentId,
		timestamp: 1_000 + seq,
		type: "message",
		message: { role: "user", content: [{ type: "text", text }], timestamp: 1_000 + seq },
	} as Entry;
}

/** A chain of message entries with the given ids and texts, oldest first. */
function chain(texts: string[]): Entry[] {
	return texts.map((text, index) => message(`m${index}`, index + 1, text, index === 0 ? null : `m${index - 1}`));
}

describe("what a message says", () => {
	it("reads text blocks, and nothing else", () => {
		expect(messageText({ content: "plain" })).toBe("plain");
		expect(
			messageText({
				content: [
					{ type: "text", text: "a" },
					{ type: "image", data: "x" },
				],
			}),
		).toBe("a");
		// A tool call's arguments are JSON that would match every query about anything.
		expect(messageText({ content: [{ type: "toolCall", arguments: { query: "hello" } }] })).toBe("");
		expect(messageText({})).toBe("");
	});
});

describe("paging through history", () => {
	const entries = chain(["one", "two", "three", "four", "five"]);

	it("gives the newest page when there is no cursor", () => {
		const page = historyOf(entries, { limit: 2 });
		expect(page.map((row) => messageText(row.message))).toEqual(["four", "five"]);
	});

	it("gives the messages just before the cursor, exclusive", () => {
		// The cursor is the oldest sequence the client holds; the page is what precedes it.
		const page = historyOf(entries, { beforeSeq: 4, limit: 2 });
		expect(page.map((row) => messageText(row.message))).toEqual(["two", "three"]);
		expect(page.map((row) => row.seq)).toEqual([2, 3]);
	});

	it("does not repeat or skip a row across page boundaries", () => {
		// Page backwards to the beginning, the way a client that keeps scrolling does, and check
		// every message is seen exactly once and in order.
		const seen: string[] = [];
		let cursor: number | undefined;
		for (;;) {
			const page = historyOf(entries, { beforeSeq: cursor, limit: 2 });
			if (page.length === 0) break;
			seen.unshift(...page.map((row) => messageText(row.message)));
			cursor = page[0]?.seq;
			if (page.length < 2) break;
		}
		expect(seen).toEqual(["one", "two", "three", "four", "five"]);
	});

	it("gives everything older than the cursor when the page is bigger than what is left", () => {
		const page = historyOf(entries, { beforeSeq: 3, limit: 100 });
		expect(page.map((row) => messageText(row.message))).toEqual(["one", "two"]);
	});

	it("gives nothing when asked for a page before the beginning", () => {
		expect(historyOf(entries, { beforeSeq: 1, limit: 10 })).toEqual([]);
	});

	it("skips entries that are not messages, without letting them break a page", () => {
		const withGoal: Entry[] = [
			message("m1", 1, "first", null),
			{ id: "g1", seq: 2, parentId: "m1", timestamp: 1_002, type: "goal", payload: {} } as Entry,
			message("m2", 3, "second", "g1"),
		];
		// The page is two messages, and the goal entry between them is not one of them.
		expect(historyOf(withGoal, { limit: 2 }).map((row) => messageText(row.message))).toEqual(["first", "second"]);
		expect(branchMessages(withGoal)).toHaveLength(2);
	});
});

describe("finding a session that mentions something", () => {
	const entries = chain(["the wire is four words", "and the ring is 512 events"]);

	it("gives the first match with its surroundings", () => {
		const hit = firstHit("s1", entries, "ring");
		expect(hit).toMatchObject({ session: "s1", entryId: "m1", seq: 2 });
		expect(hit?.snippet).toContain("ring is 512 events");
	});

	it("is case-insensitive, and answers nothing for a query nobody says", () => {
		expect(firstHit("s1", entries, "WIRE")?.snippet).toContain("wire is four words");
		expect(firstHit("s1", entries, "nothing like this")).toBeUndefined();
		// An empty query is not a search: every message "matches".
		expect(firstHit("s1", entries, "   ")).toBeUndefined();
	});

	it("reports one hit per session, at the earliest match", () => {
		const options = chain(["the ring appears here", "and the ring again"]);
		expect(firstHit("s1", options, "ring")?.entryId).toBe("m0");
	});
});
