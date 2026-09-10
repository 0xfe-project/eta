/**
 * Output throughput. The shape worth locking down: a run inside a session that
 * has already emitted tens of thousands of output tokens must still read as the
 * rate it is actually producing. Sampling the session total next to a single
 * message's own output is what used to put 25000 tok/s in the panel.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OutputRate } from "../../src/harness/output-rate.ts";

describe("output rate", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("is 0 until the samples span half a second", () => {
		const rate = new OutputRate();
		rate.inFlight(0);
		vi.setSystemTime(400);
		rate.inFlight(16);
		expect(rate.value).toBe(0);
		vi.setSystemTime(500);
		rate.inFlight(20);
		expect(rate.value).toBeCloseTo(40, 5);
	});

	it("tracks a steady stream over the trailing window", () => {
		const rate = new OutputRate();
		rate.inFlight(0);
		for (let ms = 250; ms <= 2_000; ms += 250) {
			vi.setSystemTime(ms);
			rate.inFlight((ms / 1_000) * 40);
		}
		expect(rate.value).toBeCloseTo(40, 5);
	});

	it("holds the rate across message boundaries instead of spiking", () => {
		const rate = new OutputRate();
		let peak = 0;
		const stream = (ms: number, inFlightOut: number) => {
			vi.setSystemTime(ms);
			rate.inFlight(inFlightOut);
			peak = Math.max(peak, rate.value);
		};
		const commit = (ms: number, messageOut: number) => {
			vi.setSystemTime(ms);
			rate.commit(messageOut);
			peak = Math.max(peak, rate.value);
		};

		// Three assistant messages at 100 tok/s, each committing the output it
		// streamed. The per-message counter restarts every message while the base
		// only ever grows by what the provider confirmed, so nothing here can be
		// confused for the session's cumulative total.
		stream(0, 0);
		for (const ms of [1_000, 2_000, 3_000]) stream(ms, (ms / 1_000) * 100);
		expect(rate.value).toBeCloseTo(100, 5);
		commit(3_000, 300);

		for (const ms of [3_500, 4_000, 4_500, 5_000]) stream(ms, ((ms - 3_000) / 1_000) * 100);
		expect(rate.value).toBeCloseTo(100, 5);
		commit(5_000, 200);

		for (const ms of [5_500, 6_000, 6_500, 7_000]) stream(ms, ((ms - 5_000) / 1_000) * 100);
		expect(rate.value).toBeCloseTo(100, 5);
		expect(peak).toBeLessThan(200);
	});

	it("keeps measuring when the streaming estimate overshot the committed count", () => {
		const rate = new OutputRate();
		rate.inFlight(0);
		vi.setSystemTime(1_000);
		rate.inFlight(100);
		expect(rate.value).toBeCloseTo(100, 5);

		// chars/3 guessed 100 tokens, the provider says 20. The series dips; the
		// window is corrected rather than dropped, so the readout stays live.
		rate.commit(20);
		vi.setSystemTime(2_500);
		rate.inFlight(30);
		expect(rate.value).toBeCloseTo(20, 5);
	});

	it("starts over on a new run", () => {
		const rate = new OutputRate();
		rate.inFlight(0);
		vi.setSystemTime(1_000);
		rate.inFlight(50);
		expect(rate.value).toBeCloseTo(50, 5);
		rate.reset();
		expect(rate.value).toBe(0);
		vi.setSystemTime(2_000);
		rate.inFlight(5);
		vi.setSystemTime(3_000);
		rate.inFlight(15);
		expect(rate.value).toBeCloseTo(10, 5);
	});
});
