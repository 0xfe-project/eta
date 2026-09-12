import { describe, expect, it } from "vitest";
import {
	LoopScheduler,
	computeJitter,
	parseEvery,
	DEFAULT_LOOP_TTL_MS,
} from "../../src/harness/loops.ts";
import type { LoopSpec } from "../../src/harness/loops.ts";

interface Over {
	id: string;
	note?: string;
	every?: string;
	maxRuns?: number;
	createdAt?: number;
	on?: LoopSpec["on"];
	expiresAt?: string;
	nextDueAt?: number;
	runCount?: number;
}
function spec(over: Over): LoopSpec {
	return {
		def: { id: over.id, note: over.note ?? `tick ${over.id}`, every: over.every, maxRuns: over.maxRuns },
		runCount: over.runCount ?? 0,
		createdAt: over.createdAt ?? 0,
		paused: false,
		on: over.on,
		expiresAt: over.expiresAt,
		nextDueAt: over.nextDueAt,
	};
}

function sched() {
	return new LoopScheduler({ followUpFor: (s) => `[loop ${s.def.id}] ${s.def.note}` });
}

describe("loop removal", () => {
	it("remove marks the spec disposed and persists so restore cannot revive it", () => {
		const saved: LoopSpec[] = [];
		const s = new LoopScheduler({ followUpFor: (x) => x.def.id, persist: (savedSpec) => saved.push(savedSpec) });
		s.upsert(spec({ id: "L1", every: "5m" }));
		expect(s.remove("L1")).toBe(true);
		const last = saved[saved.length - 1];
		expect(last?.def.id).toBe("L1");
		expect(last?.disposed).toBe(true);
		expect(s.remove("L1")).toBe(false);
	});
});

describe("interval parsing and jitter", () => {
	it("parses duration formats", () => {
		expect(parseEvery("500ms")).toBe(500);
		expect(parseEvery("45s")).toBe(45_000);
		expect(parseEvery("5m")).toBe(300_000);
		expect(parseEvery("2h")).toBe(7_200_000);
		expect(parseEvery("1d")).toBe(86_400_000);
		expect(parseEvery("90")).toBe(90_000);
		expect(() => parseEvery("soon")).toThrow();
	});
	it("jitter is deterministic and under 10%", () => {
		expect(computeJitter("abc", 10_000)).toBe(computeJitter("abc", 10_000));
		expect(computeJitter("abc", 10_000)).toBeLessThanOrEqual(1000);
	});
});

describe("pump", () => {
	it("fires due interval loops once and reschedules", () => {
		const s = sched();
		s.upsert(spec({ id: "l1", every: "1m", createdAt: 0 }));
		const first = s.pump(60_000 + computeJitter("l1", 60_000));
		expect(first.fired.map((f) => f.followUp)).toEqual(["[loop l1] tick l1"]);
		expect(s.pump(60_000 + computeJitter("l1", 60_000)).fired).toEqual([]);
		const next = s.list()[0]!;
		expect(next.nextDueAt).toBeGreaterThan(120_000);
	});
	it("maxRuns pauses with controller_limit semantics", () => {
		const s = sched();
		s.upsert(spec({ id: "cap", every: "1s", createdAt: 0, maxRuns: 2 }));
		const j = computeJitter("cap", 1_000);
		s.pump(1_000 + j);
		s.pump(2_000 + 2 * j);
		const after = s.list()[0]!;
		expect(after.paused).toBe(true);
		expect(after.runCount).toBe(2);
	});
	it("expiry disposes loops (default 7d TTL)", () => {
		const s = sched();
		s.upsert(spec({ id: "old", every: "1d", createdAt: 0 }));
		s.upsert(spec({ id: "exp", createdAt: 0, expiresAt: new Date(50).toISOString(), on: { type: "x" } }));
		const r = s.pump(DEFAULT_LOOP_TTL_MS + 1);
		expect(r.disposed).toContain("old");
		expect(r.disposed).toContain("exp");
		expect(s.list()).toEqual([]);
	});
});

/**
 * The matcher that used to live here is gone. Nothing fed the scheduler a bus event, so
 * `onEvent` was a parameter the model could write and a loop the user could see, sitting
 * in the sidebar with a trigger that fired nothing. Event loops come back with an event
 * vocabulary and a trace depth that outlives the call that fired them — the cap alone
 * was decoration, since every caller passed a depth of zero.
 */
describe("an `on` trigger fires nothing", () => {
	it("leaves an event-only loop armed but unserved, across pumps", () => {
		const s = sched();
		s.upsert(spec({ id: "ev", on: { type: "turn_end", contains: "go" } }));
		expect(s.pump(60_000).fired).toEqual([]);
		expect(s.pump(10 * 60_000).fired).toEqual([]);
		expect(s.list().map((l) => l.runCount)).toEqual([0]);
	});
	it("replay restores the registry after restart", () => {
		const s = sched();
		s.replay([spec({ id: "r1", every: "1m", createdAt: 0, runCount: 4 })]);
		expect(s.list().map((l) => l.runCount)).toEqual([4]);
	});
});
