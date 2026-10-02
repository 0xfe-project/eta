/**
 * Tool execution (REFACTOR.md §2.4 step 4, ported from eta-agent's
 * runSequential/runParallel + tools/file-mutation-queue.ts).
 *
 * Two things are being pinned: the execution mode changes *when* tools run but
 * never the order their results are recorded in, and mutations of the same
 * resource serialize through the keyed queue so a parallel batch cannot
 * clobber one file while two different files still go together.
 */
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { assistantMessage, fakeModels } from "@eta/core/testing";
import { describe, expect, it } from "vitest";
import { Kernel, type KernelTool, MutationQueue, Runner } from "../src/index";

const userMsg = (text: string) => ({
	role: "user" as const,
	content: [{ type: "text" as const, text }],
	timestamp: 0,
});

const toolTurn = (calls: { id: string; name: string }[]) =>
	assistantMessage({
		stopReason: "toolUse",
		content: calls.map((call) => ({ type: "toolCall" as const, ...call, arguments: {} })),
	});

function setup(script: AssistantMessage[], tools: KernelTool[], toolExecution: "sequential" | "parallel") {
	const kernel = Kernel.create({
		config: { model: { provider: "p", modelId: "m" }, toolExecution },
	});
	const fake = fakeModels(script);
	const runner = new Runner(kernel, { models: fake });
	for (const tool of tools) kernel.tools.register(tool);
	return { kernel, runner, fake, dispose: () => void kernel.dispose() };
}

describe("execution modes", () => {
	it("parallel starts every call together", async () => {
		const order: string[] = [];
		const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
		const tools: KernelTool[] = [
			{
				name: "slow",
				execute: async () => {
					order.push("slow:start");
					await sleep(40);
					order.push("slow:end");
					return "slow";
				},
			},
			{
				name: "fast",
				execute: async () => {
					order.push("fast:start");
					await sleep(1);
					order.push("fast:end");
					return "fast";
				},
			},
		];
		const { kernel, runner, dispose } = setup(
			[
				toolTurn([
					{ id: "c1", name: "slow" },
					{ id: "c2", name: "fast" },
				]),
				assistantMessage(),
			],
			tools,
			"parallel",
		);
		kernel.inject(userMsg("go"));
		await runner.run();
		// Both started before either finished: that is what parallel means here.
		expect(order.slice(0, 2).sort()).toEqual(["fast:start", "slow:start"]);
		expect(order).toContain("slow:end");
		dispose();
	});

	it("sequential runs one call to completion before starting the next", async () => {
		const order: string[] = [];
		const tools: KernelTool[] = [
			{
				name: "first",
				execute: () => {
					order.push("first");
					return "first";
				},
			},
			{
				name: "second",
				execute: () => {
					order.push("second");
					return "second";
				},
			},
		];
		const { kernel, runner, dispose } = setup(
			[
				toolTurn([
					{ id: "c1", name: "first" },
					{ id: "c2", name: "second" },
				]),
				assistantMessage(),
			],
			tools,
			"sequential",
		);
		kernel.inject(userMsg("go"));
		await runner.run();
		expect(order).toEqual(["first", "second"]);
		dispose();
	});

	it("records results in call order even when they finish out of order", async () => {
		const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
		const tools: KernelTool[] = [
			{
				name: "slow",
				execute: async () => {
					await sleep(30);
					return "slow result";
				},
			},
			{ name: "fast", execute: () => "fast result" },
		];
		const { kernel, runner, fake, dispose } = setup(
			[
				toolTurn([
					{ id: "c1", name: "slow" },
					{ id: "c2", name: "fast" },
				]),
				assistantMessage(),
			],
			tools,
			"parallel",
		);
		kernel.inject(userMsg("go"));
		await runner.run();

		const second = fake.calls[1]!.context.messages.filter((message) => message.role === "toolResult");
		expect(second.map((message) => (message as { toolName: string }).toolName)).toEqual(["slow", "fast"]);
		dispose();
	});

	it("a failing call does not cancel its siblings", async () => {
		const tools: KernelTool[] = [
			{
				name: "boom",
				execute: () => {
					throw new Error("kaboom");
				},
			},
			{ name: "fine", execute: () => "fine result" },
		];
		const { kernel, runner, fake, dispose } = setup(
			[
				toolTurn([
					{ id: "c1", name: "boom" },
					{ id: "c2", name: "fine" },
				]),
				assistantMessage(),
			],
			tools,
			"parallel",
		);
		kernel.inject(userMsg("go"));
		await runner.run();
		// The throwing tool's failure surfaces as a result; the other one still ran.
		const results = fake.calls[1]!.context.messages.filter((message) => message.role === "toolResult");
		expect(results).toHaveLength(2);
		expect(JSON.stringify(results[0])).toContain("kaboom");
		expect(JSON.stringify(results[1])).toContain("fine result");
		dispose();
	});
});

describe("MutationQueue", () => {
	it("serializes work on one key and lets different keys run together", async () => {
		const queue = new MutationQueue();
		const order: string[] = [];
		const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

		const a = queue.run("file-a", async () => {
			order.push("a:start");
			await sleep(20);
			order.push("a:end");
		});
		const b = queue.run("file-a", async () => {
			order.push("b:start");
			await sleep(1);
			order.push("b:end");
		});
		const c = queue.run("file-b", async () => {
			order.push("c:start");
		});
		await Promise.all([a, b, c]);

		// Same key: never interleaved. Different key: it started before a finished.
		expect(order.indexOf("a:end")).toBeLessThan(order.indexOf("b:start"));
		expect(order.indexOf("c:start")).toBeLessThan(order.indexOf("a:end"));
	});

	it("keeps call order when the keys are resolved asynchronously", async () => {
		const queue = new MutationQueue();
		const ran: string[] = [];
		const resolveKey = async (ms: number, key: string) => {
			await new Promise((resolve) => setTimeout(resolve, ms));
			return key;
		};
		// The first caller resolves its key slowly; it must still queue first.
		const first = queue.run(resolveKey(20, "same"), async () => {
			ran.push("first");
		});
		const second = queue.run(resolveKey(1, "same"), async () => {
			ran.push("second");
		});
		await Promise.all([first, second]);
		expect(ran).toEqual(["first", "second"]);
	});

	it("drops keys once their queue drains", async () => {
		const queue = new MutationQueue();
		await queue.run("a", async () => "x");
		expect(queue.depth).toBe(0);
		// A failure releases the queue rather than wedging it.
		await expect(queue.run("a", async () => Promise.reject(new Error("nope")))).rejects.toThrow("nope");
		expect(queue.depth).toBe(0);
		await expect(queue.run("a", async () => "after the failure")).resolves.toBe("after the failure");
	});

	it("two edits of one file in a parallel batch land in order", async () => {
		const queue = new MutationQueue();
		const file = { content: "start" };
		const edit = (suffix: string) =>
			queue.run("canonical:/tmp/one-file", async () => {
				// Read-modify-write: without the queue the second edit would read the
				// original content and lose the first edit.
				await new Promise((resolve) => setTimeout(resolve, 5));
				file.content = `${file.content}+${suffix}`;
			});

		await Promise.all([edit("first"), edit("second"), edit("third")]);
		expect(file.content).toBe("start+first+second+third");
	});
});
