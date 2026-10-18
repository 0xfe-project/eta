/**
 * The real summarizer behind the kernel's seam (REFACTOR.md §6.2).
 *
 * Everything else about compaction is tested in its own package; what matters
 * here is the joint: the kernel decides it is time (threshold or overflow), the
 * service calls the summarizer, the summarizer cuts the entries it was handed,
 * and the context the runner sends afterwards is the summary plus the retained
 * tail — with the compaction entry in the journal so a replay rebuilds it.
 */

import type { AssistantMessage, Model, Usage } from "@earendil-works/pi-ai";
import { etaCompaction } from "@eta/compaction";
import {
	type AgentMessage,
	type CompactionSummarizer,
	DEFAULT_COMPACTION_SETTINGS,
	type Kernel,
	kernelOn,
	Runner,
} from "@eta/core";
import { SessionLog } from "@eta/core/session";
import { MemoryStorage } from "@eta/core/storage";
import { assistantMessage, fakeModels } from "@eta/core/testing";
import { describe, expect, it } from "vitest";
import { type CompactionEntrySource, CompactionService } from "../src/index";
import { journaledKernel } from "../src/testing";

/**
 * What a session assembler does: build the harness's compaction service over the
 * journal's entries, and hand the runner its driver. The kernel knows neither.
 */
function attachCompaction(
	kernel: Kernel,
	runner: Runner,
	journaling: CompactionEntrySource,
	summarizer: CompactionSummarizer,
): CompactionService {
	const service = new CompactionService(kernel.ctx, {
		config: kernel.config,
		journaling,
		summarizer,
	});
	runner.attachCompaction(service);
	return service;
}

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

/** A summarizer answer, as the model layer would hand it back. */
const summaryAnswer = (text: string): AssistantMessage =>
	assistantMessage({ content: [{ type: "text", text }], stopReason: "stop", usage: usageOf(50, 30) });

/** A scripted models seam that answers conversation turns and summary requests. */
function models(script: AssistantMessage[], summaries: string[]) {
	const fake = fakeModels(script, { chunkSize: 4 });
	const summaryCalls: { systemPrompt?: string; messages: AgentMessage[] }[] = [];
	const conversation = fake.completeSimple.bind(fake);
	fake.completeSimple = async (model: Model<never>, context: never, options: never) => {
		const messages = (context as { messages: { role: string; content: unknown }[] }).messages;
		// A summary request is a single user turn carrying <conversation>.
		const isSummary = messages.length === 1 && JSON.stringify(messages[0]!.content).includes("<conversation>");
		if (!isSummary) return conversation(model, context, options);
		summaryCalls.push({
			systemPrompt: (context as { systemPrompt?: string }).systemPrompt,
			messages: messages as never,
		});
		return summaryAnswer(summaries[summaryCalls.length - 1] ?? `notes ${summaryCalls.length}`);
	};
	return { fake, summaryCalls };
}

describe("the kernel's compaction seam, with the real summarizer", () => {
	it("cuts a history past the ceiling, and the provider is sent the notes", async () => {
		const storage = new MemoryStorage();
		const log = SessionLog.create(storage);
		const { fake, summaryCalls } = models(
			[assistantMessage({ content: [{ type: "text", text: "after the cut" }], usage: usageOf(10, 5) })],
			["## Goal\nport the storage layer\n\n## Progress\n- [x] cut the history"],
		);
		fake.getModel = () =>
			({
				provider: "fake",
				id: "fake-model",
				api: "openai-completions",
				contextWindow: 200_000,
				maxTokens: 8_192,
			}) as never;

		// History the kernel will find already there: a few turns of real size, with
		// the usage a provider would have reported for them (the estimate comes from
		// that number, not from counting characters).
		for (let turn = 0; turn < 4; turn += 1) {
			log.recordMessage(userMsg(`question ${turn} ${"x".repeat(800)}`));
			log.recordMessage(
				assistantMessage({
					content: [{ type: "text", text: `answer ${turn}` }],
					usage: usageOf(4_000, 20),
				}) as never,
			);
		}
		await log.commit();
		const reloaded = await SessionLog.load(storage);
		const { kernel: resumed, journaling: resumedJournaling } = journaledKernel(reloaded, {
			config: {
				model: { provider: "p", modelId: "m" },
				compaction: {
					...DEFAULT_COMPACTION_SETTINGS,
					maxContextTokens: 400,
					reserveTokens: 200,
					keepRecentTokens: 300,
				},
			},
		});
		const resumedRunner = new Runner(resumed, {
			models: fake,
			journal: resumedJournaling,
			initialTranscript: reloaded.transcript(),
			toProviderMessages: (messages) =>
				messages.flatMap((message) =>
					message.role === "compactionSummary"
						? [
								{
									role: "user" as const,
									content: [{ type: "text" as const, text: `<summary>${message.summary}</summary>` }],
									timestamp: 0,
								},
							]
						: [message as never],
				),
		});
		attachCompaction(resumed, resumedRunner, resumedJournaling, etaCompaction());

		const statuses: { reason: string; status: string }[] = [];
		const off = kernelOn(resumed.ctx)("compaction:end", (event) => {
			statuses.push({ reason: event.reason, status: event.status });
		});
		resumed.inject(userMsg("carry on"));
		await resumedRunner.run();
		off();

		// The summarizer was asked once, with the system prompt compaction owns.
		expect(summaryCalls).toHaveLength(1);
		expect(summaryCalls[0]!.systemPrompt).toContain("note down what matters");
		expect(statuses).toEqual([{ reason: "threshold", status: "completed" }]);

		// The conversation request carries the summary in place of the history it
		// replaced. The retained tail is still there — that is what it is for — but
		// the turns that were summarized are gone.
		const sent = JSON.stringify(fake.calls.at(-1)!.context.messages);
		expect(sent).toContain("port the storage layer");
		expect(sent).not.toContain("question 0 ");

		// And the compaction entry is in the journal, details and all.
		const entries = await storage.scanEntries({});
		const compaction = entries.find((entry) => entry.type === "compaction")!;
		expect(compaction.type).toBe("compaction");
		if (compaction.type !== "compaction") throw new Error("unreachable");
		expect(compaction.tokensBefore).toBeGreaterThan(0);
		expect(compaction.retainedTail.length).toBeGreaterThan(0);
		expect(summaryCalls[0]!.messages.length).toBe(1);
		expect(compaction.usage?.output).toBe(30);

		// A replay rebuilds the same context: the summary stands for the history.
		const again = await SessionLog.load(storage);
		expect(again.transcript()[0]!.role).toBe("compactionSummary");
		expect(JSON.stringify(again.transcript())).toContain("port the storage layer");
		void resumed.dispose();
	});

	it("a manual compaction runs even when the history fits, with its own focus", async () => {
		const storage = new MemoryStorage();
		const log = SessionLog.create(storage);
		const { fake, summaryCalls } = models(
			[assistantMessage({ content: [{ type: "text", text: "ok" }], usage: usageOf(1, 1) })],
			["## Goal\nfrom a manual compaction"],
		);
		fake.getModel = () =>
			({
				provider: "fake",
				id: "fake-model",
				api: "openai-completions",
				contextWindow: 200_000,
				maxTokens: 8_192,
			}) as never;
		const { kernel, journaling } = journaledKernel(log, {
			// A keep budget of one token: the cut leaves the question to summarize,
			// which is what a manual compaction is for.
			config: {
				model: { provider: "p", modelId: "m" },
				compaction: { ...DEFAULT_COMPACTION_SETTINGS, reserveTokens: 200, keepRecentTokens: 1 },
			},
		});
		// The context compaction replaces belongs to a runner, so the session needs
		// one even when nothing runs.
		const runner = new Runner(kernel, { models: fake, journal: journaling });
		log.recordMessage(userMsg("a short question"));
		log.recordMessage(
			assistantMessage({ content: [{ type: "text", text: "a short answer" }], usage: usageOf(10, 5) }) as never,
		);
		await log.commit();
		runner.adoptTranscript(await (async () => (await SessionLog.load(storage)).transcript())());
		const compaction = attachCompaction(kernel, runner, journaling, etaCompaction());

		const compacted = await compaction.manual("focus on the migration plan");
		expect(compacted).toBe(true);
		await journaling.flush();
		expect(JSON.stringify(summaryCalls[0]!.messages)).toContain("Additional focus: focus on the migration plan");
		// The manual cut is in the journal like any other.
		const entries = await storage.scanEntries({});
		expect(entries.some((entry) => entry.type === "compaction")).toBe(true);
		void kernel.dispose();
	});

	it("the summarizer's own failures do not take the run down", async () => {
		const storage = new MemoryStorage();
		const log = SessionLog.create(storage);
		const fake = fakeModels([
			assistantMessage({ content: [{ type: "text", text: "still answered" }], usage: usageOf(1, 1) }),
		]);
		fake.getModel = () =>
			({
				provider: "fake",
				id: "fake-model",
				api: "openai-completions",
				contextWindow: 200_000,
				maxTokens: 8_192,
			}) as never;
		fake.completeSimple = async () => {
			throw new Error("the summarizer exploded");
		};
		const { kernel, journaling } = journaledKernel(log, {
			config: {
				model: { provider: "p", modelId: "m" },
				// Past the ceiling, and with a keep budget of one token so there is
				// something for the summarizer to try.
				compaction: {
					...DEFAULT_COMPACTION_SETTINGS,
					maxContextTokens: 1,
					reserveTokens: 200,
					keepRecentTokens: 1,
				},
			},
		});
		const runner = new Runner(kernel, { models: fake, journal: journaling });
		attachCompaction(kernel, runner, journaling, etaCompaction());
		const failures: string[] = [];
		const off = kernelOn(kernel.ctx)("compaction:end", (event) => {
			if (event.status === "failed") failures.push(event.error ?? "");
		});
		log.recordMessage(userMsg("a question worth summarizing"));
		log.recordMessage(
			assistantMessage({ content: [{ type: "text", text: "an answer" }], usage: usageOf(50, 10) }) as never,
		);
		await log.commit();
		runner.adoptTranscript((await SessionLog.load(storage)).transcript());
		kernel.inject(userMsg("long enough to be past one token"));
		const result = await runner.run();
		off();

		expect(failures.join(" ")).toContain("summarizer exploded");
		expect(result.error).toBeUndefined();
		void kernel.dispose();
	});
});
