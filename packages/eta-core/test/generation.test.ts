/**
 * generateWithRetry (REFACTOR.md §2.4 step 3).
 *
 * The retry and overflow tests exercise this through the runner; these pin the
 * function's own contract — what it returns, what it retries, when it gives up
 * — without a session around it.
 */
import type { AssistantMessage, Context, Model, Usage } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import {
	DEFAULT_RETRY_POLICY,
	type Emit,
	type GenerateOptions,
	generateWithRetry,
	Kernel,
	kernelEmit,
} from "../src/index";
import { assistantMessage, fakeModels } from "../src/testing/fake-provider";

const usageOf = (input: number, output: number): Usage => ({
	input,
	output,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: input + output,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

const ok = (text: string): AssistantMessage =>
	assistantMessage({ content: [{ type: "text", text }], stopReason: "stop", usage: usageOf(10, 2) });

const transient = (): AssistantMessage =>
	assistantMessage({ stopReason: "error", errorMessage: "upstream 503", usage: usageOf(10, 1) });

const overflow = (): AssistantMessage =>
	assistantMessage({ stopReason: "error", errorMessage: "prompt is too long: 300000 tokens > 200000 maximum" });

function harness(
	script: AssistantMessage[],
	options: {
		recoverOverflow?: () => Promise<boolean>;
		signal?: AbortSignal;
		retryPolicy?: typeof DEFAULT_RETRY_POLICY;
	} = {},
) {
	const kernel = Kernel.create();
	const fake = fakeModels(script);
	const emit: Emit = kernelEmit(kernel.ctx);
	const events: string[] = [];
	const model = {
		provider: "fake",
		id: "fake-model",
		api: "openai-completions",
		contextWindow: 200_000,
		maxTokens: 8_192,
	} as unknown as Model<"openai-completions">;
	fake.getModel = () => model;
	const config: GenerateOptions = {
		models: fake,
		model,
		thinkingLevel: "off",
		signal: options.signal ?? new AbortController().signal,
		retryPolicy: options.retryPolicy ?? DEFAULT_RETRY_POLICY,
		runId: "run",
		turnId: "turn",
		intendedOutputLimit: 8_192,
		contextFor: () => ({ messages: [] }) as Context,
		observer: { update: () => undefined },
		emit: (name, payload) => {
			events.push(name);
			(emit as (n: string, p: unknown) => void)(name, payload);
		},
		recoverOverflow: options.recoverOverflow ?? (() => Promise.resolve(false)),
	};
	return { kernel, fake, config, events, dispose: () => void kernel.dispose() };
}

describe("generateWithRetry", () => {
	it("returns the settled message on a clean stop, first try", async () => {
		const h = harness([ok("answer")]);
		const message = await generateWithRetry(h.config);
		expect(message.content).toEqual([{ type: "text", text: "answer" }]);
		expect(h.fake.calls).toHaveLength(1);
		expect(h.events).toEqual(["prompt:assembled", "message:start"]);
		h.dispose();
	});

	it("backing off and retrying a transient failure announces the schedule", async () => {
		vi.useFakeTimers();
		const h = harness([transient(), ok("recovered")], {
			retryPolicy: { ...DEFAULT_RETRY_POLICY, baseDelayMs: 1_000 },
		});
		const run = generateWithRetry(h.config);
		await vi.advanceTimersByTimeAsync(5_000);
		const message = await run;
		vi.useRealTimers();

		expect(message.content).toEqual([{ type: "text", text: "recovered" }]);
		expect(h.fake.calls).toHaveLength(2);
		expect(h.events.filter((name) => name.startsWith("retry:"))).toEqual([
			"retry:scheduled",
			"retry:start",
			"retry:end",
		]);
		// Both attempts assembled a context: a cut between them would show here.
		expect(h.events.filter((name) => name === "prompt:assembled")).toHaveLength(2);
		h.dispose();
	});

	it("a deterministic failure is returned, not retried", async () => {
		const h = harness([assistantMessage({ stopReason: "error", errorMessage: "401 invalid api key" })]);
		const message = await generateWithRetry(h.config);
		expect(message.stopReason).toBe("error");
		expect(h.fake.calls).toHaveLength(1);
		expect(h.events.some((name) => name.startsWith("retry:"))).toBe(false);
		h.dispose();
	});

	it("an overflow asks for recovery and retries when the history shrank", async () => {
		let recovered = 0;
		const h = harness([overflow(), ok("fits now")], {
			recoverOverflow: async () => {
				recovered += 1;
				return true;
			},
		});
		const message = await generateWithRetry(h.config);
		expect(message.content).toEqual([{ type: "text", text: "fits now" }]);
		expect(recovered).toBe(1);
		// No backoff was scheduled: waiting cannot make a request fit.
		expect(h.events.some((name) => name.startsWith("retry:"))).toBe(false);
		expect(h.fake.calls).toHaveLength(2);
		h.dispose();
	});

	it("returns the overflow when recovery declines", async () => {
		const h = harness([overflow()], { recoverOverflow: async () => false });
		const message = await generateWithRetry(h.config);
		expect(message.stopReason).toBe("error");
		expect(h.fake.calls).toHaveLength(1);
		h.dispose();
	});

	it("gives up when the attempt budget is spent", async () => {
		vi.useFakeTimers();
		const h = harness([transient(), transient(), transient()], {
			retryPolicy: { ...DEFAULT_RETRY_POLICY, maxRetries: 1 },
		});
		const run = generateWithRetry(h.config);
		await vi.advanceTimersByTimeAsync(5_000);
		const message = await run;
		vi.useRealTimers();
		expect(message.stopReason).toBe("error");
		expect(h.fake.calls).toHaveLength(2); // initial + one retry
		expect(h.events).toContain("retry:end");
		h.dispose();
	});

	it("an abort during the backoff ends the wait with the signal's reason", async () => {
		vi.useFakeTimers();
		const controller = new AbortController();
		const h = harness([transient(), ok("never")], { signal: controller.signal });
		const run = generateWithRetry(h.config);
		await vi.advanceTimersByTimeAsync(100);
		const reason = new Error("stopped");
		controller.abort(reason);
		await expect(run).rejects.toBe(reason);
		vi.useRealTimers();
		h.dispose();
	});
});
