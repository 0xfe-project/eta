import { describe, expect, it } from "vitest";
import { TASKS_KEY, loopStateKey, parseLoopState, parseTaskList, renderCurrentTasks, serializeLoopState, serializeTaskList } from "../../src/harness/tasks.ts";
import { answerEntry, askEntry, btwEntry, goalEntry, isEtaCustomType } from "../../src/harness/entries.ts";

describe("tasks kv values", () => {
	it("round-trips and renders current_tasks", () => {
		const tasks = [{ id: "t1", content: "wire storage", status: "in_progress" as const }];
		const list = parseTaskList(serializeTaskList(tasks));
		expect(list.tasks).toEqual(tasks);
		expect(renderCurrentTasks(list)).toContain("[~] t1: wire storage");
		expect(TASKS_KEY).toBe("eta.tasks");
	});
	it("rejects malformed payloads", () => {
		expect(() => parseTaskList(JSON.stringify({ tasks: [{ id: "x" }] }))).toThrow();
		expect(() => parseLoopState("{}")).toThrow();
		expect(parseLoopState(serializeLoopState({ defId: "l1", runCount: 2, paused: false }))).toEqual({ defId: "l1", runCount: 2, paused: false });
		expect(loopStateKey("l1")).toBe("eta.loop.state.l1");
	});
});

describe("custom entry contracts", () => {
	it("factories tag customType and payloads; guard recognizes eta types", () => {
		expect(goalEntry({ kind: "set", objective: "x" }).customType).toBe("eta.goal");
		expect(askEntry({ questionId: "q1", question: "?" }).customType).toBe("eta.ask");
		expect(answerEntry({ questionId: "q1", answers: ["a"] }).customType).toBe("eta.answer");
		expect(btwEntry({ note: "n" }).customType).toBe("eta.btw");
		expect(isEtaCustomType("eta.goal")).toBe(true);
		expect(isEtaCustomType("other")).toBe(false);
	});
});
