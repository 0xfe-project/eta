/**
 * The compaction service: three signals, one seam (REFACTOR.md §2.4, §3 ruling
 * 4).
 *
 * The service lives in the harness — deciding takes arithmetic — and what it
 * exposes is the `CompactionDriver` the runner awaits. What is pinned here: the
 * threshold respects the window's reserve and the absolute ceiling, the check
 * happens at the start of every run, `manual()` ignores the threshold, an
 * overflow is recovered once per run, and a replacement context reaches the
 * journal so a replay rebuilds the same transcript.
 */
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	type AgentMessage,
	type CompactionRequest,
	type CompactionSummarizer,
	DEFAULT_COMPACTION_SETTINGS,
	Kernel,
	kernelOn,
	MemoryStorage,
	Runner,
	SessionLog,
} from "@eta/core";
import { assistantMessage, fakeModels } from "@eta/core/testing";
import { describe, expect, it } from "vitest";
import { CompactionMisconfigured, CompactionService } from "../src/index";

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
	// The service is a harness piece, so the test builds it and hands it to the
	// runner — exactly what a session assembler does (openSession, once the
	// harness owns it).
	const compaction = new CompactionService(kernel.ctx, {
		config: kernel.config,
		journaling: kernel.journaling,
		...(options.summarizer === undefined ? {} : { summarizer: options.summarizer }),
		warn: () => undefined,
	});
	runner.attachCompaction(compaction);
	return { kernel, runner, compaction, fake, log, storage, dispose: () => void kernel.dispose() };
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
		const compacted = await s.compaction.manual();
		off();
		expect(compacted).toBe(true);
		expect(requests.map((request) => request.reason)).toEqual(["manual"]);
		expect(statuses).toEqual(["manual:completed"]);
		s.dispose();
	});

	it("without a summarizer every signal throws instead of declining", async () => {
		// A driver with nothing to summarize with is a wiring bug, and a silent
		// decline would let a session resend a history nobody keeps in bounds.
		const s = session([assistantMessage()]);
		expect(s.compaction.available).toBe(false);
		for (const signal of [s.compaction.manual(), s.compaction.threshold(), s.compaction.overflow()]) {
			await expect(signal).rejects.toThrow(CompactionMisconfigured);
			await expect(signal).rejects.toThrow(/no summarizer is wired/);
		}
		s.dispose();
	});

	it("a half-wired session dies at its first run rather than overflowing quietly", async () => {
		const s = session([assistantMessage({ content: [{ type: "text", text: "never asked" }] })]);
		s.kernel.inject(userMsg("go"));
		// The threshold check runs before the first request, so the run dies there.
		await expect(s.runner.run()).rejects.toThrow(/compaction_misconfigured: threshold\(\) was asked to compact/);
		s.dispose();
	});

	it("a signal from a service nobody attached also throws", async () => {
		const storage = new MemoryStorage();
		const log = SessionLog.create(storage);
		const kernel = Kernel.create({ config: { model: { provider: "p", modelId: "m" } }, journal: log });
		const orphan = new CompactionService(kernel.ctx, {
			config: kernel.config,
			journaling: kernel.journaling,
			summarizer: { summarize: async () => undefined },
		});
		await expect(orphan.threshold()).rejects.toThrow(/no run is attached/);
		void kernel.dispose();
	});

	it("a model that does not resolve is a misconfiguration too", async () => {
		const s = session([assistantMessage()], { summarizer: { summarize: async () => undefined } });
		s.fake.getModel = () => undefined as never;
		await expect(s.compaction.manual()).rejects.toThrow(/model does not resolve/);
		s.dispose();
	});

	it("overflow() recovers once per run, and a new run restores the budget", async () => {
		const { summarizer, requests } = fakeSummarizer(() => ({ summary: "recovered" }));
		const s = session([assistantMessage({ content: [{ type: "text", text: "ran" }] })], { summarizer });
		// No run started yet: the budget is per run, so the first call works.
		expect(await s.compaction.overflow()).toBe(true);
		expect(await s.compaction.overflow()).toBe(false);
		expect(requests.map((request) => request.reason)).toEqual(["overflow"]);

		// A run start restores it (the service subscribes; the runner never tells it).
		s.kernel.inject(userMsg("go"));
		await s.runner.run();
		expect(await s.compaction.overflow()).toBe(true);
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
		s.runner.replaceContext("summary of the above", { retainedTail: [userMsg("kept")], tokensBefore: 0 });
		expect(s.runner.readContext().map((message) => message.role)).toEqual(["compactionSummary", "user"]);

		// Through the service: the context is replaced and the entry is journalled.
		expect(await s.compaction.manual()).toBe(true);
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
		runner.replaceContext("summary", { tokensBefore: 0 });
		kernel.inject(userMsg("go"));
		await expect(runner.run()).rejects.toThrow("toProviderMessages is required");
		void kernel.dispose();
	});
});
