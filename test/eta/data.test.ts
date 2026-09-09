import { describe, expect, it } from "vitest";
import { parseTaskList, renderCurrentTasks, serializeTaskList } from "../../src/harness/tasks.ts";
import { answerEntry, askEntry, btwEntry, goalEntry } from "../../src/harness/entries.ts";

describe("tasks kv values", () => {
	it("round-trips and renders current_tasks", () => {
		const tasks = [{ id: "t1", content: "wire storage", status: "in_progress" as const }];
		const list = parseTaskList(serializeTaskList(tasks));
		expect(list.tasks).toEqual(tasks);
		expect(renderCurrentTasks(list)).toContain("[~] t1: wire storage");
	});
	it("rejects malformed payloads", () => {
		expect(() => parseTaskList(JSON.stringify({ tasks: [{ id: "x" }] }))).toThrow();
		expect(() => parseTaskList("{}")).toThrow();
	});
});

describe("first-class entry constructors", () => {
	it("build queued entries with plain entry types", () => {
		expect(goalEntry({ kind: "set", objective: "x" })).toEqual({ type: "goal", payload: { kind: "set", objective: "x" } });
		expect(askEntry({ questionId: "q1", question: "?" })).toEqual({ type: "ask", payload: { questionId: "q1", question: "?" } });
		expect(answerEntry({ questionId: "q1", answers: ["a"] })).toEqual({ type: "answer", payload: { questionId: "q1", answers: ["a"] } });
		expect(btwEntry({ note: "n" })).toEqual({ type: "btw", payload: { note: "n" } });
	});
});
