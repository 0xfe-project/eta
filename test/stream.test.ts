/**
 * Streaming generation (REFACTOR.md §2.4 step 3).
 *
 * The runner consumes pi-ai's own stream class, so these tests drive it the
 * way a provider does: frames in order, the settled message at the end. What
 * is asserted is what an observer can see — the delta sequence on the bus, the
 * usage the run accumulates, and the throughput readout.
 */
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Kernel, kernelOn, Runner } from "../src/index";
import { consumeAssistantStream } from "../src/kernel/assistant";
import { assistantMessage, fakeModels } from "@eta/core/testing";

const userMsg = (text: string) => ({
	role: "user" as const,
	content: [{ type: "text" as const, text }],
	timestamp: 0,
});

function setup(script: AssistantMessage[], chunkSize?: number) {
	const kernel = Kernel.create({ config: { model: { provider: "p", modelId: "m" } } });
	const fake = fakeModels(script, chunkSize === undefined ? {} : { chunkSize });
	const runner = new Runner(kernel, { models: fake });
	const updates: { message: unknown; event: { type: string; delta?: string } }[] = [];
	const names: string[] = [];
	const on = kernelOn(kernel.ctx);
	const offs = [
		on("message:start", () => {
			names.push("start");
		}),
		on("message:update", (event) => {
			names.push("update");
			updates.push(event as never);
		}),
		on("message:end", () => {
			names.push("end");
		}),
	];
	return {
		kernel,
		runner,
		fake,
		updates,
		names,
		dispose: () => {
			for (const off of offs) off();
			void kernel.dispose();
		},
	};
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("streaming into the bus", () => {
	it("emits one update per frame, in order, with the delta and the message so far", async () => {
		const settled = assistantMessage({ content: [{ type: "text", text: "hello" }] });
		const { kernel, runner, updates, names, dispose } = setup([settled], 2);
		kernel.inject(userMsg("go"));
		await runner.run();

		// The injected user message settles first, so its `end` opens the sequence;
		// the assistant's stream follows.
		expect(names).toEqual(["end", "start", ...Array.from({ length: 5 }, () => "update"), "end"]);
		expect(updates.map((u) => u.event.type)).toEqual([
			"text_start",
			"text_delta",
			"text_delta",
			"text_delta",
			"text_end",
		]);
		expect(updates.flatMap((u) => (u.event.type === "text_delta" ? [u.event.delta!] : [])).join("")).toBe("hello");
		// Frames are snapshots: the payload carries the message as it stands.
		expect(updates.at(-1)!.message).toMatchObject({ role: "assistant" });
		dispose();
	});

	it("streams thinking and tool-call frames too", async () => {
		const settled = assistantMessage({
			content: [
				{ type: "thinking", thinking: "let me think", thinkingSignature: "sig" },
				{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } },
			],
			stopReason: "toolUse",
		});
		const { kernel, runner, updates, fake, dispose } = setup(
			[settled, assistantMessage({ content: [{ type: "text", text: "done" }] })],
			4,
		);
		kernel.tools.register({ name: "bash", execute: () => "ok" });
		kernel.inject(userMsg("go"));
		await runner.run();

		const types = updates.map((u) => u.event.type);
		expect(types).toContain("thinking_delta");
		expect(types).toContain("toolcall_delta");
		expect(types.indexOf("thinking_delta")).toBeLessThan(types.indexOf("toolcall_delta"));
		const toolJson = updates.flatMap((u) => (u.event.type === "toolcall_delta" ? [u.event.delta!] : [])).join("");
		expect(JSON.parse(toolJson)).toEqual({ command: "ls" });
		// The tool ran after the stream settled, and the second turn streamed too.
		expect(fake.calls).toHaveLength(2);
		dispose();
	});

	it("records the settled message once, after the stream ends", async () => {
		const settled = assistantMessage({ content: [{ type: "text", text: "answer" }] });
		const { kernel, runner, names, dispose } = setup([settled], 3);
		kernel.inject(userMsg("go"));
		await runner.run();
		// One end for the user message, one for the assistant's settled answer.
		expect(names.filter((name) => name === "end")).toHaveLength(2);
		expect(names.at(-1)).toBe("end");
		dispose();
	});
});

describe("usage and throughput", () => {
	it("accumulates the provider's own output count, not the streamed estimate", async () => {
		// The streamed text estimates ~10 tokens; the provider says 3. The run
		// must report the provider's number.
		const settled = assistantMessage({
			content: [{ type: "text", text: "hello there" }],
			usage: {
				input: 100,
				output: 3,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 103,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		});
		const { kernel, runner, dispose } = setup([settled], 1);
		kernel.inject(userMsg("go"));
		await runner.run();
		const transcript = runner.getTranscript();
		const assistant = transcript.find((message) => message.role === "assistant")!;
		expect((assistant as AssistantMessage).usage.output).toBe(3);
		dispose();
	});
});

describe("stream contract", () => {
	it("rejects an update before start", async () => {
		const stream = new AssistantMessageEventStream();
		const message = assistantMessage();
		stream.push({ type: "text_delta", contentIndex: 0, delta: "x", partial: message });
		stream.end(message);
		await expect(
			consumeAssistantStream(stream, { start: () => undefined, update: () => undefined, end: () => undefined }),
		).rejects.toThrow("before start");
	});

	it("rejects a second start", async () => {
		const stream = new AssistantMessageEventStream();
		const message = assistantMessage();
		stream.push({ type: "start", partial: message });
		stream.push({ type: "start", partial: message });
		stream.end(message);
		await expect(
			consumeAssistantStream(stream, { start: () => undefined, update: () => undefined, end: () => undefined }),
		).rejects.toThrow("more than one start");
	});

	it("returns the settled message even when the provider errored", async () => {
		const errored = assistantMessage({ stopReason: "error", errorMessage: "upstream 500" });
		const stream = new AssistantMessageEventStream();
		stream.push({ type: "start", partial: { ...errored, stopReason: "pending" } });
		stream.push({ type: "error", reason: "error", error: errored });
		stream.end(errored);
		const seen: string[] = [];
		const settled = await consumeAssistantStream(stream, {
			start: () => {
				seen.push("start");
			},
			update: () => {
				seen.push("update");
			},
			end: () => {
				seen.push("end");
			},
		});
		expect(settled.stopReason).toBe("error");
		expect(seen).toEqual(["start", "end"]);
	});

	it("fails the run when the stream itself breaks", async () => {
		const kernel = Kernel.create({ config: { model: { provider: "p", modelId: "m" } } });
		const fake = fakeModels([]);
		fake.streamSimple = () => {
			throw new Error("transport exploded");
		};
		const runner = new Runner(kernel, { models: fake });
		kernel.inject(userMsg("go"));
		await expect(runner.run()).rejects.toThrow("transport exploded");
		void kernel.dispose();
	});
});
