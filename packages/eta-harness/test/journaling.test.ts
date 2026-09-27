/**
 * JournalingService (REFACTOR.md §3 ruling 6, §K5).
 *
 * Durability as a subscriber: the runner emits, this writes. What is pinned
 * here: order (the journal is the event order), the entry ids appearing only
 * once they exist, commits serialized and awaited by flush, usage rows riding
 * in the commit of the message they were spent on, the terminate marker, and
 * that a session without a journal is simply a session that keeps nothing.
 */

import type { Usage } from "@earendil-works/pi-ai";
import {
	type Entry,
	Kernel,
	kernelEmit,
	kernelOn,
	MemoryStorage,
	type MessageEntry,
	Runner,
	SessionLog,
	type StorageService,
	type StorageWrite,
	type UsageRow,
} from "@eta/core";
import { assistantMessage, fakeModels } from "@eta/core/testing";
import { describe, expect, it } from "vitest";
import { JournalingService } from "../src/index";
import { journaledKernel } from "../src/testing";

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

function session(storage: StorageService = new MemoryStorage()) {
	const log = SessionLog.create(storage);
	const { kernel, journaling } = journaledKernel(log, { config: { model: { provider: "p", modelId: "m" } } });
	const added: Entry[] = [];
	const usage: { row: UsageRow; totals: Usage }[] = [];
	const on = kernelOn(kernel.ctx);
	const offs = [
		on("entry:added", (event) => {
			added.push(event.entry);
		}),
		on("usage:recorded", (event) => {
			usage.push(event as never);
		}),
	];
	return {
		kernel,
		log,
		journaling,
		added,
		usage,
		dispose: () => {
			for (const off of offs) off();
			void kernel.dispose();
		},
	};
}

describe("entries from events", () => {
	it("records a message on message:end and announces the id it assigned", async () => {
		const s = session();
		const emit = kernelEmit(s.kernel.ctx);
		emit("message:end", { message: userMsg("first") });
		emit("message:end", { message: userMsg("second") });
		await s.journaling.flush();

		expect(s.added).toHaveLength(2);
		const [first, second] = s.added as MessageEntry[];
		expect(first.id).toBeDefined();
		expect(second.parentId).toBe(first.id);
		// The journal holds the same chain, in order.
		const entries = s.journaling.entries();
		expect(entries.map((entry) => entry.id)).toEqual([first.id, second.id]);
		s.dispose();
	});

	it("marks a terminating message so a replay knows the branch stopped there", async () => {
		const s = session();
		const toolResult = {
			role: "toolResult" as const,
			toolCallId: "c1",
			toolName: "bash",
			content: [{ type: "text" as const, text: "done" }],
			isError: false,
			timestamp: 0,
		};
		kernelEmit(s.kernel.ctx)("message:end", { message: toolResult, terminate: true });
		await s.journaling.flush();
		expect((s.added[0] as MessageEntry).terminate).toBe(true);
		s.dispose();
	});

	it("records a completed compaction entry, and ignores a declined one", async () => {
		const s = session();
		const emit = kernelEmit(s.kernel.ctx);
		emit("compaction:end", {
			runId: "r",
			reason: "threshold",
			endedAt: 0,
			status: "declined",
		});
		emit("compaction:end", {
			runId: "r",
			reason: "threshold",
			endedAt: 0,
			status: "completed",
			summary: "everything before",
			retainedTail: [userMsg("kept")],
			tokensBefore: 100,
		});
		await s.journaling.flush();

		const entries = s.journaling.entries();
		expect(entries).toHaveLength(1);
		const compaction = entries[0]!;
		expect(compaction.type).toBe("compaction");
		if (compaction.type !== "compaction") throw new Error("unreachable");
		expect(compaction.summary).toBe("everything before");
		expect(compaction.tokensBefore).toBe(100);
		// And the transcript a replay builds stands for the history it replaced.
		expect(s.journaling.transcript().map((message) => message.role)).toEqual(["compactionSummary", "user"]);
		s.dispose();
	});

	it("a journaling service without a journal keeps nothing, and says nothing", async () => {
		const kernel = Kernel.create({ config: { model: { provider: "p", modelId: "m" } } });
		// No log behind it: the service is wired, but there is nowhere to write.
		const journaling = new JournalingService(kernel.ctx, {});
		const added: Entry[] = [];
		const off = kernelOn(kernel.ctx)("entry:added", (event) => {
			added.push(event.entry);
		});
		kernelEmit(kernel.ctx)("message:end", { message: userMsg("dropped") });
		await journaling.flush();
		expect(added).toEqual([]);
		expect(journaling.entries()).toEqual([]);
		expect(await journaling.recordUsage(usageOf(1, 1))).toBeUndefined();
		off();
		void kernel.dispose();
	});
});

describe("usage rows", () => {
	it("rides in the commit of the message it was spent on", async () => {
		const s = session();
		const assistant = assistantMessage({ content: [{ type: "text", text: "answer" }], usage: usageOf(100, 20) });
		const emit = kernelEmit(s.kernel.ctx);
		emit("message:end", { message: assistant });
		emit("turn:end", {
			runId: "r",
			turnId: "t",
			message: assistant,
			toolResults: [],
			usage: assistant.usage,
		});
		await s.journaling.flush();

		expect(s.usage).toHaveLength(1);
		const { row, totals } = s.usage[0]!;
		expect(row.entryId).toBe((s.added[0] as MessageEntry).id);
		expect(row.adjustment).toBe(false);
		expect(totals.input).toBe(100);
		// The row is in the journal, not just in the event.
		expect((await s.log.storage.scanUsage({})).map((stored) => stored.id)).toEqual([row.id]);
		s.dispose();
	});

	it("a usage row for an unknown message is not invented", async () => {
		const s = session();
		const stranger = assistantMessage({ usage: usageOf(5, 5) });
		kernelEmit(s.kernel.ctx)("turn:end", {
			runId: "r",
			turnId: "t",
			message: stranger,
			toolResults: [],
			usage: stranger.usage,
		});
		await s.journaling.flush();
		expect(s.usage).toEqual([]);
		expect(await s.log.storage.scanUsage({})).toEqual([]);
		s.dispose();
	});

	it("a correction is an adjustment, and the totals follow", async () => {
		const s = session();
		const assistant = assistantMessage({ content: [{ type: "text", text: "answer" }], usage: usageOf(100, 20) });
		const emit = kernelEmit(s.kernel.ctx);
		emit("message:end", { message: assistant });
		emit("turn:end", {
			runId: "r",
			turnId: "t",
			message: assistant,
			toolResults: [],
			usage: assistant.usage,
		});
		await s.journaling.flush();

		const entryId = (s.added[0] as MessageEntry).id;
		const row = await s.journaling.recordUsage(usageOf(120, 20), { entryId });
		expect(row?.adjustment).toBe(true);
		const stats = await s.log.storage.getStats();
		expect(stats.usage.input).toBe(220);
		s.dispose();
	});
});

describe("commit discipline", () => {
	it("serializes commits so the journal is the event order", async () => {
		const committed: string[] = [];
		const inner = new MemoryStorage();
		const storage: StorageService = Object.create(Object.getPrototypeOf(inner));
		Object.assign(storage, inner);
		const commit = inner.commit.bind(inner);
		storage.commit = async (writes: StorageWrite[]) => {
			// A slow commit must not let a later one land first.
			await new Promise((resolve) => setTimeout(resolve, 5));
			for (const write of writes) {
				if (write.kind === "entry") committed.push(write.entry.id);
			}
			return commit(writes);
		};
		const s = session(storage);
		const emit = kernelEmit(s.kernel.ctx);
		emit("message:end", { message: userMsg("one") });
		await s.journaling.flush();
		emit("message:end", { message: userMsg("two") });
		emit("message:end", { message: userMsg("three") });
		await s.journaling.flush();

		const order = s.journaling.entries().map((entry) => entry.id);
		expect(order).toHaveLength(3);
		// Whatever the batching, the journal received them in event order.
		expect(committed).toEqual(order);
		s.dispose();
	});

	it("reports a failing commit and keeps journaling afterwards", async () => {
		const warnings: string[] = [];
		const inner = new MemoryStorage();
		const storage: StorageService = Object.create(Object.getPrototypeOf(inner));
		Object.assign(storage, inner);
		const commit = inner.commit.bind(inner);
		let failures = 1;
		storage.commit = async (writes: StorageWrite[]) => {
			if (failures > 0) {
				failures -= 1;
				throw new Error("disk on fire");
			}
			return commit(writes);
		};
		const log = SessionLog.create(storage);
		const { kernel, journaling } = journaledKernel(log, {
			config: { model: { provider: "p", modelId: "m" } },
			warn: (message) => warnings.push(message),
		});
		const emit = kernelEmit(kernel.ctx);
		emit("message:end", { message: userMsg("first") });
		await journaling.flush();
		emit("message:end", { message: userMsg("second") });
		await journaling.flush();
		expect(warnings.join(" ")).toContain("disk on fire");
		expect(await log.storage.scanEntries({})).toHaveLength(1);
		void kernel.dispose();
	});

	it("the run boundary waits for the disk, so a finished run is durable", async () => {
		const storage = new MemoryStorage();
		const log = SessionLog.create(storage);
		const { kernel, journaling } = journaledKernel(log, { config: { model: { provider: "p", modelId: "m" } } });
		const fake = fakeModels([assistantMessage({ content: [{ type: "text", text: "done" }] })]);
		const runner = new Runner(kernel, { models: fake, journal: journaling });
		kernel.inject(userMsg("go"));
		await runner.run();
		// No explicit flush in the test: the runner's run end already did it.
		const entries = await storage.scanEntries({});
		expect(entries.length).toBeGreaterThanOrEqual(2);
		void kernel.dispose();
	});
});
