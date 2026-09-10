import { describe, expect, it } from "vitest";
import { ANTI_SPIN_LIMIT, GoalManager, MAX_CONTINUATIONS, applyGoalEntries, lastMessageShowsIntent } from "../../src/harness/goal.ts";

describe("goal state machine", () => {
	it("set makes an active goal; clear removes it", () => {
		const g = new GoalManager();
		g.set("ship M0");
		expect(g.current?.status).toBe("active");
		g.clear();
		expect(g.current).toBeUndefined();
	});

	it("replay honors cleared entries instead of reviving the goal", () => {
		const g = new GoalManager();
		applyGoalEntries(g, [
			{ type: "goal", payload: { kind: "set", objective: "ship M0" } },
			{ type: "goal", payload: { kind: "cleared", objective: "" } },
		]);
		expect(g.current).toBeUndefined();
	});

	it("anti-spin pauses after N tool-free turns; tools reset the counter", () => {
		const g = new GoalManager();
		g.set("ship M0");
		for (let i = 0; i < ANTI_SPIN_LIMIT - 1; i++) {
			expect(g.recordTurnOutcome(false)).toBe(false);
		}
		expect(g.recordTurnOutcome(true)).toBe(false);
		expect(g.current?.status).toBe("active");
		for (let i = 0; i < ANTI_SPIN_LIMIT; i++) g.recordTurnOutcome(false);
		expect(g.current?.status).toBe("paused");
	});

	it("resume reactivates and resets the idle counter", () => {
		const g = new GoalManager();
		g.set("x");
		for (let i = 0; i < ANTI_SPIN_LIMIT; i++) g.recordTurnOutcome(false);
		g.resume();
		expect(g.current?.status).toBe("active");
		expect(g.current?.idleWithoutTools).toBe(0);
	});

	it("auto gate wants continuation until the round cap; delegated never", () => {
		const g = new GoalManager();
		g.set("x");
		expect(g.wantsContinuation()).toBe(true);
		for (let i = 0; i < MAX_CONTINUATIONS; i++) {
			g.noteContinuation();
		}
		expect(g.wantsContinuation()).toBe(false);
		const d = new GoalManager();
		d.gate = "delegated";
		d.set("x");
		expect(d.wantsContinuation()).toBe(false);
	});

	it("achieved goals never continue and ignore pause/resume", () => {
		const g = new GoalManager();
		g.set("x");
		g.markAchieved();
		expect(g.wantsContinuation()).toBe(false);
		g.resume();
		expect(g.current?.status).toBe("achieved");
	});

	it("onChange fires on transitions", () => {
		const seen: string[] = [];
		const g = new GoalManager();
		g.onChange = (c) => seen.push(`${c.from}->${c.goal.status}`);
		g.set("x");
		for (let i = 0; i < ANTI_SPIN_LIMIT; i++) g.recordTurnOutcome(false);
		g.resume();
		expect(seen).toEqual(["none->active", "active->paused", "paused->active"]);
	});
});

describe("intent detection", () => {
	it("matches intent phrases case-insensitively", () => {
		expect(lastMessageShowsIntent("Now let me wire the storage layer.")).toBe(true);
		expect(lastMessageShowsIntent("Done. The tests pass.")).toBe(false);
	});
});
