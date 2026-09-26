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
	type AgentMessage,
	type CompactionRequest,
	type CompactionSummarizer,
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
/* The service: three signals, one seam                                */
/* ------------------------------------------------------------------ */

function fakeSummarizer(outcome?: (request: CompactionRequest) => { summary: string; retainedTail?: AgentMessage[] }) {
	const requests: CompactionRequest[] = [];
	const summarizer: CompactionSummarizer = {
		summarize: async (request) => {
			requests.push(request);
			if (outcome === undefined) return undefined;
			const produced = outcome(request);
			return {
				summary: produced.summary,
				retainedTail: produced.retainedTail ?? [],
				tokensBefore: request.estimatedTokens,
			};
		},
	};
	return { summarizer, requests };
}

/** A kernel with a scripted model that reports a window, and a journal. */
function session(
	script: AssistantMessage[],
	options: {
		summarizer?: CompactionSummarizer;
		maxContextTokens?: number;
		initialTranscript?: AgentMessage[];
	} = {},
) {
	const storage = new MemoryStorage();
	const log = SessionLog.create(storage);
	const kernel = Kernel.create({
		config: {
			model: { provider: "p", modelId: "m" },
			compaction: {
				...DEFAULT_COMPACTION_SETTINGS,
				...(options.maxContextTokens === undefined ? {} : { maxContextTokens: options.maxContextTokens }),
			},
		},
		...(options.summarizer === undefined ? {} : { compaction: options.summarizer }),
		journal: log,
		warn: () => undefined,
	});
	const fake = fakeModels(script);
	fake.getModel = () =>
		({
			provider: "fake",
			id: "fake-model",
			api: "openai-completions",
			contextWindow: 200_000,
			maxTokens: 8_192,
		}) as never;
	const runner = new Runner(kernel, {
		models: fake,
		toProviderMessages: projection as never,
		...(options.initialTranscript === undefined ? {} : { initialTranscript: options.initialTranscript }),
	});
	return { kernel, runner, fake, log, storage, dispose: () => void kernel.dispose() };
}

describe("CompactionService signals", () => {
	it("threshold() decides: it compacts only when the history no longer fits", async () => {
		const { summarizer, requests } = fakeSummarizer(() => ({ summary: "cut down" }));
		const small = session([assistantMessage({ content: [{ type: "text", text: "after" }] })], {
			summarizer,
			maxContextTokens: 100_000,
		});
		small.kernel.inject(userMsg("short"));
		await small.runner.run();
		expect(requests).toEqual([]);
		small.dispose();

		const big = session([assistantMessage({ content: [{ type: "text", text: "after" }] })], {
			summarizer,
			maxContextTokens: 10,
			initialTranscript: [userMsg("x".repeat(2_000))],
		});
		big.kernel.inject(userMsg("carry on"));
		const events: string[] = [];
		const off = kernelOn(big.kernel.ctx)("compaction:end", (event) => {
			events.push(`${event.reason}:${event.status}`);
		});
		await big.runner.run();
		off();

		expect(requests.map((request) => request.reason)).toEqual(["threshold"]);
		expect(events).toEqual(["threshold:completed"]);
		// The provider saw the summary, not the wall of text.
		const sent = JSON.stringify(big.fake.calls.at(-1)!.context.messages);
		expect(sent).toContain("cut down");
		expect(sent).not.toContain("x".repeat(2_000));
		big.dispose();
	});

	it("checks the threshold at the start of every run, not just the first", async () => {
		const { summarizer, requests } = fakeSummarizer(() => ({ summary: "cut down" }));
		// A ceiling tight enough that a short history fits but a long one does not.
		const s = session(
			[
				assistantMessage({
					stopReason: "toolUse",
					content: [{ type: "toolCall", id: "c1", name: "echo", arguments: {} }],
				}),
				assistantMessage({ content: [{ type: "text", text: "first done" }] }),
				assistantMessage({ content: [{ type: "text", text: "second done" }] }),
			],
			{ summarizer, maxContextTokens: 10 },
		);
		s.kernel.tools.register({ name: "echo", execute: () => "ok" });

		// The first run does tool work (so it advances the turn counter) and its
		// history still fits: nothing to compact.
		s.kernel.inject(userMsg("short"));
		await s.runner.run();
		expect(requests).toEqual([]);
		expect(s.kernel.turns).toBeGreaterThan(0);

		// The session then grows past the ceiling, and the second run must notice.
		s.runner.adoptTranscript([userMsg("x".repeat(2_000))]);
		s.kernel.inject(userMsg("carry on"));
		await s.runner.run();
		expect(requests.map((request) => request.reason)).toEqual(["threshold"]);
		s.dispose();
	});

	it("manual() compacts even when the history fits", async () => {
		const { summarizer, requests } = fakeSummarizer(() => ({ summary: "asked for it" }));
		const s = session([assistantMessage({ content: [{ type: "text", text: "after" }] })], { summarizer });
		s.kernel.inject(userMsg("short"));
		const statuses: string[] = [];
		const off = kernelOn(s.kernel.ctx)("compaction:end", (event) => {
			statuses.push(`${event.reason}:${event.status}`);
		});
		// The host asks, e.g. a /compact command.
		const compacted = await s.kernel.compaction.manual();
		off();
		expect(compacted).toBe(true);
		expect(requests.map((request) => request.reason)).toEqual(["manual"]);
		expect(statuses).toEqual(["manual:completed"]);
		s.dispose();
	});

	it("without a summarizer every signal declines", async () => {
		const s = session([assistantMessage()]);
		expect(s.kernel.compaction.available).toBe(false);
		expect(await s.kernel.compaction.manual()).toBe(false);
		expect(await s.kernel.compaction.threshold()).toBe(false);
		expect(await s.kernel.compaction.overflow()).toBe(false);
		s.dispose();
	});

	it("overflow() recovers once per run, and a new run restores the budget", async () => {
		const { summarizer, requests } = fakeSummarizer(() => ({ summary: "recovered" }));
		const s = session([assistantMessage({ content: [{ type: "text", text: "ran" }] })], { summarizer });
		// No run started yet: the budget is per run, so the first call works.
		expect(await s.kernel.compaction.overflow()).toBe(true);
		expect(await s.kernel.compaction.overflow()).toBe(false);
		expect(requests.map((request) => request.reason)).toEqual(["overflow"]);

		// A run start restores it (the service subscribes; the runner never tells it).
		s.kernel.inject(userMsg("go"));
		await s.runner.run();
		expect(await s.kernel.compaction.overflow()).toBe(true);
		expect(requests.map((request) => request.reason)).toEqual(["overflow", "overflow"]);
		s.dispose();
	});

	it("a failing summarizer is reported, and the run continues", async () => {
		const summarizer: CompactionSummarizer = {
			summarize: () => Promise.reject(new Error("summarizer exploded")),
		};
		const s = session([assistantMessage({ content: [{ type: "text", text: "still ran" }] })], {
			summarizer,
			maxContextTokens: 1,
		});
		const failures: string[] = [];
		const off = kernelOn(s.kernel.ctx)("compaction:end", (event) => {
			if (event.status === "failed") failures.push(event.error ?? "");
		});
		s.kernel.inject(userMsg("long enough to be past one token"));
		const result = await s.runner.run();
		off();
		expect(failures).toEqual(["summarizer exploded"]);
		expect(result.error).toBeUndefined();
		s.dispose();
	});

	it("a declining summarizer leaves the context alone", async () => {
		const { summarizer } = fakeSummarizer(undefined);
		const s = session([assistantMessage()], { summarizer, maxContextTokens: 1 });
		const statuses: string[] = [];
		const off = kernelOn(s.kernel.ctx)("compaction:end", (event) => {
			statuses.push(event.status);
		});
		s.kernel.inject(userMsg("long enough to be past one token"));
		await s.runner.run();
		off();
		expect(statuses).toEqual(["declined"]);
		expect(s.runner.readContext().length).toBe(2); // the user message and the answer
		s.dispose();
	});

	it("replaceContext swaps the transcript; the service journals the entry", async () => {
		const { summarizer } = fakeSummarizer(() => ({
			summary: "summary of the above",
			retainedTail: [userMsg("kept")],
		}));
		const s = session([], { summarizer });
		s.runner.replaceContext("summary of the above", { retainedTail: [userMsg("kept")] });
		expect(s.runner.readContext().map((message) => message.role)).toEqual(["compactionSummary", "user"]);

		// Through the service: the context is replaced and the entry is journalled.
		expect(await s.kernel.compaction.manual()).toBe(true);
		expect(s.runner.readContext().map((message) => message.role)).toEqual(["compactionSummary", "user"]);
		await s.log.commit();

		// A replay rebuilds the same context, not the pre-compaction history.
		const reloaded = await SessionLog.load(s.storage);
		expect(reloaded.transcript().map((message) => message.role)).toEqual(["compactionSummary", "user"]);
		expect(JSON.stringify(reloaded.transcript())).toContain("summary of the above");
		expect(reloaded.graph.pathOldestFirst().some((entry) => entry.type === "compaction")).toBe(true);
		s.dispose();
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
});
