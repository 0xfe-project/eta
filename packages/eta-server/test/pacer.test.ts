/**
 * The frame budget (S17).
 *
 * The subject is not "does it send" but "how much": a run streams thousands of events, and
 * every one of them makes the state look different. The pacer's job is that the wire carries a
 * bounded number of bytes per second anyway, and that the frame which does go out is the
 * *newest* state rather than a backlog of stale ones.
 */
import type { ServerFrame } from "@eta/client-wire-proto";
import { describe, expect, it } from "vitest";
import { FramePacer } from "../src/pacer";

/** A clock the test drives, so "how often" is a fact rather than a hope. */
function clock() {
	let now = 0;
	return {
		now: () => now,
		advance: (ms: number) => {
			now += ms;
		},
	};
}

/** A pacer over a scripted source, with the timers captured instead of scheduled. */
function pacer(options: { floor?: number; budget?: number; bytes?: () => number } = {}) {
	const time = clock();
	const delivered: { frame: ServerFrame; at: number }[] = [];
	const timers: { run: () => void; at: number }[] = [];
	let version = 0;
	let sent = -1;
	const made = new FramePacer({
		minIntervalMs: () => options.floor ?? 100,
		...(options.budget === undefined ? {} : { targetBytesPerSecond: options.budget }),
		// The sender's own rule, kept here so the pacer is tested against the answer it really
		// gets: a subscriber that is already current is owed nothing.
		next: () => {
			if (sent === version) return undefined;
			sent = version;
			const bytes = options.bytes?.() ?? 10;
			return { frame: { type: "event", target: "sessions.s1", name: "tick", data: { version } }, bytes };
		},
		deliver: (frame) => delivered.push({ frame, at: time.now() }),
		now: time.now,
		schedule: (run, ms) => {
			const entry = { run, at: time.now() + ms };
			timers.push(entry);
			return entry as never;
		},
		unschedule: (timer) => {
			const index = timers.indexOf(timer as never);
			if (index >= 0) timers.splice(index, 1);
		},
	});
	return {
		pacer: made,
		delivered,
		time,
		bump: () => {
			version += 1;
		},
		/** Fire whatever timer is due now, as a real event loop would. */
		runDue: () => {
			for (const timer of [...timers]) {
				if (timer.at > time.now()) continue;
				timers.splice(timers.indexOf(timer), 1);
				timer.run();
			}
		},
		pendingTimers: () => timers.length,
	};
}

describe("coalescing", () => {
	it("sends the first change at once, and the rest no faster than the floor", () => {
		const h = pacer({ floor: 100 });
		h.pacer.mark();
		expect(h.delivered).toHaveLength(1);

		// Twenty changes inside the floor: nothing more goes out yet.
		for (let index = 0; index < 20; index += 1) {
			h.bump();
			h.pacer.mark();
		}
		expect(h.delivered).toHaveLength(1);

		// The floor passes: one frame, carrying the newest state — not twenty.
		h.time.advance(100);
		h.runDue();
		expect(h.delivered).toHaveLength(2);
	});

	it("always lands the last state, even when the changes stop mid-sentence", () => {
		const h = pacer({ floor: 100 });
		h.pacer.mark();
		h.time.advance(10);
		h.bump();
		h.pacer.mark();
		// Nothing is due yet, so the frame waits on a timer rather than being dropped.
		expect(h.pendingTimers()).toBe(1);
		h.time.advance(90);
		h.runDue();
		expect(h.delivered).toHaveLength(2);
		expect(JSON.stringify(h.delivered[1]?.frame)).toContain('"version":1');
	});

	it("buys silence in proportion to the frame's size", () => {
		// A 100KB frame against a 100KB/s budget buys a second of quiet, whatever the floor says.
		const h = pacer({ floor: 100, budget: 100_000, bytes: () => 100_000 });
		h.pacer.mark();
		expect(h.delivered).toHaveLength(1);
		h.bump();
		h.time.advance(500);
		h.pacer.mark();
		expect(h.delivered).toHaveLength(1);
		h.time.advance(500);
		h.runDue();
		expect(h.delivered).toHaveLength(2);
	});

	it("sends nothing when the state did not actually move", () => {
		const delivered: ServerFrame[] = [];
		const made = new FramePacer({
			minIntervalMs: () => 0,
			// The sender's answer when a subscriber is already current: nothing is owed.
			next: () => undefined,
			deliver: (frame) => delivered.push(frame),
		});
		made.mark();
		made.mark();
		expect(delivered).toEqual([]);
	});

	it("flushes past the floor when someone is waiting for it", () => {
		const h = pacer({ floor: 100 });
		h.pacer.mark();
		h.bump();
		h.pacer.mark();
		// A user clicked something: the frame goes now, still one frame.
		h.pacer.flush();
		expect(h.delivered).toHaveLength(2);
		// And a flush of a state nobody changed sends nothing new.
		h.pacer.flush();
		expect(h.delivered).toHaveLength(2);
	});

	it("stops sending once it is disposed", () => {
		const h = pacer({ floor: 0 });
		h.pacer.dispose();
		h.pacer.mark();
		expect(h.delivered).toEqual([]);
		expect(h.pendingTimers()).toBe(0);
	});

	it("keeps trying when the projection throws, instead of taking the dispatch down", () => {
		let attempts = 0;
		const time = clock();
		const delivered: ServerFrame[] = [];
		const made = new FramePacer({
			minIntervalMs: () => 10,
			next: () => {
				attempts += 1;
				if (attempts === 1) throw new Error("a section that cannot project");
				return { frame: { type: "event", target: "t", name: "n", data: null }, bytes: 1 };
			},
			deliver: (frame) => delivered.push(frame),
			now: time.now,
			schedule: (run, ms) => setTimeout(run, ms) as never,
			unschedule: (timer) => clearTimeout(timer as never),
		});
		made.mark();
		expect(delivered).toEqual([]);
		expect(attempts).toBe(1);
		// The retry goes through the same door as any other frame, and succeeds.
		time.advance(10);
		made.flush();
		expect(delivered).toHaveLength(1);
	});
});
