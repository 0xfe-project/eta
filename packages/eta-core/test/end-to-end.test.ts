/**
 * End to end: the kernel driving one session (REFACTOR.md §2).
 *
 * Everything below runs through the seams the kernel actually exposes — a
 * streamed model, tools with middleware, the inbox, the goal, the persona, a
 * compaction service, the journal — in the order a real run hits them. The
 * scripted provider fails, overflows, and gets steered mid-run on purpose: a
 * happy path proves little about machinery whose job is to survive the rest.
 */

import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	applyGoalEntries,
	type CompactionRequest,
	type GoalEntry,
	Kernel,
	type KernelTool,
	kernelOn,
	MemoryStorage,
	Runner,
	recordGoalEntries,
	SessionLog,
	sessionTokenTotal,
	type UsageRow,
} from "../src/index";
import { assistantMessage, fakeModels } from "../src/testing/fake-provider";

const userMsg = (text: string) => ({
	role: "user" as const,
	content: [{ type: "text" as const, text }],
	timestamp: 0,
});

const usageOf = (input: number, output: number, cacheRead = 0): Usage => ({
	input,
	output,
	cacheRead,
	cacheWrite: 0,
	totalTokens: input + output + cacheRead,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

const answer = (text: string, usage = usageOf(100, 20)): AssistantMessage =>
	assistantMessage({ content: [{ type: "text", text }], stopReason: "stop", usage });

const toolTurn = (calls: { id: string; name: string; args?: Record<string, unknown> }[], usage = usageOf(50, 10)) =>
	assistantMessage({
		stopReason: "toolUse",
		content: calls.map((call) => ({
			type: "toolCall" as const,
			id: call.id,
			name: call.name,
			arguments: call.args ?? {},
		})),
		usage,
	});

const transient = (message = "upstream 503 service unavailable") =>
	assistantMessage({ stopReason: "error", errorMessage: message, usage: usageOf(10, 1) });

const overflow = () =>
	assistantMessage({ stopReason: "error", errorMessage: "prompt is too long: 210000 tokens > 200000 maximum" });

/** The whole session's wiring, as the server would build it. */
function session(script: AssistantMessage[], tools: KernelTool[] = []) {
	const storage = new MemoryStorage();
	const log = SessionLog.create(storage);
	// The plugins a real deployment would supply.
	const compactions: CompactionRequest[] = [];
	const compaction = {
		summarize: async (request: CompactionRequest) => {
			compactions.push(request);
			return {
				summary: "everything before was about the migration",
				retainedTail: [],
				tokensBefore: request.estimatedTokens,
			};
		},
	};
	const kernel = Kernel.create({
		config: {
			model: { provider: "p", modelId: "m" },
			activeToolNames: tools.map((tool) => tool.name),
			thinkingLevel: "low",
			compaction: { enabled: true, reserveTokens: 1_000, keepRecentTokens: 500, maxContextTokens: 64_000 },
		},
		compaction,
		journal: log,
	});
	for (const tool of tools) kernel.tools.register(tool);

	const fake = fakeModels(script, { chunkSize: 8 });
	fake.getModel = () =>
		({
			provider: "fake",
			id: "fake-model",
			api: "openai-completions",
			contextWindow: 200_000,
			maxTokens: 8_192,
		}) as never;

	const usageRows: UsageRow[] = [];
	const runStatuses: string[] = [];
	const on = kernelOn(kernel.ctx);
	const offs = [
		on("usage:recorded", (event) => {
			usageRows.push(event.row);
		}),
		on("turn:run-end", (event) => {
			runStatuses.push(event.status);
		}),
	];
	const goalRecorder = recordGoalEntries(log, on);
	const runner = new Runner(kernel, {
		models: fake,
		systemPrompt: "You are Eta, a coding agent.",
		toolContext: { workspace: "/w" },
		entryProjectors: {},
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
	kernel.persona.loadCards([{ id: "Executor", name: "Executor", content: "Ship it." }]);
	kernel.persona.setActive(["Executor"]);

	return {
		kernel,
		runner,
		fake,
		storage,
		log,
		compactions,
		usageRows,
		runStatuses,
		stopGoalRecorder: () => goalRecorder.stop(),
		dispose: () => {
			goalRecorder.stop();
			for (const off of offs) off();
			void kernel.dispose();
		},
	};
}

const taskTool = (created: string[]): KernelTool => ({
	name: "task",
	description: "record a task",
	execute: (args) => {
		created.push(String((args as { content?: string }).content ?? ""));
		return `recorded: ${created.join(", ")}`;
	},
});

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("one full session", () => {
	it("streams, retries, recovers from overflow, steers, and lands in the journal", async () => {
		const created: string[] = [];
		const s = session(
			[
				toolTurn([{ id: "c1", name: "task", args: { content: "port the storage layer" } }]),
				transient(),
				overflow(),
				answer("Storage ported, tests green."),
				answer("And the follow-up is handled."),
			],
			[taskTool(created)],
		);

		// A middleware that watches every call; the tools plugin's job in a deployment.
		const seenCalls: string[] = [];
		s.kernel.tools.use({
			name: "audit",
			before: (name, args) => {
				seenCalls.push(name);
				return { ok: true, args };
			},
		});

		s.kernel.goal.set("port the storage layer to the kernel");
		s.kernel.inject(userMsg("start on the storage port"));
		// Steering arrives after the tool batch; a follow-up waits for the stop.
		s.kernel.tools.use({
			name: "steer",
			after: (name, _args, result) => {
				if (name === "task") s.kernel.followUp("also rerun the jsonl tests");
				return result;
			},
		});

		const run = s.runner.run();
		// Let the retry backoff elapse (1s base delay).
		await vi.advanceTimersByTimeAsync(5_000);
		const result = await run;

		expect(result.status).toBe("completed");
		expect(result.error).toBeUndefined();
		// The tool ran; the failure was retried; the overflow was compacted away.
		expect(created).toEqual(["port the storage layer"]);
		expect(seenCalls).toEqual(["task"]);
		expect(s.compactions.map((request) => request.reason)).toEqual(["overflow"]);
		expect(s.runStatuses).toEqual(["completed"]);

		// The provider saw the persona in its prompt and a compacted context.
		const lastCall = s.fake.calls.at(-1)!;
		expect(lastCall.context.systemPrompt).toContain("You are Eta, a coding agent.");
		expect(lastCall.context.systemPrompt).toContain("Ship it.");
		expect(JSON.stringify(lastCall.context.messages)).toContain("<summary>");
		// …and the follow-up it was handed at the boundary.
		expect(JSON.stringify(lastCall.context.messages)).toContain("also rerun the jsonl tests");

		// Usage was recorded for each settled message — the tool turn, the recovered
		// answer, and the follow-up — and the failed attempts were not billed.
		expect(s.usageRows.length).toBe(3);
		expect(s.usageRows.every((row) => row.adjustment === false)).toBe(true);
		expect(sessionTokenTotal((await s.storage.getStats()).usage)).toBeGreaterThan(0);
		// Throughput is a number, not a placeholder.
		expect(s.kernel.metrics.tokensPerSec).toBeGreaterThanOrEqual(0);
		s.dispose();
	});

	it("the journal holds complete turns only, and a replay rebuilds the session", async () => {
		const created: string[] = [];
		const s = session(
			[toolTurn([{ id: "c1", name: "task", args: { content: "one" } }]), answer("first run done")],
			[taskTool(created)],
		);
		s.kernel.goal.set("finish the migration");
		s.kernel.inject(userMsg("go"));
		await s.runner.run();

		const stats = await s.storage.getStats();
		const entries = await s.storage.scanEntries({ order: "asc" });
		// the goal entry the subscriber wrote, the user message, the assistant's
		// tool call, the tool result, and the final answer.
		expect(entries).toHaveLength(5);
		expect(entries[0]!.type).toBe("goal");
		expect(entries[0]!.parentId).toBeNull();
		for (let index = 1; index < entries.length; index += 1) {
			expect(entries[index]!.parentId).toBe(entries[index - 1]!.id);
		}

		// A restart: a new kernel over the same journal.
		const log = await SessionLog.load(s.storage);
		expect(log.transcript().length).toBe(4); // goal entries are not messages
		expect(await s.storage.getStats()).toEqual(stats);

		const restartedKernel = Kernel.create({
			config: { model: { provider: "p", modelId: "m" }, activeToolNames: ["task"] },
			journal: log,
		});
		restartedKernel.tools.register(taskTool(created));
		const goalEntries = log.graph.pathOldestFirst().filter((entry): entry is GoalEntry => entry.type === "goal");
		applyGoalEntries(restartedKernel.goal, goalEntries);
		expect(restartedKernel.goal.current?.objective).toBe("finish the migration");
		expect(restartedKernel.goal.current?.status).toBe("active");

		// And it keeps going, appending to the same journal.
		const fake = fakeModels([answer("resumed")]);
		const runner = new Runner(restartedKernel, {
			models: fake,
			initialTranscript: log.transcript(),
		});
		restartedKernel.inject(userMsg("continue"));
		await runner.run();
		expect(fake.calls[0]!.context.messages.length).toBeGreaterThan(2);
		// The goal entry, four messages, and the resumed question and answer.
		expect(await log.storage.scanEntries({})).toHaveLength(7);
		void restartedKernel.dispose();
		s.dispose();
	});

	it("an aborted run keeps what it committed, and the next run starts clean", async () => {
		const created: string[] = [];
		const slow: KernelTool = {
			name: "task",
			execute: async (args) => {
				created.push(String((args as { content?: string }).content ?? ""));
				await new Promise((resolve) => setTimeout(resolve, 50));
				return "slowly recorded";
			},
		};
		const s = session(
			[toolTurn([{ id: "c1", name: "task", args: { content: "half done" } }]), answer("finished by hand")],
			[slow],
		);
		s.kernel.inject(userMsg("start"));
		const run = s.runner.run();
		await vi.advanceTimersByTimeAsync(5);
		s.runner.abort();
		await vi.advanceTimersByTimeAsync(100);
		const aborted = await run;
		expect(aborted.status).toBe("aborted");
		expect(created).toEqual(["half done"]); // the effect could not be un-run

		// What was committed stands: the user message, the call, the result.
		const entries = await s.storage.scanEntries({ order: "asc" });
		expect(entries.length).toBeGreaterThanOrEqual(2);
		expect(entries[0]!.type).toBe("message");

		// A fresh run over the replayed journal answers normally.
		const log = await SessionLog.load(s.storage);
		const kernel = Kernel.create({
			config: { model: { provider: "p", modelId: "m" }, activeToolNames: [] },
			journal: log,
		});
		const fake = fakeModels([answer("clean run")]);
		const runner = new Runner(kernel, { models: fake, initialTranscript: log.transcript() });
		kernel.inject(userMsg("try again"));
		const second = await runner.run();
		expect(second.status).toBe("completed");
		expect(fake.calls[0]!.context.messages.some((message) => message.role === "user")).toBe(true);
		void kernel.dispose();
		s.dispose();
	});
});
