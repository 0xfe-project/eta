import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { Kernel, Runner } from "../src/index.ts";
import { assistantMessage, fakeProvider } from "../src/testing/fake-provider.ts";
import type { AgentMessage } from "../src/types/messages.ts";

const userMsg = (text: string) => ({ role: "user" as const, content: [{ type: "text" as const, text }], timestamp: 0 });
const answer = (text: string): AssistantMessage =>
	assistantMessage({ content: [{ type: "text", text }], stopReason: "stop" });

function setup(script: AssistantMessage[], autoPump = false) {
	const kernel = Kernel.create();
	const fake = fakeProvider(script);
	const runner = new Runner(kernel, { providers: fake, model: {} as never, autoPump });
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

	it("an idle inject with autoPump starts a turn immediately, no manual run()", async () => {
		const { kernel, runner, fake, dispose } = setup([answer("first"), answer("second")], true);
		kernel.inject(userMsg("go"));
		await runner.run();
		expect(fake.calls).toHaveLength(1);
		// Idle: this inject must trigger a run by itself.
		kernel.inject(userMsg("ping"));
		await new Promise((r) => setTimeout(r, 10));
		expect(fake.calls).toHaveLength(2);
		expect(runner.getTranscript().filter((m) => m.role === "user")).toHaveLength(2);
		runner.stopAutoPump();
		dispose();
	});

	it("without autoPump, an idle inject waits for the next run() call", async () => {
		const { kernel, runner, fake, dispose } = setup([answer("first"), answer("second")]);
		kernel.inject(userMsg("go"));
		await runner.run();
		kernel.inject(userMsg("later"));
		await new Promise((r) => setTimeout(r, 10));
		expect(fake.calls).toHaveLength(1);
		await runner.run();
		expect(fake.calls).toHaveLength(2);
		dispose();
	});

	it("inject while idle does not double-pump when run() is called right after", async () => {
		const { kernel, runner, fake, dispose } = setup([answer("first"), answer("second")], true);
		kernel.inject(userMsg("go"));
		await runner.run();
		kernel.inject(userMsg("ping"));
		// Race: autoPump and a manual run() both see the queue.
		await Promise.all([runner.run(), new Promise((r) => setTimeout(r, 10))]);
		// The second message was consumed exactly once (autoPump re-run guards on pumping).
		expect(fake.calls).toHaveLength(2);
		expect(runner.getTranscript().filter((m) => m.role === "user")).toHaveLength(2);
		runner.stopAutoPump();
		dispose();
	});
});
