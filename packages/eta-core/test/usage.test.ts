/**
 * Usage accounting (REFACTOR.md §2.4, ported from eta-agent's response
 * settlement + lane.recordUsage).
 *
 * Every settled assistant message writes a usage row in the same commit as its
 * entry, so the journal is the ledger: a replay rebuilds the same totals, a
 * correction adjusts rather than double-charges, and a failed generation is
 * never billed because it is never history.
 */
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { Kernel, kernelOn, MemoryStorage, Runner, SessionLog, sessionTokenTotal, type UsageRow } from "../src/index";
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
	cost: { input: 0.1, output: 0.2, cacheRead: 0.01, cacheWrite: 0, total: 0.31 },
});

function setup(script: AssistantMessage[]) {
	const log = SessionLog.create(new MemoryStorage());
	const kernel = Kernel.create({ config: { model: { provider: "p", modelId: "m" } }, journal: log });
	const fake = fakeModels(script);
	const runner = new Runner(kernel, { models: fake });
	const recorded: { row: UsageRow; totals: Usage }[] = [];
	const off = kernelOn(kernel.ctx)("usage:recorded", (event) => {
		recorded.push(event as never);
	});
	return {
		kernel,
		runner,
		fake,
		log,
		recorded,
		dispose: () => {
			off();
			void kernel.dispose();
		},
	};
}

describe("usage rows", () => {
	it("records one row per settled assistant message, in the same commit as its entry", async () => {
		const { kernel, runner, log, recorded, dispose } = setup([
			assistantMessage({ content: [{ type: "text", text: "answer" }], usage: usageOf(100, 20) }),
		]);
		kernel.inject(userMsg("go"));
		await runner.run();

		expect(recorded).toHaveLength(1);
		const { row, totals } = recorded[0]!;
		expect(row.usage.input).toBe(100);
		expect(row.usage.output).toBe(20);
		expect(row.adjustment).toBe(false);
		expect(row.entryId).toBeDefined();
		expect(row.seq).toBeGreaterThan(0);
		expect(totals.totalTokens).toBe(120);

		// The row's entry is the assistant message it was spent on.
		const entries = await log.storage.scanEntries({});
		const assistant = entries.find((entry) => entry.type === "message" && entry.message.role === "assistant")!;
		expect(row.entryId).toBe(assistant.id);
		dispose();
	});

	it("keeps the totals a replay rebuilds", async () => {
		const { kernel, runner, log, dispose } = setup([
			assistantMessage({
				stopReason: "toolUse",
				content: [{ type: "toolCall", id: "c1", name: "echo", arguments: {} }],
				usage: usageOf(50, 10, 5),
			}),
			assistantMessage({ content: [{ type: "text", text: "done" }], usage: usageOf(200, 30, 40) }),
		]);
		kernel.tools.register({ name: "echo", execute: () => "ok" });
		kernel.inject(userMsg("go"));
		await runner.run();

		const live = await log.storage.getStats();
		expect(live.usage.input).toBe(250);
		expect(live.usage.output).toBe(40);
		expect(live.usage.cacheRead).toBe(45);
		// The user message, both assistant messages, and the tool result.
		expect(live.messageCount).toBe(4);

		// A restart over the same journal sees the same numbers.
		const liveRows = await log.storage.scanUsage({});
		const reloaded = await SessionLog.load(log.storage);
		expect(await reloaded.storage.getStats()).toEqual(live);
		expect(await reloaded.storage.scanUsage({})).toEqual(liveRows);
		// Each row belongs to the assistant entry it was spent on.
		expect(liveRows.every((row) => row.entryId !== undefined)).toBe(true);
		dispose();
	});

	it("counts cache traffic in the session total", () => {
		// A warm session pays cache reads every turn; a total that ignores them
		// reports a fraction of the bill as if it were the bill.
		expect(sessionTokenTotal(usageOf(10, 10, 1_000))).toBe(1_020);
		expect(sessionTokenTotal(undefined)).toBe(0);
	});

	it("a correction adjusts the totals instead of charging twice", async () => {
		const { kernel, runner, log, dispose } = setup([
			assistantMessage({ content: [{ type: "text", text: "answer" }], usage: usageOf(100, 20) }),
		]);
		kernel.inject(userMsg("go"));
		await runner.run();

		const before = await log.storage.getStats();
		const entry = (await log.storage.scanEntries({ type: "message" })).find(
			(candidate) => candidate.type === "message" && candidate.message.role === "assistant",
		)!;
		// The provider restates what the request cost.
		const row = await kernel.journaling.recordUsage(usageOf(120, 20), { entryId: entry.id });
		expect(row?.adjustment).toBe(true);

		const after = await log.storage.getStats();
		expect(after.usage.input).toBe(before.usage.input + 120);
		expect((await log.storage.scanUsage({})).map((r) => r.adjustment)).toEqual([false, true]);
		dispose();
	});

	it("a failed generation is never billed", async () => {
		const { kernel, runner, recorded, dispose } = setup([
			// A deterministic failure: no retry, so exactly one failed generation.
			assistantMessage({ stopReason: "error", errorMessage: "401 invalid api key", usage: usageOf(999, 999) }),
		]);
		kernel.inject(userMsg("go"));
		const result = await runner.run();
		expect(result.status).toBe("failed");
		expect(recorded).toEqual([]);
		// And the failure is not in the transcript either.
		expect(runner.getTranscript().filter((message) => message.role === "assistant")).toEqual([]);
		dispose();
	});

	it("totals accumulate across turns and are reported per row", async () => {
		const { kernel, runner, recorded, dispose } = setup([
			assistantMessage({
				stopReason: "toolUse",
				content: [{ type: "toolCall", id: "c1", name: "echo", arguments: {} }],
				usage: usageOf(10, 5),
			}),
			assistantMessage({ content: [{ type: "text", text: "done" }], usage: usageOf(20, 7) }),
		]);
		kernel.tools.register({ name: "echo", execute: () => "ok" });
		kernel.inject(userMsg("go"));
		await runner.run();
		expect(recorded.map((event) => event.totals.input)).toEqual([10, 30]);
		expect(recorded.map((event) => event.totals.output)).toEqual([5, 12]);
		dispose();
	});
});
