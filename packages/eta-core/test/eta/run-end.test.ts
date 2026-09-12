import { describe, expect, it, vi } from "vitest";
import type { AgentMessage } from "../../src/types.ts";
import { GoalManager } from "../../src/harness/goal.ts";
import { emptyResponseGuard, goalDriver, isEmptyStop, loopDriver } from "../../src/harness/drivers.ts";
import { HookRegistry } from "../../src/harness/hooks.ts";
import type { HookInvocation } from "../../src/harness/agent-harness.ts";
import { createGate } from "../../src/harness/execution/effect-gate.ts";
import { BACKGROUND_CONTEXT } from "../../src/harness/context.ts";
import { LoopScheduler, type LoopSpec } from "../../src/harness/loops.ts";
import { loopFollowUp } from "../../src/prompts/loops.ts";
import { GOAL_CONTINUATION, RESUME_EMPTY } from "../../src/prompts/index.ts";

const user = { role: "user", content: "do it", timestamp: 0 } as unknown as AgentMessage;
const empty = { role: "assistant", stopReason: "stop", content: [] } as unknown as AgentMessage;
const said = {
	role: "assistant",
	stopReason: "stop",
	content: [{ type: "text", text: "done!" }],
} as unknown as AgentMessage;
const worked = {
	role: "assistant",
	stopReason: "toolUse",
	content: [{ type: "toolCall", id: "1", name: "read", arguments: {} }],
} as unknown as AgentMessage;

describe("goal driver (before_run_end)", () => {
	it("enqueues a continuation followUp when the evaluator says not achieved", async () => {
		const goal = new GoalManager();
		goal.set("ship M1");
		const handler = goalDriver({ goal, evaluate: async () => false });
		const out = await handler({ messages: [user, worked] });
		expect(out).toEqual({ followUp: GOAL_CONTINUATION });
		expect(goal.current?.roundCount).toBe(1);
	});

	it("achieved goals stop the run", async () => {
		const goal = new GoalManager();
		goal.set("ship M1");
		const handler = goalDriver({ goal, evaluate: async () => true });
		expect(await handler({ messages: [user, worked] })).toBeUndefined();
		expect(goal.current?.status).toBe("achieved");
	});

	it("anti-spin pause silences the driver", async () => {
		const goal = new GoalManager();
		goal.set("ship M1");
		const evaluate = vi.fn(async () => false);
		const handler = goalDriver({ goal, evaluate });
		expect(await handler({ messages: [user, said] })).toEqual({ followUp: GOAL_CONTINUATION });
		expect(await handler({ messages: [user, said] })).toEqual({ followUp: GOAL_CONTINUATION });
		expect(await handler({ messages: [user, said] })).toBeUndefined();
		expect(evaluate).toHaveBeenCalledTimes(2);
		expect(goal.current?.status).toBe("paused");
	});

	it("inactive manager is a no-op", async () => {
		const goal = new GoalManager();
		const handler = goalDriver({ goal, evaluate: async () => false });
		expect(await handler({ messages: [user, said] })).toBeUndefined();
	});
});

describe("empty response guard", () => {
	it("nudges back within budget and resets after a real answer", () => {
		const guard = emptyResponseGuard(2);
		expect(guard({ messages: [user, empty] })).toEqual({ followUp: RESUME_EMPTY });
		expect(guard({ messages: [user, empty] })).toEqual({ followUp: RESUME_EMPTY });
		expect(guard({ messages: [user, empty] })).toBeUndefined();
		expect(guard({ messages: [user, said] })).toBeUndefined();
		expect(guard({ messages: [user, empty] })).toEqual({ followUp: RESUME_EMPTY });
	});

	it("only clean empty stops count", () => {
		expect(isEmptyStop(empty)).toBe(true);
		expect(isEmptyStop(said)).toBe(false);
		expect(isEmptyStop({ role: "assistant", stopReason: "error", content: [] } as unknown as AgentMessage)).toBe(
			false,
		);
		expect(
			isEmptyStop({
				role: "assistant",
				stopReason: "stop",
				content: [{ type: "text", text: "  " }],
			} as unknown as AgentMessage),
		).toBe(true);
	});
});

/**
 * One followUp slot, several batteries that want the run to keep going. What is guarded
 * here is not the string: it is that a driver charged for a continuation (a goal round
 * counted, a loop fire counted) is not then left unserved. An active goal losing its
 * continuation to a loop that happened to come due is exactly that, and it leaves the
 * goal one round nearer paused with nothing done for it.
 */
describe("run-end aggregation", () => {
	const dueLoop = () => {
		const scheduler = new LoopScheduler({ followUpFor: (spec) => loopFollowUp(spec.def.id, spec.def.note) });
		// Created hours ago on an hourly cadence: overdue now, and the next fire is an
		// hour out — a loop made at the epoch would be past its 7-day TTL on arrival.
		scheduler.upsert({
			def: { id: "l1", note: "stand up", every: "1h" },
			runCount: 0,
			createdAt: Date.now() - 3 * 3600_000,
			paused: false,
		});
		return scheduler;
	};

	const runEnd = async (hooks: HookRegistry, messages: AgentMessage[]) => {
		const { gate } = createGate();
		const event: HookInvocation<"before_run_end"> = { lane: "main", runId: "r1", messages };
		return await hooks.runWithGate("before_run_end", event, gate, BACKGROUND_CONTEXT);
	};

	it("carries the goal's continuation and the loop's note in one followUp", async () => {
		const goal = new GoalManager();
		goal.set("ship M1");
		const loops = dueLoop();
		const hooks = new HookRegistry(() => {});
		hooks.on("before_run_end", goalDriver({ goal, evaluate: async () => false }), { id: "eta.goal" });
		hooks.on("before_run_end", loopDriver(loops), { id: "eta.loop" });

		const out = await runEnd(hooks, [user, worked]);
		expect(out?.followUp).toContain(GOAL_CONTINUATION);
		expect(out?.followUp).toContain("[loop l1] stand up");
		// Both drivers were charged for this boundary, so both are served by it.
		expect(goal.current?.roundCount).toBe(1);
		expect(loops.list()[0]?.runCount).toBe(1);
	});

	it("keeps the empty-response nudge alongside the goal's continuation", async () => {
		const goal = new GoalManager();
		goal.set("ship M1");
		const hooks = new HookRegistry(() => {});
		hooks.on("before_run_end", goalDriver({ goal, evaluate: async () => false }), { id: "eta.goal" });
		hooks.on("before_run_end", emptyResponseGuard(2), { id: "eta.empty" });
		const out = await runEnd(hooks, [user, empty]);
		expect(out?.followUp).toContain(RESUME_EMPTY);
		expect(out?.followUp).toContain(GOAL_CONTINUATION);
	});

	it("leaves the next boundary to the loops that are due then", async () => {
		const hooks = new HookRegistry(() => {});
		hooks.on("before_run_end", loopDriver(dueLoop()), { id: "eta.loop" });
		expect((await runEnd(hooks, [user, worked]))?.followUp).toContain("[loop l1]");
		// The same loop is not due again on the next boundary: it just fired.
		const second = new HookRegistry(() => {});
		second.on("before_run_end", loopDriver(dueLoop()), { id: "eta.loop" });
		await runEnd(second, [user, worked]);
		expect(await runEnd(second, [user, worked])).toBeUndefined();
	});
});
