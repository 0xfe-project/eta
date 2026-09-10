import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "../../src/harness/context.ts";
import {
	generateSummaryWithRequest,
	prepareCompaction,
	DEFAULT_COMPACTION_SETTINGS,
	type SummaryRequest,
} from "../../src/harness/compaction/compaction.ts";
import {
	dropToolPairs,
	maxMinFairAllocations,
	reducePromptBudget,
	toolResultShare,
	truncateFairly,
	untrustedFallback,
} from "../../src/harness/compaction/eta-compaction.ts";
import { UNTRUSTED_SUMMARY_NOTE } from "../../src/prompts/summary.ts";
import type { Entry } from "../../src/harness/session/types.ts";

const userMsg = (text: string) => ({ role: "user", content: text, timestamp: 1 }) as never;
const toolResult = (id: string, text = "x".repeat(200)) =>
	({
		role: "toolResult",
		toolCallId: id,
		toolName: "t",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: 1,
	}) as never;
const assistantCalls = (id: string) =>
	({
		role: "assistant",
		content: [{ type: "toolCall", id, name: "t", arguments: {} }],
		timestamp: 1,
		usage: undefined,
	}) as never;

describe("eta compaction helpers", () => {
	it("drops whole tool pairs only past the ratio", () => {
		const chatty = [
			userMsg("go"),
			assistantCalls("c1"),
			toolResult("c1"),
			userMsg("again"),
			assistantCalls("c2"),
			toolResult("c2"),
		];
		expect(toolResultShare(chatty as never)).toBeGreaterThanOrEqual(25);
		const dropped = dropToolPairs(chatty as never);
		expect(dropped.length).toBe(2);
		const noisyAnswer = [
			userMsg("go"),
			{
				role: "assistant",
				content: [
					{ type: "text", text: "thinking" },
					{ type: "toolCall", id: "c9", name: "t", arguments: {} },
				],
				timestamp: 1,
			} as never,
			toolResult("c9"),
		];
		const kept = dropToolPairs([
			userMsg("hi"),
			userMsg("hi"),
			noisyAnswer[1]!,
			noisyAnswer[2]!,
			noisyAnswer[0]!,
		] as never);
		expect(kept).toContain(noisyAnswer[1]);
	});

	it("never splits a pair across the cut", () => {
		const call = assistantCalls("dangling");
		const kept = dropToolPairs([userMsg("x"), call, toolResult("other"), userMsg("z")] as never);
		expect(kept).toContain(call);
		expect(kept.filter((m) => m.role === "toolResult").length).toBe(0);
	});

	it("max-min-fair reallocates slack deterministically", () => {
		expect(maxMinFairAllocations([10, 1000], 100)).toEqual([10, 90]);
		expect(maxMinFairAllocations([50, 50, 50], 10)).toEqual([3, 3, 4]);
		expect(maxMinFairAllocations([], 10)).toEqual([]);
	});

	it("truncateFairly marks omitted and truncated messages", () => {
		const big = { role: "user", content: "z".repeat(5_000), timestamp: 1 } as never;
		const out = truncateFairly([userMsg("short note"), big], 600)!;
		expect(out).toContain("short note");
		expect(out).toContain("[... truncated, ");
	});

	it("reducePromptBudget halves, thirds, floors at min", () => {
		expect(reducePromptBudget(1000, 1, 4000, 100)).toBe(500);
		expect(reducePromptBudget(1000, 2, 4000, 100)).toBe(333);
		expect(reducePromptBudget(100, 3, 4000, 200)).toBe(200);
	});

	it("summarizer failure falls back to fair truncation with the untrusted note", async () => {
		const failing: SummaryRequest = async () =>
			fauxAssistantMessage("x", { stopReason: "error", errorMessage: "dead" });
		const result = await generateSummaryWithRequest(
			[userMsg("hello there")] as never,
			{ model: { id: "m", api: "faux" } as never, reserveTokens: 4096 },
			failing,
			BACKGROUND_CONTEXT,
		);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.text.startsWith(UNTRUSTED_SUMMARY_NOTE)).toBe(true);
			expect(result.value.text).toContain("hello there");
		}
	});

	it("prepareCompaction drops tool noise from the summarized history", () => {
		const entries: Entry[] = [];
		for (let i = 0; i < 6; i++) {
			entries.push({
				type: "message",
				id: `a${i}`,
				parentId: null,
				seq: i,
				timestamp: i,
				message: assistantCalls(`c${i}`),
			});
			entries.push({
				type: "message",
				id: `r${i}`,
				parentId: null,
				seq: i,
				timestamp: i,
				message: toolResult(`c${i}`),
			});
		}
		entries.push({
			type: "message",
			id: "keep",
			parentId: null,
			seq: 99,
			timestamp: 99,
			message: userMsg("u".repeat(4_000)),
		});
		const prepared = prepareCompaction(entries, { enabled: true, reserveTokens: 1000, keepRecentTokens: 500 });
		expect(prepared.ok && prepared.value).toBeDefined();
		if (prepared.ok && prepared.value !== undefined) {
			expect(prepared.value.messagesToSummarize.some((m) => m.role === "toolResult")).toBe(false);
		}
	});

	it("untrustedFallback returns nothing when no message fits", () => {
		expect(untrustedFallback([], 10_000)).toBeUndefined();
	});
});
