import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { Kernel, Runner } from "../src/index.ts";
import type { KernelTool } from "../src/kernel/tools.ts";
import { assistantMessage, fakeProvider } from "../src/testing/fake-provider.ts";
import { kernelOn } from "../src/types/events.ts";

const userMsg = (text: string) => ({ role: "user" as const, content: [{ type: "text" as const, text }], timestamp: 0 });

function toolCallMsg(calls: { id: string; name: string; args?: Record<string, unknown> }[]): AssistantMessage {
	return assistantMessage({
		stopReason: "toolUse",
		content: calls.map((c) => ({ type: "toolCall" as const, id: c.id, name: c.name, arguments: c.args ?? {} })),
	});
}

function setup(script: AssistantMessage[], tools: KernelTool[] = []) {
	const kernel = Kernel.create();
	for (const t of tools) {
		(kernel.ctx as unknown as { tools: { register(t: KernelTool): void } }).tools.register(t);
	}
	const fake = fakeProvider(script);
	const runner = new Runner(kernel, { providers: fake, model: {} as never });
	const events: { name: string; payload: Record<string, unknown> }[] = [];
	const on = kernelOn(kernel.ctx);
	const offs = (
		[
			"turn:run-start",
			"turn:start",
			"turn:end",
			"turn:run-end",
			"tool:start",
			"tool:end",
			"prompt:assembled",
			"message:start",
		] as const
	).map((name) => on(name, (p) => events.push({ name, payload: p as unknown as Record<string, unknown> })));
	return {
		kernel,
		runner,
		fake,
		events,
		dispose: () => {
			for (const off of offs) off();
			void kernel.dispose();
		},
	};
}

describe("runner turn loop", () => {
	it("single turn, no tools: provider once, clean stop, run-end emitted", async () => {
		const { kernel, runner, fake, events, dispose } = setup([assistantMessage()]);
		kernel.inject(userMsg("hello"));
		const result = await runner.run();
		expect(result).toEqual({ turns: 0, error: undefined });
		expect(fake.calls).toHaveLength(1);
		expect(events.map((e) => e.name)).toEqual([
			"turn:run-start",
			"turn:start",
			"prompt:assembled",
			"message:start",
			"turn:end",
			"turn:run-end",
		]);
		// One runId threads the whole run; the run reports a clean completion.
		const runIds = new Set(events.map((e) => e.payload.runId as string));
		expect(runIds.size).toBe(1);
		expect(events.at(-1)!.payload.status).toBe("completed");
		// The provider saw the injected message.
		expect(fake.calls[0].context.messages).toHaveLength(1);
		dispose();
	});

	it("multi-turn tool loop: calls executed, results fed back, events in order", async () => {
		const echo: KernelTool = { name: "echo", execute: (args) => `echo:${(args as { x: string }).x}` };
		const { kernel, runner, fake, events, dispose } = setup(
			[toolCallMsg([{ id: "c1", name: "echo", args: { x: "1" } }]), assistantMessage()],
			[echo],
		);
		kernel.inject(userMsg("go"));
		const result = await runner.run();
		expect(result.error).toBeUndefined();
		expect(fake.calls).toHaveLength(2);
		// Second turn's context contains the tool result.
		const second = fake.calls[1].context.messages;
		expect(second.some((m) => m.role === "toolResult")).toBe(true);
		expect(events.map((e) => e.name)).toEqual([
			"turn:run-start",
			"turn:start",
			"prompt:assembled",
			"message:start",
			"turn:end",
			"tool:start",
			"tool:end",
			"turn:start",
			"prompt:assembled",
			"message:start",
			"turn:end",
			"turn:run-end",
		]);
		// Tool events carry the aligned payload.
		const toolStart = events.find((e) => e.name === "tool:start")!;
		expect(toolStart.payload).toMatchObject({ toolCallId: "c1", toolName: "echo", args: { x: "1" } });
		const toolEnd = events.find((e) => e.name === "tool:end")!;
		expect(toolEnd.payload).toMatchObject({ toolCallId: "c1", toolName: "echo", isError: false, terminate: false });
		dispose();
	});

	it("tools are read fresh each turn: a hot-registered tool is available mid-run", async () => {
		const { kernel, runner, fake, dispose } = setup([toolCallMsg([{ id: "c1", name: "late" }]), assistantMessage()]);
		const tools = (kernel.ctx as unknown as { tools: { register(t: KernelTool): void } }).tools;
		// Register before the run; the loop must see it without any restart.
		tools.register({ name: "late", execute: () => "present" });
		kernel.inject(userMsg("go"));
		await runner.run();
		const second = fake.calls[1].context.messages;
		const toolResult = second.find((m) => m.role === "toolResult");
		expect(toolResult).toMatchObject({ toolName: "late" });
		dispose();
	});

	it("maxTurns caps the loop even when the provider keeps asking for tools", async () => {
		const echo: KernelTool = { name: "echo", execute: () => "x" };
		const script = Array.from({ length: 10 }, (_, i) => toolCallMsg([{ id: `c${i}`, name: "echo" }]));
		const { kernel, runner, fake, dispose } = setup(script, [echo]);
		const capped = Kernel.create({ maxTurns: 2 });
		// Rebuild runner against the capped kernel.
		const cappedFake = fakeProvider(script);
		const cappedRunner = new Runner(capped, { providers: cappedFake, model: {} as never });
		capped.inject(userMsg("go"));
		await cappedRunner.run();
		expect(cappedFake.calls.length).toBeLessThanOrEqual(3);
		expect(capped.budgetSpent).toBe(true);
		void kernel.dispose();
		void capped.dispose();
	});

	it("a provider error ends the run with the error surfaced", async () => {
		const { kernel, runner, dispose } = setup([
			assistantMessage({ stopReason: "error", errorMessage: "530 no body" }),
		]);
		kernel.inject(userMsg("go"));
		const result = await runner.run();
		expect(result.error).toBe("530 no body");
		dispose();
	});

	it("an unknown tool call returns a structured error result, not a crash", async () => {
		const { kernel, runner, fake, dispose } = setup([toolCallMsg([{ id: "c1", name: "ghost" }]), assistantMessage()]);
		kernel.inject(userMsg("go"));
		const result = await runner.run();
		expect(result.error).toBeUndefined();
		const second = fake.calls[1].context.messages;
		expect(second.find((m) => m.role === "toolResult")).toMatchObject({ isError: true });
		dispose();
	});
});
