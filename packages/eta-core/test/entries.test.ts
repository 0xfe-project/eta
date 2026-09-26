import { describe, expect, expectTypeOf, it } from "vitest";
import type { AnswerEntry, AskEntry, BtwEntry, Entry, GoalEntry, MergeEntry, MessageEntry } from "../src/types/entries";

function base(overrides: Partial<{ id: string; parentId: string | null; seq: number; timestamp: number }> = {}) {
	return { id: "e1", parentId: null, seq: 1, timestamp: 1_700_000_000_000, ...overrides };
}

describe("entry union", () => {
	it("every variant narrows on type and is constructible", () => {
		const message: MessageEntry = {
			...base(),
			type: "message",
			message: { role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1_700_000_000_000 },
		};
		expect(message.type).toBe("message");

		const goal: GoalEntry = { ...base(), type: "goal", payload: { kind: "set", objective: "ship it" } };
		if (goal.type !== "goal") throw new Error("narrowing failed");
		expect(goal.payload.objective).toBe("ship it");

		const ask: AskEntry = {
			...base(),
			type: "ask",
			payload: { questionId: "q1", question: "which?", options: ["a", "b"], multi: false },
		};
		if (ask.type !== "ask") throw new Error("narrowing failed");
		expect(ask.payload.options).toEqual(["a", "b"]);

		const answer: AnswerEntry = { ...base(), type: "answer", payload: { questionId: "q1", answers: ["a"] } };
		if (answer.type !== "answer") throw new Error("narrowing failed");
		expect(answer.payload.questionId).toBe("q1");

		const btw: BtwEntry = { ...base(), type: "btw", payload: { note: "side note" } };
		if (btw.type !== "btw") throw new Error("narrowing failed");
		expect(btw.payload.note).toBe("side note");

		const merge: MergeEntry = {
			...base(),
			type: "merge",
			mergedParentId: "e-branch",
			summary: "merged branch tip",
		};
		if (merge.type !== "merge") throw new Error("narrowing failed");
		expect(merge.mergedParentId).toBe("e-branch");

		const all: Entry[] = [message, goal, ask, answer, btw, merge];
		expect(all).toHaveLength(6);
	});

	it("exhaustive switch compiles and no variant is 'never'", () => {
		const entries: Entry[] = [
			{ ...base(), type: "message", message: { role: "user", content: [], timestamp: 0 } },
			{ ...base(), type: "compaction", summary: "s", retainedTail: [], tokensBefore: 10 },
			{ ...base(), type: "branch_summary", fromId: null, summary: "s" },
			{ ...base(), type: "merge", mergedParentId: "x", summary: "s" },
			{ ...base(), type: "goal", payload: { kind: "cleared" } },
			{ ...base(), type: "ask", payload: { questionId: "q", question: "?" } },
			{ ...base(), type: "answer", payload: { questionId: "q", answers: [] } },
			{ ...base(), type: "btw", payload: { note: "n" } },
		];
		const kinds: unknown[] = entries.map((e) => {
			switch (e.type) {
				case "message":
					return e.message.role;
				case "compaction":
					return e.tokensBefore;
				case "branch_summary":
					return e.summary;
				case "merge":
					return e.mergedParentId;
				case "goal":
					return e.payload.kind;
				case "ask":
					return e.payload.questionId;
				case "answer":
					return e.payload.answers.length;
				case "btw":
					return e.payload.note;
			}
			return undefined;
		});
		expect(kinds.every((kind) => kind !== undefined)).toBe(true);
		// If a variant were missing from the switch, TypeScript would flag `never`.
		expectTypeOf<Entry["type"]>().toEqualTypeOf<
			"message" | "compaction" | "branch_summary" | "merge" | "goal" | "ask" | "answer" | "btw"
		>();
	});

	it("NewEntry strips seq and timestamp", () => {
		expectTypeOf<import("../src/types/entries.ts").NewEntry<MessageEntry>>().not.toHaveProperty("seq");
		expectTypeOf<import("../src/types/entries.ts").NewEntry<MessageEntry>>().toHaveProperty("type");
	});
});
