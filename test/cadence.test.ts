/**
 * Reminder cadence (REFACTOR.md §2.3.3, ported from eta-agent's
 * harness/cadence.ts).
 *
 * The kernel owns the signal — when a reminder is due — and the prompts
 * plugin owns the text. Transient by design: nothing lands in the transcript.
 */
import { describe, expect, it } from "vitest";
import {
	type CadenceConfig,
	type CadenceState,
	createCadenceState,
	DEFAULT_REMINDER_INTERVAL,
	DEFAULT_TASK_TOOL_NAMES,
	drainReminderForContext,
	evaluateToolResult,
	onTurnStart,
	resetCadenceState,
} from "../src/index";
import { assistantMessage } from "@eta/core/testing";

const config: CadenceConfig = { reminderInterval: 5, taskToolNames: DEFAULT_TASK_TOOL_NAMES };

function turns(state: CadenceState, n: number): void {
	for (let index = 0; index < n; index += 1) onTurnStart(state);
}

describe("cadence state machine", () => {
	it("becomes due only after the interval and only when there are tasks", () => {
		const state = createCadenceState();
		turns(state, 3);
		expect(evaluateToolResult(state, "read", true, config).markDue).toBe(false);
		turns(state, 2);
		expect(evaluateToolResult(state, "read", true, config).markDue).toBe(true);
		expect(state.reminderDue).toBe(true);
	});

	it("never becomes due without tasks", () => {
		const state = createCadenceState();
		turns(state, 20);
		expect(evaluateToolResult(state, "read", false, config).markDue).toBe(false);
		expect(state.reminderDue).toBe(false);
	});

	it("a task-tool call resets the cadence", () => {
		const state = createCadenceState();
		turns(state, 4);
		evaluateToolResult(state, "TaskUpdate", true, config);
		turns(state, 4);
		expect(evaluateToolResult(state, "read", true, config).markDue).toBe(false);
		turns(state, 1);
		expect(evaluateToolResult(state, "read", true, config).markDue).toBe(true);
	});

	it("reminds once per cycle, and only a task-tool call starts a new one", () => {
		const state = createCadenceState();
		turns(state, DEFAULT_REMINDER_INTERVAL);
		expect(evaluateToolResult(state, "read", true, config).markDue).toBe(true);
		// Draining injects it once; a second drain in the same cycle is empty.
		expect(drainReminderForContext(state)).toBe(true);
		expect(drainReminderForContext(state)).toBe(false);
		// Injected once, it stays quiet even as intervals pass (pi-tasks semantics).
		turns(state, 20);
		expect(evaluateToolResult(state, "read", true, config).markDue).toBe(false);
		// Touching a task resets the cadence, and then it can fire again.
		evaluateToolResult(state, "TaskUpdate", true, config);
		turns(state, DEFAULT_REMINDER_INTERVAL);
		expect(evaluateToolResult(state, "read", true, config).markDue).toBe(true);
	});

	it("reset starts the cadence over", () => {
		const state = createCadenceState();
		turns(state, 10);
		evaluateToolResult(state, "read", true, config);
		resetCadenceState(state);
		expect(state).toEqual(createCadenceState());
	});
});

/* ------------------------------------------------------------------ */
/* The service: the cadence as a subscriber                            */
/* ------------------------------------------------------------------ */

const _userMsg = (text: string) => ({
	role: "user" as const,
	content: [{ type: "text" as const, text }],
	timestamp: 0,
});

const _toolTurn = (calls: { id: string; name: string }[]) =>
	assistantMessage({
		stopReason: "toolUse",
		content: calls.map((call) => ({ type: "toolCall" as const, ...call, arguments: {} })),
	});
