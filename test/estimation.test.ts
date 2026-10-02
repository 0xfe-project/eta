/**
 * Compaction arithmetic (REFACTOR.md §2.4, ported from eta-agent's
 * harness/compaction/compaction.ts, adapted to the kernel's entry vocabulary).
 *
 * This is the arithmetic a compaction driver decides with: how tokens are
 * counted, where a cut may fall, and when a cut is due — including the
 * window-independent ceiling that stops a million-token window from resending a
 * million tokens. It lives in the harness because the kernel counts no tokens:
 * core keeps the seam's types, and the runner asks a driver instead.
 */
import type { Usage } from "@earendil-works/pi-ai";
import { DEFAULT_COMPACTION_SETTINGS } from "@eta/core";
import { type Entry } from "@eta/core/session";
import { assistantMessage } from "@eta/core/testing";
import { describe, expect, it } from "vitest";
import {
	calculateContextTokens,
	DEFAULT_MAX_CONTEXT_TOKENS,
	estimateContextTokens,
	estimateTokens,
	findCutPoint,
	findTurnStartIndex,
	fitCompactionSettings,
	getLastAssistantUsage,
	shouldCompact,
} from "../src/index";

const userMsg = (text: string) => ({
	role: "user" as const,
	content: [{ type: "text" as const, text }],
	timestamp: 0,
});

const usageOf = (input: number, output: number): Usage => ({
	input,
	output,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: input + output,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

let seq = 0;
function messageEntry(text: string, parentId: string | null = null) {
	seq += 1;
	return {
		id: `e${seq}`,
		parentId,
		type: "message" as const,
		message: userMsg(text),
	};
}

function assistantEntry(id: string, text: string, usage: Usage, parentId: string | null) {
	return {
		id,
		parentId,
		type: "message" as const,
		message: assistantMessage({ content: [{ type: "text", text }], usage }),
	};
}

describe("token arithmetic", () => {
	it("prefers the provider's total and falls back to the parts", () => {
		expect(calculateContextTokens(usageOf(10, 5))).toBe(15);
		expect(calculateContextTokens({ ...usageOf(10, 5), totalTokens: 99 })).toBe(99);
	});

	it("estimates a message at chars/4, counting thinking and tool arguments", () => {
		expect(estimateTokens(userMsg("12345678"))).toBe(2);
		expect(estimateTokens(assistantMessage({ content: [{ type: "text", text: "1234" }] }))).toBe(1);
		expect(
			estimateTokens(
				assistantMessage({
					content: [
						{ type: "thinking", thinking: "1234", thinkingSignature: "s" },
						{ type: "toolCall", id: "c", name: "bash", arguments: { command: "ls" } },
					],
				}),
			),
		).toBeGreaterThan(3);
	});

	it("counts a compaction summary as its own text", () => {
		expect(estimateTokens({ role: "compactionSummary", summary: "12345678", tokensBefore: 1, timestamp: 0 })).toBe(2);
	});

	it("uses the last assistant usage plus an estimate for what followed", () => {
		const messages = [
			userMsg("a".repeat(400)),
			assistantMessage({ usage: usageOf(100, 20) }),
			userMsg("b".repeat(40)),
		];
		const estimate = estimateContextTokens(messages);
		expect(estimate.usageTokens).toBe(120);
		expect(estimate.trailingTokens).toBe(10);
		expect(estimate.tokens).toBe(130);
		expect(estimate.lastUsageIndex).toBe(1);
	});

	it("ignores usage from errored or aborted turns", () => {
		const entries = [
			{ id: "e", parentId: null, seq: 1, timestamp: 0, type: "message", message: userMsg("x") },
			{
				id: "a",
				parentId: "e",
				seq: 2,
				timestamp: 0,
				type: "message",
				message: assistantMessage({ stopReason: "error", errorMessage: "boom", usage: usageOf(10, 10) }),
			},
		] as Entry[];
		expect(getLastAssistantUsage(entries)).toBeUndefined();
	});
});

describe("when to compact", () => {
	it("fires on the window's reserve", () => {
		const settings = { ...DEFAULT_COMPACTION_SETTINGS, maxContextTokens: 1_000_000 };
		expect(shouldCompact(100_000, 128_000, settings)).toBe(false);
		expect(shouldCompact(112_000, 128_000, settings)).toBe(true); // 128k - 16k reserve
	});

	it("fires on the window-independent ceiling for a huge window", () => {
		// The point of the ceiling: a 1M-token window must not become a licence to
		// resend a million tokens.
		const settings = { ...DEFAULT_COMPACTION_SETTINGS };
		expect(settings.maxContextTokens).toBeUndefined();
		expect(shouldCompact(DEFAULT_MAX_CONTEXT_TOKENS - 1, 1_000_000, settings)).toBe(false);
		expect(shouldCompact(DEFAULT_MAX_CONTEXT_TOKENS + 1, 1_000_000, settings)).toBe(true);
		// …and a provider that genuinely needs more can say so.
		expect(shouldCompact(200_000, 1_000_000, { ...settings, maxContextTokens: 256_000 })).toBe(false);
		expect(shouldCompact(300_000, 1_000_000, { ...settings, maxContextTokens: 256_000 })).toBe(true);
	});

	it("falls back to the ceiling when the model reports no window", () => {
		// A missing window must not silently switch compaction off.
		expect(shouldCompact(1_000, undefined, DEFAULT_COMPACTION_SETTINGS)).toBe(false);
		expect(shouldCompact(DEFAULT_MAX_CONTEXT_TOKENS + 1, undefined, DEFAULT_COMPACTION_SETTINGS)).toBe(true);
	});

	it("stays quiet when compaction is disabled", () => {
		expect(shouldCompact(10_000_000, 128_000, { ...DEFAULT_COMPACTION_SETTINGS, enabled: false })).toBe(false);
	});

	it("fits the kept tail to a small model's window", () => {
		const big = fitCompactionSettings(DEFAULT_COMPACTION_SETTINGS, { contextWindow: 1_000_000 });
		expect(big.keepRecentTokens).toBe(DEFAULT_COMPACTION_SETTINGS.keepRecentTokens);
		const small = fitCompactionSettings(DEFAULT_COMPACTION_SETTINGS, { contextWindow: 15_000 });
		expect(small.keepRecentTokens).toBe(5_000);
		// The reserve is left alone on purpose: it pushes the threshold earlier
		// instead of letting an oversized history through.
		expect(small.reserveTokens).toBe(DEFAULT_COMPACTION_SETTINGS.reserveTokens);
	});
});

describe("where the cut falls", () => {
	it("keeps roughly the requested recent budget and lands on a message boundary", () => {
		const entries: Entry[] = [
			{ ...messageEntry("u1".repeat(50)) },
			{ ...assistantEntry("a1", "x".repeat(200), usageOf(10, 10), "e1") },
			{ ...messageEntry("u2".repeat(50), "a1") },
			{ ...assistantEntry("a2", "y".repeat(200), usageOf(10, 10), "e2") },
		] as Entry[];
		const cut = findCutPoint(entries, 0, entries.length, 60);
		// The recent budget is ~60 tokens, so the cut lands at the later turn.
		expect(cut.firstKeptEntryIndex).toBe(2);
		expect(cut.isSplitTurn).toBe(false);
	});

	it("never cuts between an assistant call and its tool result", () => {
		const entries: Entry[] = [
			{ ...messageEntry("old".repeat(60)) },
			{ ...assistantEntry("a1", "x".repeat(400), usageOf(1, 1), "e1") },
			{
				id: "t1",
				parentId: "a1",
				seq: 99,
				timestamp: 0,
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "c1",
					toolName: "bash",
					content: [{ type: "text", text: "out".repeat(100) }],
					isError: false,
					timestamp: 0,
				},
			} as Entry,
		] as Entry[];
		// Whatever recent budget is asked for, the cut never lands on the result.
		for (const budget of [1, 5, 50, 200]) {
			const cut = findCutPoint(entries, 0, entries.length, budget);
			const atCut = entries[cut.firstKeptEntryIndex]!;
			expect(atCut.type).toBe("message");
			if (atCut.type !== "message") throw new Error("unreachable");
			expect(["user", "assistant"]).toContain(atCut.message.role);
		}
	});

	it("reports the turn start when the cut splits a turn", () => {
		const entries: Entry[] = [
			{ ...messageEntry("u1".repeat(50)) },
			{ ...assistantEntry("a1", "x".repeat(200), usageOf(1, 1), "e1") },
			{ ...messageEntry("u2".repeat(50), "a1") },
		] as Entry[];
		expect(findTurnStartIndex(entries, 2, 0)).toBe(2);
		expect(findTurnStartIndex(entries, 1, 0)).toBe(0);
	});
});
