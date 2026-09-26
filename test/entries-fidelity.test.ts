/**
 * Entry union fidelity (REFACTOR.md §2.2 / §6).
 *
 * The kernel's entry vocabulary is eta-agent's, minus the parts that belonged
 * to machinery this design deleted: there is no `custom` escape hatch (a plugin
 * extends the union explicitly), and no `fromHook` flag (there are no hooks).
 * What is kept is everything a reader of the journal needs — including the
 * terminate marker, which is a real behaviour: a tool can end a run.
 */
import { describe, expect, it } from "vitest";
import { type Entry, Kernel, kernelOn, MemoryStorage, type MessageEntry, Runner, SessionLog } from "../src/index";
import { assistantMessage, fakeModels } from "../src/testing/fake-provider";

const userMsg = (text: string) => ({
	role: "user" as const,
	content: [{ type: "text" as const, text }],
	timestamp: 0,
});

const toolTurn = (id: string, name: string) =>
	assistantMessage({ stopReason: "toolUse", content: [{ type: "toolCall" as const, id, name, arguments: {} }] });

describe("terminate ends the run", () => {
	it("a terminating tool result stops the loop without another request", async () => {
		const log = SessionLog.create(new MemoryStorage());
		const kernel = Kernel.create({
			config: { model: { provider: "p", modelId: "m" } },
			journal: log,
		});
		const fake = fakeModels([toolTurn("c1", "finish")]);
		const runner = new Runner(kernel, { models: fake });
		kernel.tools.register({ name: "finish", execute: () => ({ content: "all done", terminate: true }) });
		kernel.inject(userMsg("go"));
		const result = await runner.run();

		expect(result.status).toBe("completed");
		// Exactly one request: the tool said stop, so the model was not asked again.
		expect(fake.calls).toHaveLength(1);

		// The tool result entry carries the marker.
		const entries = log.graph.pathOldestFirst();
		const toolResult = entries.find(
			(entry): entry is MessageEntry => entry.type === "message" && entry.message.role === "toolResult",
		)!;
		expect(toolResult.terminate).toBe(true);
		void kernel.dispose();
	});

	it("only a fully terminating batch ends the run", async () => {
		const kernel = Kernel.create({ config: { model: { provider: "p", modelId: "m" } } });
		const fake = fakeModels([
			assistantMessage({
				stopReason: "toolUse",
				content: [
					{ type: "toolCall", id: "c1", name: "finish", arguments: {} },
					{ type: "toolCall", id: "c2", name: "keepGoing", arguments: {} },
				],
			}),
			assistantMessage({ content: [{ type: "text", text: "carried on" }] }),
		]);
		const runner = new Runner(kernel, { models: fake });
		kernel.tools.register({ name: "finish", execute: () => ({ content: "done", terminate: true }) });
		kernel.tools.register({ name: "keepGoing", execute: () => "not done" });
		kernel.inject(userMsg("go"));
		await runner.run();
		// One call did not terminate, so the run continued to a second request.
		expect(fake.calls).toHaveLength(2);
		void kernel.dispose();
	});

	it("reports terminate on the tool:end event", async () => {
		const kernel = Kernel.create({ config: { model: { provider: "p", modelId: "m" } } });
		const fake = fakeModels([toolTurn("c1", "finish")]);
		const runner = new Runner(kernel, { models: fake });
		kernel.tools.register({ name: "finish", execute: () => ({ content: "done", terminate: true }) });
		const seen: boolean[] = [];
		const off = kernelOn(kernel.ctx)("tool:end", (event) => {
			seen.push(event.terminate);
		});
		kernel.inject(userMsg("go"));
		await runner.run();
		off();
		expect(seen).toEqual([true]);
		void kernel.dispose();
	});
});

describe("entry payload fidelity", () => {
	it("compaction and merge entries carry plugin details", async () => {
		const storage = new MemoryStorage();
		await storage.commit([
			{ kind: "entry", entry: { id: "u", parentId: null, type: "message", message: userMsg("hi") } },
			{
				kind: "entry",
				entry: {
					id: "c",
					parentId: "u",
					type: "compaction",
					summary: "summary",
					retainedTail: [],
					tokensBefore: 100,
					details: { strategy: "cut-at-turn", kept: 2 },
					fromHookIgnored: true,
				} as unknown as Entry,
			},
			{
				kind: "entry",
				entry: {
					id: "m",
					parentId: "c",
					type: "merge",
					mergedParentId: "u",
					summary: "merged",
					details: { branch: "side" },
				},
			},
		]);
		const log = await SessionLog.load(storage);
		const entries = log.graph.pathOldestFirst();
		const compaction = entries.find((entry) => entry.type === "compaction")!;
		expect(compaction.details).toEqual({ strategy: "cut-at-turn", kept: 2 });
		const merge = entries.find((entry) => entry.type === "merge")!;
		expect(merge.details).toEqual({ branch: "side" });
		// The compaction entry projects into the transcript as the summary it stands for.
		expect(log.transcript().map((message) => message.role)).toEqual(["compactionSummary"]);
	});

	it("keeps a plugin's detail payload through a commit and a replay", async () => {
		const storage = new MemoryStorage();
		const log = SessionLog.create(storage);
		log.recordMessage(userMsg("first"));
		log.record<Entry>({
			id: "b",
			parentId: null,
			type: "branch_summary",
			fromId: null,
			summary: "came back from a side branch",
			details: { reason: "experiment" },
		} as never);
		await log.commit();

		const reloaded = await SessionLog.load(storage);
		const summary = reloaded.graph.pathOldestFirst().find((entry) => entry.type === "branch_summary")!;
		expect(summary.type).toBe("branch_summary");
		if (summary.type !== "branch_summary") throw new Error("unreachable");
		expect(summary.details).toEqual({ reason: "experiment" });
		expect(summary.fromId).toBeNull();
		// The branch summary replaces the history it stands for.
		expect(reloaded.transcript().map((message) => message.role)).toEqual(["branchSummary"]);
	});
});
