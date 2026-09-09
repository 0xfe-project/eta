import { describe, expect, it } from "vitest";
import { renderCurrentTasks } from "../../src/harness/tasks.ts";
import type { Task } from "../../src/harness/session/types.ts";

describe("task prompt vocabulary", () => {
	it("renders statuses", () => {
		const tasks: Task[] = [{ id: "t1", content: "wire storage", status: "in_progress" }];
		expect(renderCurrentTasks(tasks)).toContain("[~] t1: wire storage");
	});
});
