import { describe, expect, it, vi } from "vitest";
import type { AgentMessage } from "../../src/types.ts";
import { GoalManager } from "../../src/eta/goal.ts";
import { emptyResponseGuard, goalDriver, isEmptyStop } from "../../src/eta/run-end.ts";
import { GOAL_CONTINUATION, RESUME_EMPTY } from "../../src/prompts/index.ts";

const user = { role: "user", content: "do it", timestamp: 0 } as unknown as AgentMessage;
const empty = { role: "assistant", stopReason: "stop", content: [] } as unknown as AgentMessage;
const said = { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done!" }] } as unknown as AgentMessage;
const worked = { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: "1", name: "read", arguments: {} }] } as unknown as AgentMessage;

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
		expect(isEmptyStop({ role: "assistant", stopReason: "error", content: [] } as unknown as AgentMessage)).toBe(false);
		expect(isEmptyStop({ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "  " }] } as unknown as AgentMessage)).toBe(true);
	});
});
