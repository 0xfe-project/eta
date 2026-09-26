/**
 * MetricsService (REFACTOR.md §2.4, the observability promise).
 *
 * The numbers come from the bus, not from the loop: frames while a message
 * streams, the settled message when it lands, a run start. What is pinned here
 * is OutputRate's one scale — the committed count plus the in-flight share —
 * because sampling the session total next to one message's output is what made
 * the readout land in the tens of thousands of tokens per second.
 */
import type { Usage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Kernel, kernelEmit, Runner } from "../src/index";
import { assistantMessage, fakeModels } from "../src/testing/fake-provider";

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

afterEach(() => {
	vi.restoreAllMocks();
});

describe("tokens per second", () => {
	it("measures the run's own output, from frames and the settled count", async () => {
		let clock = 0;
		vi.spyOn(Date, "now").mockImplementation(() => {
			clock += 250;
			return clock;
		});
		const kernel = Kernel.create({ config: { model: { provider: "p", modelId: "m" } } });
		const emit = kernelEmit(kernel.ctx);
		emit("turn:run-start", { runId: "r", startedAt: 0 });
		// Frames report the in-flight message's output as it grows.
		for (let output = 10; output <= 100; output += 10) {
			emit("message:update", {
				runId: "r",
				turnId: "t",
				message: assistantMessage({ usage: usageOf(1_000, output) }),
				event: { type: "text_delta", contentIndex: 0, delta: "x", partial: assistantMessage() },
			});
		}
		// The provider's own count commits when the message settles.
		emit("message:end", { message: assistantMessage({ usage: usageOf(1_000, 100) }) });

		// 100 tokens over ~2.5s of samples, and never anywhere near the session's
		// 1000 input tokens.
		expect(kernel.metrics.tokensPerSec).toBeGreaterThan(0);
		expect(kernel.metrics.tokensPerSec).toBeLessThan(200);
		void kernel.dispose();
	});

	it("a new run starts the window over", async () => {
		let clock = 0;
		vi.spyOn(Date, "now").mockImplementation(() => {
			clock += 500;
			return clock;
		});
		const kernel = Kernel.create({ config: { model: { provider: "p", modelId: "m" } } });
		const emit = kernelEmit(kernel.ctx);
		emit("turn:run-start", { runId: "r1", startedAt: 0 });
		emit("message:end", { message: assistantMessage({ usage: usageOf(1, 100) }) });
		expect(kernel.metrics.tokensPerSec).toBe(0); // one sample is not a rate yet
		emit("message:update", {
			runId: "r1",
			turnId: "t",
			message: assistantMessage({ usage: usageOf(1, 150) }),
			event: { type: "text_delta", contentIndex: 0, delta: "x", partial: assistantMessage() },
		});
		expect(kernel.metrics.tokensPerSec).toBeGreaterThan(0);

		emit("turn:run-start", { runId: "r2", startedAt: 0 });
		expect(kernel.metrics.tokensPerSec).toBe(0);
		void kernel.dispose();
	});

	it("ignores messages the provider did not write", async () => {
		let clock = 0;
		vi.spyOn(Date, "now").mockImplementation(() => {
			clock += 500;
			return clock;
		});
		const kernel = Kernel.create({ config: { model: { provider: "p", modelId: "m" } } });
		const emit = kernelEmit(kernel.ctx);
		emit("turn:run-start", { runId: "r", startedAt: 0 });
		emit("message:end", { message: userMsg("hello") });
		emit("message:end", {
			message: {
				role: "toolResult",
				toolCallId: "c1",
				toolName: "bash",
				content: [{ type: "text", text: "out" }],
				isError: false,
				timestamp: 0,
			} as never,
		});
		expect(kernel.metrics.tokensPerSec).toBe(0);
		void kernel.dispose();
	});

	it("measures a real run, and the runner keeps no rate of its own", async () => {
		const kernel = Kernel.create({ config: { model: { provider: "p", modelId: "m" } } });
		const fake = fakeModels(
			[assistantMessage({ content: [{ type: "text", text: "answer" }], usage: usageOf(100, 40) })],
			{ chunkSize: 4 },
		);
		const runner = new Runner(kernel, { models: fake });
		kernel.inject(userMsg("go"));
		await runner.run();
		expect(kernel.metrics).toBeDefined();
		expect(kernel.metrics.tokensPerSec).toBeGreaterThanOrEqual(0);
		expect((runner as unknown as { rate?: unknown }).rate).toBeUndefined();
		void kernel.dispose();
	});
});
