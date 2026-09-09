import { describe, expect, it } from "vitest";
import { composeEtaSystemPrompt, etaPromptSections } from "../../src/eta/composer.ts";

const tasks = {
	updatedAt: "now",
	tasks: [{ id: "t1", content: "wire composer", status: "in_progress" as const }],
};

describe("eta prompt composer", () => {
	it("empty state is just the base prompt", () => {
		expect(composeEtaSystemPrompt("BASE", {})).toBe("BASE");
	});
	it("active goal appends guidelines; paused goal does not", () => {
		const active = composeEtaSystemPrompt("BASE", { goal: { objective: "ship it", status: "active" } });
		expect(active.startsWith("BASE\n\nGoal: ship it")).toBe(true);
		const paused = etaPromptSections({ goal: { objective: "ship it", status: "paused" } });
		expect(paused).toEqual([]);
	});
	it("tasks append review prompt and rendered list", () => {
		const s = composeEtaSystemPrompt("BASE", { tasks });
		expect(s).toContain("<current_tasks>");
		expect(s).toContain("[~] t1: wire composer");
		expect(s.indexOf("review your current task list")).toBeGreaterThan(s.indexOf("BASE"));
	});
	it("section order is goal then tasks", () => {
		const sections = etaPromptSections({ goal: { objective: "g", status: "active" }, tasks });
		expect(sections.length).toBe(2);
		expect(sections[0].startsWith("Goal: g")).toBe(true);
		expect(sections[1].includes("<current_tasks>")).toBe(true);
	});
});
