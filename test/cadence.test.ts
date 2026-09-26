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
	Kernel,
	kernelEmit,
	kernelOn,
	onTurnStart,
	Runner,
	resetCadenceState,
} from "../src/index";
import { assistantMessage, fakeModels } from "../src/testing/fake-provider";

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

const userMsg = (text: string) => ({
	role: "user" as const,
	content: [{ type: "text" as const, text }],
	timestamp: 0,
});

const toolTurn = (calls: { id: string; name: string }[]) =>
	assistantMessage({
		stopReason: "toolUse",
		content: calls.map((call) => ({ type: "toolCall" as const, ...call, arguments: {} })),
	});

describe("TaskReminderService", () => {
	function session() {
		const kernel = Kernel.create({ config: { model: { provider: "p", modelId: "m" } } });
		const due: number[] = [];
		const off = kernelOn(kernel.ctx)("task:reminder-due", (event) => {
			due.push(event.turn);
		});
		// The task tools a deployment registers; the cadence resets on their use.
		kernel.tools.register({ name: "TaskUpdate", execute: () => "ok" });
		kernel.tools.register({ name: "read", execute: () => "ok" });
		return {
			kernel,
			due,
			emit: kernelEmit(kernel.ctx),
			dispose: () => {
				off();
				void kernel.dispose();
			},
		};
	}

	it("counts turns from the bus and reports a due reminder once", () => {
		const s = session();
		s.kernel.tasks.create("review me");
		// Five tool-free turns: the cadence counts turns, not tools.
		for (let turn = 1; turn <= DEFAULT_REMINDER_INTERVAL; turn += 1) {
			s.emit("turn:start", { runId: "r", turnId: `t${turn}`, contextParts: EMPTY_PARTS });
		}
		s.emit("tool:end", {
			runId: "r",
			turnId: "t5",
			toolCallId: "c",
			toolName: "read",
			result: "x",
			isError: false,
			terminate: false,
			durationMs: 1,
		});
		expect(s.due).toEqual([DEFAULT_REMINDER_INTERVAL]);
		// It is due once per cycle: draining takes it, then the cadence is quiet.
		expect(s.kernel.taskReminder.drain()).toBe(true);
		expect(s.kernel.taskReminder.drain()).toBe(false);
		s.dispose();
	});

	it("a task-tool call resets the cadence", () => {
		const s = session();
		s.kernel.tasks.create("review me");
		for (let turn = 1; turn <= 3; turn += 1) {
			s.emit("turn:start", { runId: "r", turnId: `t${turn}`, contextParts: EMPTY_PARTS });
		}
		// Touching a task tool resets it, so the next due turn is five later.
		s.emit("tool:end", {
			runId: "r",
			turnId: "t3",
			toolCallId: "c",
			toolName: "TaskUpdate",
			result: "x",
			isError: false,
			terminate: false,
			durationMs: 1,
		});
		for (let turn = 4; turn <= 7; turn += 1) {
			s.emit("turn:start", { runId: "r", turnId: `t${turn}`, contextParts: EMPTY_PARTS });
		}
		s.emit("tool:end", {
			runId: "r",
			turnId: "t7",
			toolCallId: "c2",
			toolName: "read",
			result: "x",
			isError: false,
			terminate: false,
			durationMs: 1,
		});
		expect(s.due).toEqual([]);
		s.emit("turn:start", { runId: "r", turnId: "t8", contextParts: EMPTY_PARTS });
		s.emit("tool:end", {
			runId: "r",
			turnId: "t8",
			toolCallId: "c3",
			toolName: "read",
			result: "x",
			isError: false,
			terminate: false,
			durationMs: 1,
		});
		expect(s.due).toEqual([8]);
		s.dispose();
	});

	it("never reminds when there are no tasks", () => {
		const s = session();
		for (let turn = 1; turn <= 20; turn += 1) {
			s.emit("turn:start", { runId: "r", turnId: `t${turn}`, contextParts: EMPTY_PARTS });
		}
		s.emit("tool:end", {
			runId: "r",
			turnId: "t20",
			toolCallId: "c",
			toolName: "read",
			result: "x",
			isError: false,
			terminate: false,
			durationMs: 1,
		});
		expect(s.due).toEqual([]);
		expect(s.kernel.taskReminder.drain()).toBe(false);
		s.dispose();
	});

	it("fires during a real run once the interval has passed", async () => {
		const kernel = Kernel.create({ config: { model: { provider: "p", modelId: "m" }, activeToolNames: ["read"] } });
		kernel.tools.register({ name: "read", execute: () => "ok" });
		kernel.tasks.create("keep me in mind");
		const due: number[] = [];
		const off = kernelOn(kernel.ctx)("task:reminder-due", (event) => {
			due.push(event.turn);
		});
		// Six turns of tool work, then an answer: the interval passes along the way.
		const script = [
			...Array.from({ length: 6 }, () => toolTurn([{ id: crypto.randomUUID(), name: "read" }])),
			assistantMessage({ content: [{ type: "text", text: "done" }] }),
		];
		const fake = fakeModels(script);
		const runner = new Runner(kernel, { models: fake });
		kernel.inject(userMsg("go"));
		await runner.run();
		off();
		expect(kernel.turns).toBeGreaterThanOrEqual(DEFAULT_REMINDER_INTERVAL);
		expect(due.length).toBeGreaterThan(0);
		void kernel.dispose();
	});
});

const EMPTY_PARTS = { system: 0, persona: 0, user: 0, assistant: 0, toolDefs: 0, total: 0 };
