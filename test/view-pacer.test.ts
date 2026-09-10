import { describe, expect, it } from "bun:test";
import { ViewPacer } from "../src/view-pacer.ts";

/**
 * A clock the test winds, plus the timer queue that goes with it: the pacer's
 * whole job is deciding *when*, so nothing here may touch real time.
 */
function fakeClock() {
	let nowMs = 1_000;
	const timers: { at: number; run(): void }[] = [];
	return {
		now: () => nowMs,
		schedule: (run: () => void, ms: number) => {
			const timer = { at: nowMs + ms, run };
			timers.push(timer);
			return timer as unknown as ReturnType<typeof setTimeout>;
		},
		unschedule: (timer: ReturnType<typeof setTimeout>) => {
			const index = timers.indexOf(timer as unknown as { at: number; run(): void });
			if (index >= 0) timers.splice(index, 1);
		},
		advance: (ms: number) => {
			const target = nowMs + ms;
			for (;;) {
				const due = timers.filter((timer) => timer.at <= target).sort((a, b) => a.at - b.at)[0];
				if (due === undefined) break;
				timers.splice(timers.indexOf(due), 1);
				nowMs = due.at;
				due.run();
			}
			nowMs = target;
		},
	};
}

/** A pacer whose frames are the stringified payload the test hands it. */
function harness(options: { floorMs?: number; targetBytesPerSecond?: number } = {}) {
	const clock = fakeClock();
	const delivered: string[] = [];
	let next = "v1";
	let published: string | undefined;
	const pacer = new ViewPacer({
		minIntervalMs: () => options.floorMs ?? 100,
		targetBytesPerSecond: () => options.targetBytesPerSecond ?? 1_000,
		encode: (forced) => {
			if (!forced && next === published) return undefined;
			published = next;
			return next;
		},
		deliver: (payload) => delivered.push(payload),
		now: clock.now,
		schedule: clock.schedule,
		unschedule: clock.unschedule,
	});
	return {
		clock,
		delivered,
		setView(value: string) {
			next = value;
		},
		pacer,
	};
}

describe("ViewPacer", () => {
	it("publishes the first frame straight away", () => {
		const h = harness();
		h.pacer.markDirty();
		expect(h.delivered).toEqual(["v1"]);
	});

	it("coalesces everything inside the floor into one frame carrying the newest view", () => {
		const h = harness({ floorMs: 100 });
		h.pacer.markDirty();
		h.setView("v2");
		h.pacer.markDirty();
		h.setView("v3");
		h.pacer.markDirty();
		expect(h.delivered).toEqual(["v1"]);
		h.clock.advance(120);
		// One frame, and it is the last state — not three frames replaying the run.
		expect(h.delivered).toEqual(["v1", "v3"]);
	});

	it("buys silence in proportion to the frame's own size", () => {
		// 2000 bytes at 1000 B/s is 2s of quiet, well past the 100ms floor.
		const h = harness({ floorMs: 100, targetBytesPerSecond: 1_000 });
		h.setView("x".repeat(2_000));
		h.pacer.markDirty();
		expect(h.delivered).toHaveLength(1);
		h.setView("y".repeat(2_000));
		h.pacer.markDirty();
		h.clock.advance(1_900);
		expect(h.delivered).toHaveLength(1);
		h.clock.advance(200);
		expect(h.delivered[1]?.startsWith("y")).toBe(true);
	});

	it("still delivers the last state when the events stop mid-sentence", () => {
		const h = harness({ floorMs: 100 });
		h.pacer.markDirty();
		h.setView("v2");
		h.pacer.markDirty();
		// Nothing ever marks the pacer dirty again; the trailing timer must fire.
		h.clock.advance(500);
		expect(h.delivered).toEqual(["v1", "v2"]);
	});

	it("forgives the budget on request, so the frame that ends a run is not late", () => {
		const h = harness({ floorMs: 100, targetBytesPerSecond: 1_000 });
		h.setView("x".repeat(5_000));
		h.pacer.markDirty();
		h.setView("final");
		h.pacer.markDirty();
		h.clock.advance(10);
		expect(h.delivered).toHaveLength(1);
		h.pacer.relax();
		h.pacer.markDirty();
		expect(h.delivered[1]).toBe("final");
	});

	it("publishNow re-sends what is already published, because the client may not have it", () => {
		const h = harness();
		h.pacer.markDirty();
		h.pacer.publishNow();
		expect(h.delivered).toEqual(["v1", "v1"]);
	});

	it("stops pacing once disposed", () => {
		const h = harness();
		h.pacer.dispose();
		h.setView("v2");
		h.pacer.markDirty();
		h.pacer.publishNow();
		expect(h.delivered).toEqual([]);
	});
});
