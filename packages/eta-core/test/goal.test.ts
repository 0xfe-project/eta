import type { GoalEntry } from "../src/types/entries";
import { Context } from "cordis";
import { describe, expect, it } from "vitest";
import {
  ANTI_SPIN_LIMIT,
  applyGoalEntries,
  GoalService,
  lastMessageShowsIntent,
  MAX_CONTINUATIONS,
} from "../src/kernel/goal";
import { kernelOn } from "../src/types/events";

function withGoal() {
  const ctx = new Context();
  const goal = new GoalService(ctx);
  const events: { name: string; payload: unknown }[] = [];
  const on = kernelOn(ctx);
  const offs = [
    on("goal:changed", (p) =>
      events.push({ name: "goal:changed", payload: p }),
    ),
    on("goal:cleared", (p) =>
      events.push({ name: "goal:cleared", payload: p }),
    ),
  ];
  return {
    ctx,
    goal,
    events,
    dispose: () => {
      for (const off of offs) off();
      void ctx.fiber.dispose();
    },
  };
}

describe("goal state machine", () => {
  it("set makes an active goal; clear removes it", () => {
    const { goal, dispose } = withGoal();
    goal.set("ship M0");
    expect(goal.current?.status).toBe("active");
    goal.clear();
    expect(goal.current).toBeUndefined();
    dispose();
  });

  it("anti-spin pauses after N tool-free turns; tools reset the counter", () => {
    const { goal, dispose } = withGoal();
    goal.set("ship M0");
    for (let i = 0; i < ANTI_SPIN_LIMIT - 1; i++) {
      goal.recordTurnOutcome(false);
    }
    goal.recordTurnOutcome(true);
    expect(goal.current?.status).toBe("active");
    for (let i = 0; i < ANTI_SPIN_LIMIT; i++) goal.recordTurnOutcome(false);
    expect(goal.current?.status).toBe("paused");
    dispose();
  });

  it("anti-spin pause is emitted with reason anti-spin", () => {
    const { goal, events, dispose } = withGoal();
    goal.set("x");
    for (let i = 0; i < ANTI_SPIN_LIMIT; i++) goal.recordTurnOutcome(false);
    const pause = events.at(-1);
    expect(pause?.name).toBe("goal:changed");
    expect(pause?.payload).toMatchObject({
      kind: "pause",
      reason: "anti-spin",
      statusBefore: "active",
    });
    dispose();
  });

  it("resume reactivates and resets the idle counter", () => {
    const { goal, dispose } = withGoal();
    goal.set("x");
    for (let i = 0; i < ANTI_SPIN_LIMIT; i++) goal.recordTurnOutcome(false);
    goal.resume();
    expect(goal.current?.status).toBe("active");
    expect(goal.current?.idleWithoutTools).toBe(0);
    dispose();
  });

  it("auto gate wants continuation until the round cap; delegated never", () => {
    const { goal, dispose } = withGoal();
    goal.set("x");
    expect(goal.wantsContinuation()).toBe(true);
    for (let i = 0; i < MAX_CONTINUATIONS; i++) {
      goal.noteContinuation();
    }
    expect(goal.wantsContinuation()).toBe(false);
    dispose();

    const dctx = new Context();
    const d = new GoalService(dctx);
    d.gate = "delegated";
    d.set("x");
    expect(d.wantsContinuation()).toBe(false);
    void dctx.fiber.dispose();
  });

  it("achieved goals never continue and ignore pause/resume", () => {
    const { goal, dispose } = withGoal();
    goal.set("x");
    goal.markAchieved();
    expect(goal.wantsContinuation()).toBe(false);
    goal.resume();
    expect(goal.current?.status).toBe("achieved");
    dispose();
  });

  it("transitions emit goal:changed / goal:cleared on the bus", () => {
    const { goal, events, dispose } = withGoal();
    goal.set("x");
    for (let i = 0; i < ANTI_SPIN_LIMIT; i++) goal.recordTurnOutcome(false);
    goal.resume();
    expect(events.map((e) => e.name)).toEqual([
      "goal:changed",
      "goal:changed",
      "goal:changed",
    ]);
    expect(
      events.map((e) => (e.payload as { statusBefore: string }).statusBefore),
    ).toEqual(["none", "active", "paused"]);
    goal.clear();
    expect(events.at(-1)?.name).toBe("goal:cleared");
    dispose();
  });
});

describe("replay", () => {
  it("replay honors cleared entries instead of reviving the goal", () => {
    const { goal, dispose } = withGoal();
    applyGoalEntries(goal, [
      {
        id: "1",
        parentId: null,
        seq: 1,
        timestamp: 0,
        type: "goal",
        payload: { kind: "set", objective: "ship M0" },
      },
      {
        id: "2",
        parentId: "1",
        seq: 2,
        timestamp: 0,
        type: "goal",
        payload: { kind: "cleared" },
      },
    ]);
    expect(goal.current).toBeUndefined();
    dispose();
  });

  it("replay restores a full lifecycle with round bookkeeping", () => {
    const { goal, dispose } = withGoal();
    const entries: GoalEntry[] = [
      {
        id: "1",
        parentId: null,
        seq: 1,
        timestamp: 0,
        type: "goal",
        payload: { kind: "set", objective: "x" },
      },
      {
        id: "2",
        parentId: "1",
        seq: 2,
        timestamp: 0,
        type: "goal",
        payload: { kind: "pause", reason: "user" },
      },
      {
        id: "3",
        parentId: "2",
        seq: 3,
        timestamp: 0,
        type: "goal",
        payload: { kind: "resume" },
      },
      {
        id: "4",
        parentId: "3",
        seq: 4,
        timestamp: 0,
        type: "goal",
        payload: { kind: "blocked", reason: "question-pending" },
      },
    ];
    applyGoalEntries(goal, entries);
    expect(goal.current).toMatchObject({
      objective: "x",
      status: "active",
      blockedReason: "question-pending",
    });
    dispose();
  });
});

describe("intent detection", () => {
  it("matches intent phrases case-insensitively", () => {
    expect(lastMessageShowsIntent("Now let me wire the storage layer.")).toBe(
      true,
    );
    expect(lastMessageShowsIntent("Done. The tests pass.")).toBe(false);
  });
});

// Every point below is a line of eta-agent's GoalManager, checked one by one.
describe("goal fidelity against eta-agent's GoalManager", () => {
  it("blockedReason survives a pause and is cleared by resume", () => {
    const { goal, dispose } = withGoal();
    goal.set("wait for an answer");
    goal.setBlockedReason("question-pending");
    expect(goal.current?.blockedReason).toBe("question-pending");

    goal.pause();
    expect(goal.current?.blockedReason).toBe("question-pending");

    goal.resume();
    expect(goal.current?.blockedReason).toBeUndefined();
    expect(goal.current?.idleWithoutTools).toBe(0);
    dispose();
  });

  it("setting a new goal replaces the old one's bookkeeping", () => {
    const { goal, dispose } = withGoal();
    goal.set("first");
    goal.noteContinuation();
    goal.recordTurnOutcome(false);
    expect(goal.current?.roundCount).toBe(1);
    expect(goal.current?.idleWithoutTools).toBe(1);

    goal.set("second");
    expect(goal.current?.objective).toBe("second");
    expect(goal.current?.roundCount).toBe(0);
    expect(goal.current?.idleWithoutTools).toBe(0);
    dispose();
  });

  it("every transition with no goal is a no-op", () => {
    const { goal, events, dispose } = withGoal();
    goal.pause();
    goal.resume();
    goal.markAchieved();
    goal.clear();
    goal.setBlockedReason("question-pending");
    goal.recordTurnOutcome(false);
    expect(goal.current).toBeUndefined();
    expect(events).toEqual([]);
    dispose();
  });

  it("pausing an already paused goal still reports the transition", () => {
    const { goal, events, dispose } = withGoal();
    goal.set("x");
    goal.pause("first reason");
    goal.pause("second reason");
    const pauses = events.filter(
      (event) => (event.payload as { kind: string }).kind === "pause",
    );
    expect(pauses).toHaveLength(2);
    expect(
      pauses.map((event) => (event.payload as { reason?: string }).reason),
    ).toEqual(["first reason", "second reason"]);
    dispose();
  });

  it("recordTurnOutcome does nothing unless the goal is active", () => {
    const { goal, dispose } = withGoal();
    goal.set("x");
    goal.pause();
    goal.recordTurnOutcome(false);
    goal.recordTurnOutcome(false);
    goal.recordTurnOutcome(false);
    expect(goal.current?.status).toBe("paused");
    expect(goal.current?.idleWithoutTools).toBe(0);

    goal.markAchieved();
    goal.recordTurnOutcome(false);
    expect(goal.current?.status).toBe("achieved");
    dispose();
  });

  it("the gate can be switched without disturbing the goal", () => {
    const { goal, dispose } = withGoal();
    goal.set("x");
    expect(goal.wantsContinuation()).toBe(true);

    goal.gate = "delegated";
    expect(goal.wantsContinuation()).toBe(false);
    expect(goal.current?.status).toBe("active");

    goal.gate = "auto";
    expect(goal.wantsContinuation()).toBe(true);
    dispose();
  });

  it("reaching the round cap stops continuation without achieving the goal", () => {
    const { goal, dispose } = withGoal();
    goal.set("x");
    goal.maxContinuations = 2;
    goal.noteContinuation();
    goal.noteContinuation();
    expect(goal.wantsContinuation()).toBe(false);
    expect(goal.current?.status).toBe("active");
    expect(goal.current?.roundCount).toBe(2);
    dispose();
  });

  it("replay ignores unknown payload kinds and applies the known ones in order", () => {
    const { goal, dispose } = withGoal();
    applyGoalEntries(goal, [
      {
        id: "1",
        parentId: null,
        seq: 1,
        timestamp: 0,
        type: "goal",
        payload: { kind: "set", objective: "a" },
      },
      {
        id: "2",
        parentId: "1",
        seq: 2,
        timestamp: 0,
        type: "goal",
        payload: { kind: "pause", reason: "spin" },
      },
      {
        id: "3",
        parentId: "2",
        seq: 3,
        timestamp: 0,
        type: "goal",
        payload: { kind: "resume" },
      },
      {
        id: "4",
        parentId: "3",
        seq: 4,
        timestamp: 0,
        type: "goal",
        payload: { kind: "achieved" },
      },
      {
        id: "5",
        parentId: "4",
        seq: 5,
        timestamp: 0,
        type: "goal",
        payload: { kind: "cleared" },
      },
    ]);
    expect(goal.current).toBeUndefined();
    dispose();
  });
});
