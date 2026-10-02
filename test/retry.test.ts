/**
 * Retry semantics (REFACTOR.md §2.4 step 3, ported from eta-agent's
 * drive/response.ts + drive/retry.ts).
 *
 * The classification is pi-ai's: a transient transport failure gets another
 * attempt with exponential backoff; a deterministic one — auth, config, an
 * account limit — ends the run immediately. A failed attempt is never
 * journaled, so it cannot leak into the context the next attempt sends.
 */
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	DEFAULT_MAX_AGENT_RETRY_DELAY_MS,
	DEFAULT_RETRY_POLICY,
	kernelOn,
	normalizedRetryPolicy,
	Runner,
	retryDelayMs,
	retryNotBefore,
	waitUntil,
} from "@eta/core";
import { SessionLog } from "@eta/core/session";
import { MemoryStorage } from "@eta/core/storage";
import { assistantMessage, fakeModels } from "@eta/core/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { journaledKernel } from "../src/testing";

const userMsg = (text: string) => ({
	role: "user" as const,
	content: [{ type: "text" as const, text }],
	timestamp: 0,
});

/** A provider failure pi-ai classifies as transient. */
const transient = (message = "upstream 500 internal server error"): AssistantMessage =>
	assistantMessage({ stopReason: "error", errorMessage: message });

/** A provider failure that must never be retried. */
const deterministic = (message = "401 invalid api key"): AssistantMessage =>
	assistantMessage({ stopReason: "error", errorMessage: message });

const ok = (text: string): AssistantMessage =>
	assistantMessage({ content: [{ type: "text", text }], stopReason: "stop" });

function setup(script: AssistantMessage[], retryPolicy = DEFAULT_RETRY_POLICY) {
	const log = SessionLog.create(new MemoryStorage());
	const { kernel, journaling } = journaledKernel(log, {
		config: { model: { provider: "p", modelId: "m" }, retryPolicy: { ...retryPolicy } },
	});
	const fake = fakeModels(script);
	const runner = new Runner(kernel, { models: fake, journal: journaling });
	const retries: { name: string; payload: Record<string, unknown> }[] = [];
	const on = kernelOn(kernel.ctx);
	const offs = (["retry:scheduled", "retry:start", "retry:end"] as const).map((name) =>
		on(name, (payload) => {
			retries.push({ name, payload: payload as unknown as Record<string, unknown> });
		}),
	);
	return {
		kernel,
		runner,
		fake,
		journal: journaling,
		retries,
		dispose: () => {
			for (const off of offs) off();
			void kernel.dispose();
		},
	};
}

describe("retry policy math", () => {
	it("normalizes the attempt budget: a disabled policy means one attempt", () => {
		expect(normalizedRetryPolicy(DEFAULT_RETRY_POLICY)).toEqual({
			maxAttempts: 4,
			baseDelayMs: 1_000,
			maxAgentDelayMs: DEFAULT_MAX_AGENT_RETRY_DELAY_MS,
		});
		expect(normalizedRetryPolicy({ ...DEFAULT_RETRY_POLICY, enabled: false }).maxAttempts).toBe(1);
		expect(normalizedRetryPolicy({ ...DEFAULT_RETRY_POLICY, maxRetries: 0 }).maxAttempts).toBe(1);
	});

	it("backs off exponentially and caps at the agent ceiling", () => {
		const policy = { baseDelayMs: 1_000, maxAgentDelayMs: 60_000 };
		expect([1, 2, 3, 4, 5].map((attempt) => retryDelayMs(policy, attempt))).toEqual([
			1_000, 2_000, 4_000, 8_000, 16_000,
		]);
		// 2^10 seconds is over the ceiling, and stays there.
		expect(retryDelayMs(policy, 11)).toBe(60_000);
		expect(retryDelayMs({ baseDelayMs: 1_000 }, 20)).toBe(DEFAULT_MAX_AGENT_RETRY_DELAY_MS);
	});

	it("computes the wall-clock instant a retry may start", () => {
		expect(retryNotBefore({ baseDelayMs: 1_000 }, 1, 1_000)).toBe(2_000);
		expect(retryNotBefore({ baseDelayMs: 1_000 }, 3, 1_000)).toBe(5_000);
		// The delay is capped, so a far-out attempt still lands on a real instant…
		expect(retryNotBefore({ baseDelayMs: 1_000 }, 40, 1_000)).toBe(61_000);
		// …and a deliberately uncapped ceiling is what would overflow, so it clamps.
		expect(retryNotBefore({ baseDelayMs: 1_000, maxAgentDelayMs: Number.MAX_SAFE_INTEGER }, 54, 1_000)).toBe(
			Number.MAX_SAFE_INTEGER,
		);
	});
});

describe("waitUntil", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("resolves once the instant passes", async () => {
		const signal = new AbortController().signal;
		let done = false;
		const wait = waitUntil(Date.now() + 1_000, signal).then(() => {
			done = true;
		});
		await vi.advanceTimersByTimeAsync(999);
		expect(done).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		await wait;
		expect(done).toBe(true);
	});

	it("resolves immediately when the instant is already past", async () => {
		await expect(waitUntil(Date.now() - 1, new AbortController().signal)).resolves.toBeUndefined();
	});

	it("rejects with the signal's reason when aborted", async () => {
		const controller = new AbortController();
		const reason = new Error("user pressed stop");
		const wait = waitUntil(Date.now() + 60_000, controller.signal);
		controller.abort(reason);
		await expect(wait).rejects.toBe(reason);
	});

	it("rejects right away when the signal is already aborted", async () => {
		const controller = new AbortController();
		controller.abort(new Error("already gone"));
		await expect(waitUntil(Date.now() + 60_000, controller.signal)).rejects.toThrow("already gone");
	});
});

describe("retrying generation", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("retries a transient failure and succeeds, reporting the backoff", async () => {
		const { kernel, runner, fake, retries, journal: journaling, dispose } = setup([transient(), ok("recovered")]);
		kernel.inject(userMsg("go"));
		const run = runner.run();
		await vi.advanceTimersByTimeAsync(5_000);
		const result = await run;

		expect(result.error).toBeUndefined();
		expect(fake.calls).toHaveLength(2);
		expect(retries.map((r) => r.name)).toEqual(["retry:scheduled", "retry:start", "retry:end"]);
		expect(retries[0]!.payload).toMatchObject({
			attempt: 2,
			maxAttempts: 4,
			delayMs: 1_000,
			errorMessage: "upstream 500 internal server error",
		});
		expect(retries[2]!.payload).toMatchObject({ attempt: 2, success: true });

		// Only the successful attempt is history.
		const transcript = journaling.transcript();
		expect(transcript.filter((message) => message.role === "assistant")).toHaveLength(1);
		expect(JSON.stringify(transcript)).toContain("recovered");
		expect(JSON.stringify(transcript)).not.toContain("500");
		dispose();
	});

	it("backs off further on each further failure", async () => {
		const { kernel, runner, retries, dispose } = setup([transient(), transient(), ok("third time")]);
		kernel.inject(userMsg("go"));
		const run = runner.run();
		await vi.advanceTimersByTimeAsync(10_000);
		await run;
		const scheduled = retries.filter((r) => r.name === "retry:scheduled");
		expect(scheduled.map((r) => r.payload.delayMs)).toEqual([1_000, 2_000]);
		expect(scheduled.map((r) => r.payload.attempt)).toEqual([2, 3]);
		dispose();
	});

	it("does not retry a deterministic failure", async () => {
		const { kernel, runner, fake, retries, dispose } = setup([deterministic()]);
		kernel.inject(userMsg("go"));
		const result = await runner.run();
		expect(result.error).toContain("401 invalid api key");
		expect(fake.calls).toHaveLength(1);
		expect(retries).toEqual([]);
		dispose();
	});

	it("does not retry when the policy is disabled", async () => {
		const { kernel, runner, fake, retries, dispose } = setup([transient()], {
			...DEFAULT_RETRY_POLICY,
			enabled: false,
		});
		kernel.inject(userMsg("go"));
		const result = await runner.run();
		expect(result.error).toContain("500");
		expect(fake.calls).toHaveLength(1);
		expect(retries).toEqual([]);
		dispose();
	});

	it("gives up after the attempt budget and reports the final failure", async () => {
		const { kernel, runner, fake, retries, dispose } = setup([transient(), transient(), transient()], {
			...DEFAULT_RETRY_POLICY,
			maxRetries: 2,
		});
		kernel.inject(userMsg("go"));
		const run = runner.run();
		await vi.advanceTimersByTimeAsync(10_000);
		const result = await run;
		expect(result.error).toContain("500");
		expect(fake.calls).toHaveLength(3); // initial + 2 retries
		const end = retries.at(-1)!;
		expect(end.name).toBe("retry:end");
		expect(end.payload).toMatchObject({ attempt: 3, success: false, finalError: expect.stringContaining("500") });
		dispose();
	});

	it("abort during a backoff ends the run instead of waiting it out", async () => {
		const { kernel, runner, retries, dispose } = setup([transient(), ok("never reached")]);
		kernel.inject(userMsg("go"));
		const run = runner.run();
		// Let the failure land and the backoff begin, then stop the run.
		await vi.advanceTimersByTimeAsync(100);
		expect(retries.map((r) => r.name)).toEqual(["retry:scheduled"]);
		runner.abort();
		const result = await run;
		// Cancelling is not a failure: the run stops where it was.
		expect(result.status).toBe("aborted");
		expect(result.error).toBeUndefined();
		dispose();
	});
});
