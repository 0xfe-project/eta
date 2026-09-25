import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { isEmptyStop, Kernel, Runner } from "../src/index.ts";
import type { KernelTool } from "../src/kernel/tools.ts";
import { assistantMessage, fakeProvider } from "../src/testing/fake-provider.ts";
import type { AgentMessage } from "../src/types/messages.ts";

const userMsg = (text: string) => ({ role: "user" as const, content: [{ type: "text" as const, text }], timestamp: 0 });
const nudge = (kind: string) => (): AgentMessage => userMsg(`[${kind}]`);
const answer = (text: string): AssistantMessage =>
	assistantMessage({ content: [{ type: "text", text }], stopReason: "stop" });

function setup(
	script: AssistantMessage[],
	opts: {
		evaluate?: (o: string, m: readonly AgentMessage[]) => Promise<boolean>;
		maxTurns?: number;
		emptyBudget?: number;
	} = {},
) {
	const kernel = Kernel.create({ maxTurns: opts.maxTurns ?? 200 });
	const fake = fakeProvider(script);
	const runner = new Runner(kernel, {
		providers: fake,
		model: {} as never,
		boundary: {
			evaluate: opts.evaluate ?? (async () => false),
			nudgeEmpty: nudge("resume-empty"),
			nudgeGoal: nudge("goal-continuation"),
			emptyBudget: opts.emptyBudget,
		},
	});
	return { kernel, runner, fake, dispose: () => void kernel.dispose() };
}

describe("run boundary: goal continuation (de-hooked)", () => {
	it("continuation really happens: evaluator says not-achieved, a nudge opens a new turn", async () => {
		// Continuation loops until anti-spin parks the goal: initial + 2 more turns.
		const { kernel, runner, fake, dispose } = setup([answer("step one"), answer("step two"), answer("step three")], {
			evaluate: async () => false,
		});
		kernel.goal.set("ship M0");
		kernel.inject(userMsg("go"));
		await runner.run();
		expect(fake.calls.length).toBeGreaterThanOrEqual(3);
		// The continuation nudge is in the transcript as a user message.
		const texts = runner
			.getTranscript()
			.filter((m) => m.role === "user")
			.map((m) => JSON.stringify(m.content));
		expect(texts.some((t) => t.includes("goal-continuation"))).toBe(true);
		expect(kernel.goal.current?.roundCount).toBe(2);
		dispose();
	});

	it("evaluator says achieved: no continuation, goal marked achieved", async () => {
		const { kernel, runner, fake, dispose } = setup([answer("done")], { evaluate: async () => true });
		kernel.goal.set("ship M0");
		kernel.inject(userMsg("go"));
		await runner.run();
		expect(fake.calls).toHaveLength(1);
		expect(kernel.goal.current?.status).toBe("achieved");
		dispose();
	});

	it("no goal set: boundary is a plain stop", async () => {
		const { kernel, runner, fake, dispose } = setup([answer("plain")]);
		kernel.inject(userMsg("go"));
		await runner.run();
		expect(fake.calls).toHaveLength(1);
		dispose();
	});

	it("delegated gate never self-continues", async () => {
		const { kernel, runner, fake, dispose } = setup([answer("work")], { evaluate: async () => false });
		kernel.goal.gate = "delegated";
		kernel.goal.set("ship M0");
		kernel.inject(userMsg("go"));
		await runner.run();
		expect(fake.calls).toHaveLength(1);
		expect(kernel.goal.current?.status).toBe("active");
		expect(kernel.goal.current?.roundCount).toBe(0);
		dispose();
	});

	it("anti-spin: tool-free continuations pause the goal after the limit", async () => {
		const script = Array.from({ length: 10 }, () => answer("still thinking"));
		const { kernel, runner, fake, dispose } = setup(script, { evaluate: async () => false });
		kernel.goal.set("ship M0");
		kernel.inject(userMsg("go"));
		await runner.run();
		expect(kernel.goal.current?.status).toBe("paused");
		expect(kernel.goal.current?.idleWithoutTools).toBe(3);
		// Pause lands ON the third tool-free boundary, so only two continuations ran.
		expect(fake.calls).toHaveLength(3);
		dispose();
	});

	it("hard cap: active goal past maxContinuations is parked, not left a zombie", async () => {
		const script = Array.from({ length: 20 }, () => answer("more work"));
		const { kernel, runner, dispose } = setup(script, { evaluate: async () => false, maxTurns: 40 });
		kernel.goal.set("x");
		kernel.goal.maxContinuations = 2;
		kernel.inject(userMsg("go"));
		await runner.run();
		expect(kernel.goal.current?.status).toBe("paused");
		expect(kernel.goal.current?.roundCount).toBe(2);
		dispose();
	});

	it("tool work resets the anti-spin counter", async () => {
		const echo: KernelTool = { name: "echo", execute: () => "x" };
		const toolTurn = () =>
			assistantMessage({
				stopReason: "toolUse",
				content: [{ type: "toolCall", id: `c${Math.random()}`, name: "echo", arguments: {} }],
			});
		const { kernel, runner, dispose } = setup([toolTurn(), answer("a"), toolTurn(), answer("b")], {
			evaluate: async () => false,
			maxTurns: 4,
		});
		kernel.tools.register(echo);
		kernel.goal.set("x");
		kernel.inject(userMsg("go"));
		await runner.run();
		// Every boundary saw tool work in its run, so the idle counter kept resetting.
		expect(kernel.goal.current?.status).toBe("active");
		expect(kernel.goal.current?.idleWithoutTools).toBe(0);
		expect(kernel.goal.current?.roundCount).toBe(2);
		dispose();
	});
});

describe("run boundary: empty-response guard", () => {
	const empty = (): AssistantMessage => assistantMessage({ content: [], stopReason: "stop" });

	it("empty stop gets nudged back within the budget, then gives up", async () => {
		const { kernel, runner, fake, dispose } = setup([empty(), empty(), empty(), answer("finally")], {
			evaluate: async () => false,
		});
		kernel.inject(userMsg("go"));
		await runner.run();
		// 3 empty turns nudged (budget 2 → wait: 2 nudges + 1 final empty?) — assert budget semantics:
		// first two empties nudged, third exceeds budget so the run ends on it.
		expect(fake.calls).toHaveLength(3);
		const users = runner.getTranscript().filter((m) => m.role === "user");
		expect(users.filter((m) => JSON.stringify(m.content).includes("resume-empty"))).toHaveLength(2);
		dispose();
	});

	it("a non-empty stop resets the empty budget for the next run", async () => {
		const { kernel, runner, fake, dispose } = setup([empty(), answer("noise"), empty(), answer("fine")]);
		kernel.inject(userMsg("go"));
		await runner.run();
		// Run one ends on the non-empty stop after nudging the first empty.
		expect(fake.calls).toHaveLength(2);
		// Run two: the budget was reset, so the first empty gets nudged again.
		kernel.inject(userMsg("again"));
		await runner.run();
		expect(fake.calls).toHaveLength(4);
		dispose();
	});

	it("isEmptyStop recognizes blank-text and empty-content stops only", () => {
		expect(isEmptyStop(empty())).toBe(true);
		expect(isEmptyStop(answer("   "))).toBe(true);
		expect(isEmptyStop(answer("hi"))).toBe(false);
		expect(isEmptyStop(assistantMessage({ stopReason: "toolUse", content: [] }))).toBe(false);
	});
});
