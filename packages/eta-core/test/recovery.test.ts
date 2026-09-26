/**
 * Crash recovery end to end (REFACTOR.md §K5), at the granularity the spec
 * names: the last complete entry is the stable point; a half turn never
 * reaches the journal; committed turns survive a restart intact.
 *
 * The simulation is literal: a `Disk` holds what a filesystem would hold, a
 * storage handle is a process, and a crash means the handle dies with
 * whatever it had already made durable. Nothing survives by being remembered.
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	applyGoalEntries,
	type Entry,
	type GoalEntry,
	Kernel,
	kernelOn,
	MemoryStorage,
	recordGoalEntries,
	SessionLog,
	type StorageService,
	type StorageWrite,
	setValue,
	value,
} from "../src/index.ts";
import { Runner } from "../src/kernel/runner.ts";
import { assistantMessage, fakeProvider } from "../src/testing/fake-provider.ts";

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

/** What a disk holds between processes: the durable write log. */
class Disk {
	writes: StorageWrite[] = [];

	/** A process handle over this disk: seeded with what survived, appending through. */
	connect(): StorageService {
		const inner = new MemoryStorage();
		const rawCommit = inner.commit.bind(inner);
		for (const write of this.writes) void rawCommit([write]);
		const storage: StorageService = Object.create(Object.getPrototypeOf(inner));
		Object.assign(storage, inner);
		storage.commit = async (writes: StorageWrite[]) => {
			const result = await rawCommit(writes);
			this.writes.push(...structuredClone(writes));
			return result;
		};
		return storage;
	}

	/** A fresh process over the same disk after a crash. */
	restart(): StorageService {
		return this.connect();
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

describe("crash recovery — a clean session survives intact", () => {
	it("replays the journal into the same graph, transcript, values, and usage", async () => {
		const disk = new Disk();
		const first = setup(disk, [toolCall("c1", "read"), answer("the answer")]);
		first.kernel.tools.register({ name: "read", execute: () => "file contents" });
		first.kernel.inject(userMsg("what is in the file"));
		await first.runner.run();
		await first.storage.commit([setValue(value<string>("session.model"), "pro6000/k3")]);
		await first.storage.close();

		const log = await SessionLog.load(disk.restart());
		expect(textsOf(log.graph.pathOldestFirst())).toEqual(["what is in the file", "file contents", "the answer"]);
		expect(log.transcript()).toHaveLength(4);
		expect((await log.storage.getValue(value<string>("session.model")))?.value).toBe("pro6000/k3");
	});
});

describe("crash recovery — the half turn is dropped, the committed turns stay", () => {
	it("keeps every completed turn of a crashed run", async () => {
		const disk = new Disk();

		// A completed run first.
		const first = setup(disk, [answer("settled")]);
		first.kernel.inject(userMsg("earlier question"));
		await first.runner.run();
		await first.storage.close();
		const settledWrites = disk.writes.length;

		// A second process gets a turn in, then dies inside the next tool call.
		const second = setup(disk, [toolCall("c1", "read"), toolCall("c2", "explode")]);
		second.kernel.tools.register({ name: "read", execute: () => "file contents" });
		second.kernel.tools.register({
			name: "explode",
			execute: () => {
				throw new SimulatedCrash("the process died here");
			},
		});
		second.kernel.inject(userMsg("keep going"));
		await expect(second.runner.run()).rejects.toBeInstanceOf(SimulatedCrash);

		// The crash happened mid-turn: the exploding tool's result never reached
		// the journal, but the first turn of the run did.
		expect(disk.writes.length).toBeGreaterThan(settledWrites);

		const log = await SessionLog.load(disk.restart());
		const texts = textsOf(log.graph.pathOldestFirst());
		// Everything that was committed is intact — including the crashed run's
		// completed first turn. Only the half turn is gone.
		expect(texts).toEqual(["earlier question", "settled", "keep going", "file contents"]);
		expect(log.transcript().length).toBeGreaterThanOrEqual(4);
	});
});

describe("crash recovery — the kernel rebuilds from the journal", () => {
	it("replays goal entries into a fresh goal service", async () => {
		const disk = new Disk();
		const first = setup(disk, [answer("working on it")]);
		const recorder = recordGoalEntries(first.log, kernelOn(first.kernel.ctx));
		first.kernel.goal.set("ship the kernel");
		first.kernel.inject(userMsg("keep going"));
		await first.runner.run();
		recorder.stop();
		await first.storage.close();

		const log = await SessionLog.load(disk.restart());
		const goalEntries = log.graph.pathOldestFirst().filter((entry): entry is GoalEntry => entry.type === "goal");
		expect(goalEntries.map((entry) => entry.payload.kind)).toEqual(["set"]);

		const restarted = Kernel.create();
		applyGoalEntries(restarted.goal, goalEntries);
		expect(restarted.goal.current?.objective).toBe("ship the kernel");
		expect(restarted.goal.current?.status).toBe("active");
		restarted.dispose();
	});

	it("a runner resumes with the replayed transcript and keeps going", async () => {
		const disk = new Disk();
		const first = setup(disk, [answer("first answer")]);
		first.kernel.inject(userMsg("first question"));
		await first.runner.run();
		await first.storage.close();

		const log = await SessionLog.load(disk.restart());
		const resumedAt = log.transcript().length;
		const kernel = Kernel.create();
		const fake = fakeProvider([answer("second answer")]);
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

		const reloaded = await SessionLog.load(disk.restart());
		expect(reloaded.transcript()).toHaveLength(resumedAt + 2); // the question and the answer
	});
});

describe("crash recovery — the journal is readable while a run is in flight", () => {
	it("a second reader sees committed turns before the run finishes", async () => {
		const disk = new Disk();
		const handle = setup(disk, [toolCall("c1", "slow"), answer("done")]);
		let visibleDuringRun = -1;
		handle.kernel.tools.register({
			name: "slow",
			execute: async () => {
				// Mid-run: the first turn is committed, so a window can render it.
				const reader = await SessionLog.load(disk.restart());
				visibleDuringRun = reader.graph.size();
				return "slow result";
			},
		});
		handle.kernel.inject(userMsg("go"));
		await handle.runner.run();

		expect(visibleDuringRun).toBe(2); // the injected message and the assistant's tool call
		const after = await SessionLog.load(disk.restart());
		expect(after.graph.size()).toBe(visibleDuringRun + 2); // the tool result and the final answer
		await handle.storage.close();
	});
});
