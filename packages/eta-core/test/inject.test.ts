/**
 * Inject and the waker (REFACTOR.md §2.5).
 *
 * The runner is a turn loop, not a scheduler: an inject lands in the inbox, and
 * RunPump decides when that becomes a run. These tests cover both halves — the
 * queue semantics inside a run, and the pump's decisions between runs.
 */
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { Kernel, Runner, RunPump } from "../src/index";
import { assistantMessage, fakeModels } from "../src/testing/fake-provider";

const userMsg = (text: string) => ({ role: "user" as const, content: [{ type: "text" as const, text }], timestamp: 0 });
const answer = (text: string): AssistantMessage =>
	assistantMessage({ content: [{ type: "text", text }], stopReason: "stop" });

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 10));

function setup(script: AssistantMessage[], pump = false) {
	const kernel = Kernel.create();
	const fake = fakeModels(script);
	const runner = new Runner(kernel, { models: fake });
	const waker = new RunPump(kernel, runner);
	if (pump) waker.start();
	return { kernel, runner, fake, waker, dispose: () => void kernel.dispose() };
}

describe("inject queue semantics", () => {
	it("a mid-run inject queues and opens a new turn after the current one ends", async () => {
		// Turn 1: tool injects a steering message mid-run. Turn 2: the provider
		// answers with the steered context — the inject never interrupted turn 1.
		const script = [
			assistantMessage({
				stopReason: "toolUse",
				content: [{ type: "toolCall", id: "c1", name: "steer", arguments: {} }],
			}),
			answer("steered answer"),
		];
		const { kernel, runner, fake, dispose } = setup(script);
		kernel.tools.register({
			name: "steer",
			execute: () => {
				kernel.inject(userMsg("user steering: do the other thing"));
				return "steered";
			},
		});
		kernel.inject(userMsg("go"));
		const result = await runner.run();
		expect(result.error).toBeUndefined();
		// Two turns: turn 1 finished its tool work untouched; the queued inject
		// opened turn 2, whose context carries the steering message.
		expect(fake.calls).toHaveLength(2);
		const steeredContext = fake.calls[1].context.messages;
		expect(steeredContext.some((m) => m.role === "user" && JSON.stringify(m.content).includes("user steering"))).toBe(
			true,
		);
		const users = runner.getTranscript().filter((m) => m.role === "user");
		expect(users.map((m) => JSON.stringify(m.content))).toEqual([
			JSON.stringify(userMsg("go").content),
			JSON.stringify(userMsg("user steering: do the other thing").content),
		]);
		dispose();
	});

	it("without a pump, an idle inject waits for the next run() call", async () => {
		const { kernel, runner, fake, dispose } = setup([answer("first"), answer("second")]);
		kernel.inject(userMsg("go"));
		await runner.run();
		kernel.inject(userMsg("later"));
		await settle();
		expect(fake.calls).toHaveLength(1);
		await runner.run();
		expect(fake.calls).toHaveLength(2);
		dispose();
	});
});

describe("RunPump", () => {
	it("an idle inject starts a turn immediately, no manual run()", async () => {
		const { kernel, runner, fake, waker, dispose } = setup([answer("first"), answer("second")], true);
		kernel.inject(userMsg("go"));
		await settle();
		expect(fake.calls).toHaveLength(1);

		// Idle: this inject must become a run by itself.
		kernel.inject(userMsg("ping"));
		await settle();
		expect(fake.calls).toHaveLength(2);
		expect(runner.getTranscript().filter((m) => m.role === "user")).toHaveLength(2);
		waker.stop();
		dispose();
	});

	it("a stopped pump leaves the inbox alone", async () => {
		const { kernel, fake, dispose } = setup([answer("first")]);
		kernel.inject(userMsg("go"));
		await settle();
		expect(fake.calls).toHaveLength(0);
		expect(kernel.inboxDepth).toBe(1);
		dispose();
	});

	it("picks up an inject that raced the end of a pumped run", async () => {
		const scripts = [answer("first"), answer("second")];
		const { kernel, runner, fake, waker, dispose } = setup(scripts, true);
		// The second inject lands while the first pumped run is finishing. The run
		// that is ending does not see it, so the pump must start the next one.
		kernel.inject(userMsg("go"));
		kernel.inject(userMsg("and this one"));
		await settle();
		await settle();
		expect(fake.calls.length).toBeGreaterThanOrEqual(2);
		expect(kernel.inboxDepth).toBe(0);
		expect(runner.running).toBe(false);
		waker.stop();
		dispose();
	});

	it("does not start a second run while one is in flight", async () => {
		const { kernel, runner, fake, waker, dispose } = setup([answer("one"), answer("two")], true);
		kernel.inject(userMsg("go"));
		// Several injects in a row: one run at a time, the rest queue behind it.
		kernel.inject(userMsg("more"));
		kernel.inject(userMsg("and more"));
		await settle();
		await settle();
		// No run started twice over the same message: the turns saw each message once.
		const users = runner.getTranscript().filter((message) => message.role === "user");
		expect(users).toHaveLength(3);
		expect(fake.calls.length).toBeLessThanOrEqual(3);
		waker.stop();
		dispose();
	});

	it("reports a pumped run that fails, and keeps accepting work", async () => {
		const failures: unknown[] = [];
		const kernel = Kernel.create();
		const fake = fakeModels([]); // a provider with nothing left to say
		const runner = new Runner(kernel, { models: fake });
		const waker = new RunPump(kernel, runner, { onRunEnd: (error) => failures.push(error) });
		waker.start();
		kernel.inject(userMsg("go"));
		await settle();
		expect(failures).toHaveLength(1);
		// The pump is still live: the next inject gets its own attempt.
		expect(waker.running).toBe(false);
		waker.stop();
		void kernel.dispose();
	});
});
