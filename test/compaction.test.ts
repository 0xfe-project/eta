/**
 * Compaction (REFACTOR.md §2.4 / §3 ruling 4).
 *
 * The kernel owns the arithmetic and the two-method seam; the summarization
 * itself is a plugin. What is pinned here: how tokens are counted, where a cut
 * may fall, when a cut is due — including the window-independent ceiling that
 * stops a million-token window from resending a million tokens — and that the
 * runner adopts a replacement context without losing what the journal holds.
 */
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	type CompactionRequest,
	type CompactionService,
	calculateContextTokens,
	DEFAULT_COMPACTION_SETTINGS,
	DEFAULT_MAX_CONTEXT_TOKENS,
	type Entry,
	estimateContextTokens,
	estimateTokens,
	findCutPoint,
	findTurnStartIndex,
	fitCompactionSettings,
	getLastAssistantUsage,
	Kernel,
	kernelOn,
	MemoryStorage,
	Runner,
	SessionLog,
	shouldCompact,
} from "../src/index";
import { assistantMessage, fakeModels } from "../src/testing/fake-provider";

/**
 * What the prompts plugin will supply: the kernel's projection hook. Kept in
 * the test so the assertions can see the text the model would receive.
 */
const projection = (messages: readonly { role: string; summary?: string }[]) =>
	messages.flatMap((message) => {
		if (message.role === "user" || message.role === "assistant" || message.role === "toolResult") {
			return [message as never];
		}
		if (message.role === "compactionSummary") {
			return [
				{
					role: "user" as const,
					content: [{ type: "text" as const, text: `<summary>${message.summary}</summary>` }],
					timestamp: 0,
				},
			];
		}
		return [];
	});

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

/* ------------------------------------------------------------------ */
/* The seam                                                            */
/* ------------------------------------------------------------------ */

function fakeCompaction(outcome?: (request: CompactionRequest) => { summary: string; retainedTail: unknown[] }) {
	const requests: CompactionRequest[] = [];
	const service: CompactionService = {
		compact: async (request) => {
			requests.push(request);
			if (outcome === undefined) return undefined;
			const produced = outcome(request);
			return {
				summary: produced.summary,
				retainedTail: produced.retainedTail as never,
				tokensBefore: request.estimatedTokens,
			};
		},
	};
	return { service, requests };
}

describe("the runner's compaction seam", () => {
	it("compacts before the first request when the history no longer fits", async () => {
		const kernel = Kernel.create({
			config: {
				model: { provider: "p", modelId: "m" },
				compaction: { ...DEFAULT_COMPACTION_SETTINGS, maxContextTokens: 100 },
			},
		});
		const fake = fakeModels([assistantMessage({ content: [{ type: "text", text: "after compaction" }] })]);
		const log = SessionLog.create(new MemoryStorage());
		const { service, requests } = fakeCompaction(() => ({
			summary: "everything before was about widgets",
			retainedTail: [],
		}));
		const runner = new Runner(kernel, {
			models: fake,
			journal: log,
			compaction: service,
			toProviderMessages: projection as never,
		});

		// A history well past the ceiling.
		for (const message of log.transcript()) void message;
		const big = "x".repeat(2_000);
		log.recordMessage(userMsg(big));
		await log.commit();
		const seeded = await SessionLog.load(log.storage);
		const resumed = new Runner(kernel, {
			models: fake,
			journal: seeded,
			compaction: service,
			toProviderMessages: projection as never,
			initialTranscript: seeded.transcript(),
		});
		kernel.inject(userMsg("carry on"));

		const events: string[] = [];
		const off = kernelOn(kernel.ctx)("compaction:end", (event) => {
			events.push(event.status);
		});
		await resumed.run();
		off();

		expect(requests.map((request) => request.reason)).toEqual(["threshold"]);
		expect(events).toEqual(["completed"]);
		// The provider saw the summary, not the wall of text.
		const sent = JSON.stringify(fake.calls.at(-1)!.context.messages);
		expect(sent).toContain("everything before was about widgets");
		expect(sent).not.toContain(big);
		expect(runner).toBeDefined();
		void kernel.dispose();
	});

	it("does not compact while the history still fits", async () => {
		const kernel = Kernel.create({ config: { model: { provider: "p", modelId: "m" } } });
		const fake = fakeModels([assistantMessage()]);
		const { service, requests } = fakeCompaction(() => ({ summary: "s", retainedTail: [] }));
		const runner = new Runner(kernel, { models: fake, compaction: service });
		kernel.inject(userMsg("short"));
		await runner.run();
		expect(requests).toEqual([]);
		void kernel.dispose();
	});

	it("a declining service leaves the context alone", async () => {
		const kernel = Kernel.create({
			config: {
				model: { provider: "p", modelId: "m" },
				compaction: { ...DEFAULT_COMPACTION_SETTINGS, maxContextTokens: 1 },
			},
		});
		const fake = fakeModels([assistantMessage()]);
		const { service } = fakeCompaction(undefined);
		const runner = new Runner(kernel, { models: fake, compaction: service });
		const statuses: string[] = [];
		const off = kernelOn(kernel.ctx)("compaction:end", (event) => {
			statuses.push(event.status);
		});
		kernel.inject(userMsg("long enough to be past one token"));
		await runner.run();
		off();
		expect(statuses).toEqual(["declined"]);
		expect(runner.readContext().length).toBe(2); // the user message and the answer
		void kernel.dispose();
	});

	it("a missing projection fails loudly rather than dropping the summary", async () => {
		const kernel = Kernel.create({ config: { model: { provider: "p", modelId: "m" } } });
		const fake = fakeModels([]);
		const runner = new Runner(kernel, { models: fake });
		runner.replaceContext("summary");
		kernel.inject(userMsg("go"));
		await expect(runner.run()).rejects.toThrow("toProviderMessages is required");
		void kernel.dispose();
	});

	it("replaceContext swaps the transcript and journals the compaction", async () => {
		const kernel = Kernel.create({ config: { model: { provider: "p", modelId: "m" } } });
		const log = SessionLog.create(new MemoryStorage());
		const fake = fakeModels([]);
		const runner = new Runner(kernel, { models: fake, journal: log });
		kernel.inject(userMsg("first"));
		// Nothing is in the context until a run drains the injected message.
		expect(runner.readContext()).toEqual([]);

		const entry = runner.replaceContext("summary of the above", { retainedTail: [userMsg("kept")] });
		expect(entry?.type).toBe("compaction");
		expect(runner.readContext().map((message) => message.role)).toEqual(["compactionSummary", "user"]);
		await log.commit();

		// A replay rebuilds the same context, not the pre-compaction history.
		const reloaded = await SessionLog.load(log.storage);
		expect(reloaded.transcript().map((message) => message.role)).toEqual(["compactionSummary", "user"]);
		expect(JSON.stringify(reloaded.transcript())).toContain("summary of the above");
		void kernel.dispose();
	});

	it("a failing service reports the failure and keeps the run going", async () => {
		const kernel = Kernel.create({
			config: {
				model: { provider: "p", modelId: "m" },
				compaction: { ...DEFAULT_COMPACTION_SETTINGS, maxContextTokens: 1 },
			},
		});
		const fake = fakeModels([assistantMessage({ content: [{ type: "text", text: "still ran" }] })]);
		const service: CompactionService = {
			compact: () => Promise.reject(new Error("summarizer exploded")),
		};
		const runner = new Runner(kernel, { models: fake, compaction: service });
		const failures: string[] = [];
		const off = kernelOn(kernel.ctx)("compaction:end", (event) => {
			if (event.status === "failed") failures.push(event.error ?? "");
		});
		kernel.inject(userMsg("long enough to be past one token"));
		const result = await runner.run();
		off();
		expect(failures).toEqual(["summarizer exploded"]);
		expect(result.error).toBeUndefined();
		void kernel.dispose();
	});
});
