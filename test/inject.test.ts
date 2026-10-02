/**
 * Inject and the waker (REFACTOR.md §2.5).
 *
 * The runner is a turn loop, not a scheduler: an inject lands in the inbox, and
 * what becomes a run is decided outside it. This file covers the queue
 * semantics inside a run; the idle waker's decisions between runs are tested in
 * the harness, where the pump lives.
 */
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { Kernel, Runner } from "../src/index";
import { assistantMessage, fakeModels } from "@eta/core/testing";

const userMsg = (text: string) => ({ role: "user" as const, content: [{ type: "text" as const, text }], timestamp: 0 });
const answer = (text: string): AssistantMessage =>
	assistantMessage({ content: [{ type: "text", text }], stopReason: "stop" });

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 10));

function setup(script: AssistantMessage[]) {
	const kernel = Kernel.create();
	const fake = fakeModels(script);
	const runner = new Runner(kernel, { models: fake });
	return { kernel, runner, fake, dispose: () => void kernel.dispose() };
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
