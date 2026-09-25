/**
 * Crash recovery end to end (REFACTOR.md §K5).
 *
 * The simulation is deliberately literal: a `Disk` holds what a filesystem
 * would hold, a storage handle is a process, and a crash means the handle dies
 * with whatever it had already made durable. Nothing is allowed to survive by
 * being remembered in memory.
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	applyGoalEntries,
	type GoalEntry,
	type JournalCommit,
	Kernel,
	kernelOn,
	MemoryStorage,
	recordGoalEntries,
	SessionLog,
} from "../src/index.ts";
import { Runner } from "../src/kernel/runner.ts";
import { assistantMessage, fakeProvider } from "../src/testing/fake-provider.ts";
import type { Entry } from "../src/types/entries.ts";

class SimulatedCrash extends Error {}

const userMsg = (text: string) => ({
	role: "user" as const,
	content: [{ type: "text" as const, text }],
	timestamp: 0,
});

function answer(text: string): AssistantMessage {
	return assistantMessage({ content: [{ type: "text", text }], stopReason: "stop" });
}

function toolCall(id: string, name: string): AssistantMessage {
	return assistantMessage({ stopReason: "toolUse", content: [{ type: "toolCall", id, name, arguments: {} }] });
}

/** What a disk holds between processes. */
class Disk {
	commits: JournalCommit[] = [];

	/** A handle that appends straight through, like a file opened in append mode. */
	connect(): MemoryStorage {
		const storage = new MemoryStorage();
		const seed = storage;
		for (const commit of this.commits) void seed.append(commit);
		void storage;
		return this.wrap(storage, this);
	}

	private wrap(storage: MemoryStorage, disk: Disk): MemoryStorage {
		const append = storage.append.bind(storage);
		storage.append = async (commit) => {
			await append(commit);
			// The journal the next process sees is exactly what was made durable.
			disk.commits.push(structuredClone(commit));
		};
		return storage;
	}
}

function textsOf(entries: Entry[]): string[] {
	return entries.flatMap((entry) => {
		if (entry.type !== "message") return [];
		const content = entry.message.content;
		if (typeof content === "string") return [content];
		return content.filter((part): part is { type: "text"; text: string } => part.type === "text").map((p) => p.text);
	});
}

function setup(disk: Disk, script: AssistantMessage[]) {
	const storage = disk.connect();
	const log = SessionLog.create(storage);
	const kernel = Kernel.create();
	const fake = fakeProvider(script);
	const runner = new Runner(kernel, { providers: fake, model: {} as never, journal: log });
	return { storage, log, kernel, runner, fake };
}

describe("crash recovery — a clean run survives intact", () => {
	it("replays the journal into the same graph, transcript, and KV state", async () => {
		const disk = new Disk();
		const first = setup(disk, [toolCall("c1", "read"), answer("the answer")]);
		first.kernel.tools.register({ name: "read", execute: () => "file contents" });
		first.kernel.inject(userMsg("what is in the file"));
		await first.runner.run();
		await first.storage.set("session.model", "pro6000/k3");
		// KV written at a boundary; the boundary commit carries it.
		await first.log.endRun({ "session.model": "pro6000/k3" });
		await first.storage.close();

		const after = disk.connect();
		const log = await SessionLog.load(after);
		expect(log.recovered.hadRunInFlight).toBe(false);
		expect(log.recovered.boundaries).toBe(2);
		expect(log.recovered.droppedEntries).toBe(0);

		expect(textsOf(log.graph.pathOldestFirst())).toEqual(["what is in the file", "file contents", "the answer"]);
		expect(log.transcript()).toHaveLength(4);
		expect(await after.get("session.model")).toBe("pro6000/k3");
		await after.close();
	});
});

describe("crash recovery — an aborted run is dropped", () => {
	it("keeps everything before the last boundary and discards the half turn", async () => {
		const disk = new Disk();

		// A completed run first: this is the state that must come back intact.
		const first = setup(disk, [answer("settled")]);
		first.kernel.inject(userMsg("earlier question"));
		await first.runner.run();
		await first.storage.close();
		const settledCommits = disk.commits.length;
		const settledEntries = disk.commits.reduce((total, commit) => total + commit.entries.length, 0);

		// A second process starts a run, gets one turn in, then dies mid-tool.
		const second = setup(disk, [toolCall("c1", "explode"), answer("never reaches disk")]);
		second.kernel.tools.register({
			name: "explode",
			execute: () => {
				throw new SimulatedCrash("the process died here");
			},
		});
		second.kernel.inject(userMsg("run that will not finish"));
		await expect(second.runner.run()).rejects.toBeInstanceOf(SimulatedCrash);

		// The aborted run did reach the journal — recovery has to discard it, not
		// just happen not to have written it.
		expect(disk.commits.length).toBeGreaterThan(settledCommits);
		const inFlight = disk.commits
			.slice(settledCommits)
			.filter((commit) => (commit.values?.["run.started"] as boolean | undefined) === true);
		expect(inFlight).toHaveLength(1);

		const after = disk.connect();
		const log = await SessionLog.load(after);
		expect(log.recovered.hadRunInFlight).toBe(true);
		expect(log.recovered.boundaries).toBe(1);
		expect(log.recovered.droppedCommits).toBe(disk.commits.length - settledCommits);
		expect(log.recovered.droppedEntries).toBeGreaterThan(0);
		// The journal's own markers are metadata, not state to roll back.
		expect(log.recovered.rolledBackValues).toEqual([]);

		// State before the boundary is complete: the earlier turn is all there is.
		const replayed = log.graph.pathOldestFirst();
		expect(replayed).toHaveLength(settledEntries);
		expect(textsOf(replayed)).toEqual(["earlier question", "settled"]);
		expect(textsOf(replayed).some((text) => text.includes("never reaches disk"))).toBe(false);
		expect(textsOf(replayed).some((text) => text.includes("run that will not finish"))).toBe(false);
		await after.close();
	});

	it("rolls back values an aborted run wrote", async () => {
		const disk = new Disk();
		const first = setup(disk, [answer("settled")]);
		first.kernel.inject(userMsg("q"));
		await first.runner.run();
		await first.storage.set("phase", "ready");
		await first.storage.close();

		const second = setup(disk, [toolCall("c1", "explode")]);
		second.kernel.tools.register({
			name: "explode",
			execute: () => {
				void (async () => {
					// The run writes state, then the process dies before a boundary.
					await second.storage.set("phase", "half-migrated");
				})();
				throw new SimulatedCrash();
			},
		});
		second.kernel.inject(userMsg("go"));
		await expect(second.runner.run()).rejects.toBeInstanceOf(SimulatedCrash);
		await second.storage.set("phase", "half-migrated");
		await second.storage.close();

		const after = disk.connect();
		const log = await SessionLog.load(after);
		expect(log.recovered.rolledBackValues).toContain("phase");
		expect(await after.get("phase")).toBe("ready");
		await after.close();
	});
});

describe("crash recovery — the kernel rebuilds from the journal", () => {
	it("replays goal entries into a fresh goal service", async () => {
		const disk = new Disk();
		const first = setup(disk, [answer("working on it")]);
		// Goal changes reach the journal through a subscriber, not by the
		// primitive reaching for storage itself.
		const recorder = recordGoalEntries(first.log, kernelOn(first.kernel.ctx));
		first.kernel.goal.set("ship the kernel");
		first.kernel.inject(userMsg("keep going"));
		await first.runner.run();
		recorder.stop();
		await first.storage.close();

		const after = disk.connect();
		const log = await SessionLog.load(after);
		const goalEntries = log.graph.pathOldestFirst().filter((entry): entry is GoalEntry => entry.type === "goal");
		expect(goalEntries.map((entry) => entry.payload.kind)).toEqual(["set"]);

		const restarted = Kernel.create();
		applyGoalEntries(restarted.goal, goalEntries);
		expect(restarted.goal.current?.objective).toBe("ship the kernel");
		expect(restarted.goal.current?.status).toBe("active");
		restarted.dispose();
		await after.close();
	});

	it("a runner resumes with the replayed transcript and keeps going", async () => {
		const disk = new Disk();
		const first = setup(disk, [answer("first answer")]);
		first.kernel.inject(userMsg("first question"));
		await first.runner.run();
		await first.storage.close();

		const after = disk.connect();
		const log = await SessionLog.load(after);
		const kernel = Kernel.create();
		const fake = fakeProvider([answer("second answer")]);
		const resumedAt = log.transcript().length;
		const runner = new Runner(kernel, {
			providers: fake,
			model: {} as never,
			journal: log,
			initialTranscript: log.transcript(),
		});
		kernel.inject(userMsg("second question"));
		await runner.run();

		// The restored history reached the provider without being journaled twice.
		expect(fake.calls).toHaveLength(1);
		const context = fake.calls[0]!.context.messages;
		expect(context.filter((message) => message.role === "user")).toHaveLength(2);

		const reloaded = await SessionLog.load(disk.connect());
		expect(reloaded.recovered.hadRunInFlight).toBe(false);
		expect(reloaded.transcript()).toHaveLength(resumedAt + 2); // the injected message and the answer
		await after.close();
	});
});

describe("crash recovery — the journal stays readable while a run is in flight", () => {
	it("a second reader sees committed turns before the run finishes", async () => {
		const disk = new Disk();
		const handle = setup(disk, [toolCall("c1", "slow"), answer("done")]);
		let visibleDuringRun = -1;
		handle.kernel.tools.register({
			name: "slow",
			execute: async () => {
				// Mid-run: the first turn is committed, so a window can render it.
				const reader = await SessionLog.view(disk.connect());
				expect(reader.recovered.hadRunInFlight).toBe(true);
				visibleDuringRun = reader.graph.size();
				return "slow result";
			},
		});
		handle.kernel.inject(userMsg("go"));
		await handle.runner.run();

		expect(visibleDuringRun).toBe(2); // the injected message and the assistant's tool call
		const after = await SessionLog.load(disk.connect());
		expect(after.recovered.hadRunInFlight).toBe(false);
		expect(after.graph.size()).toBe(visibleDuringRun + 2); // the tool result and the final answer
		await handle.storage.close();
	});
});
