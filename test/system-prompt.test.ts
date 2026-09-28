/**
 * System prompt assembly (ported from eta-agent's `composer.ts` behavior and
 * `system-prompt.test.ts`).
 *
 * Two things are being pinned. The order is a cache decision — the stable blocks
 * come first so a provider keeps them — and the blocks themselves are rendered,
 * not concatenated by accident: a persona in the middle, or memory before the
 * task list, would cost real tokens every turn.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_SYSTEM_PROMPT, GOAL_CONTINUATION, goalPursuitGuidelines } from "../src/prompts";
import {
	composeEtaSystemPrompt,
	etaPromptBlockChars,
	etaPromptSectionsDetailed,
	splitEtaPromptSections,
} from "../src/prompts/composer";
import { builtinPersonas } from "../src/prompts/persona";
import { formatSkillsForSystemPrompt } from "../src/prompts/skills-block";

const tasks = [
	{ id: "t1", content: "write the composer", status: "completed" as const },
	{ id: "t2", content: "port the tests", status: "in_progress" as const },
];

describe("the composer", () => {
	it("lays the blocks out stable-first, in one fixed order", () => {
		const prompt = composeEtaSystemPrompt("BASE", {
			persona: "PERSONA",
			skills: "SKILLS",
			platform: "PLATFORM",
			goal: { objective: "ship it", status: "active" },
			tasks,
			memory: "MEMORY",
		});
		const order = ["BASE", "PERSONA", "SKILLS", "PLATFORM", "Goal: ship it", "Before anything else", "MEMORY"];
		let cursor = -1;
		for (const marker of order) {
			const at = prompt.indexOf(marker);
			expect(at, `${marker} appears after the previous block`).toBeGreaterThan(cursor);
			cursor = at;
		}
	});

	it("splits what a cache keeps from what is rewritten every generation", () => {
		const state = {
			persona: "PERSONA",
			skills: "SKILLS",
			goal: { objective: "x", status: "active" },
			memory: "MEMORY",
		};
		const { stable, adaptive } = splitEtaPromptSections("BASE", state);
		expect(stable.join("")).toContain("PERSONA");
		expect(stable.join("")).toContain("SKILLS");
		expect(stable.join("")).not.toContain("MEMORY");
		expect(adaptive.join("")).toContain("Goal: x");
		expect(adaptive.join("")).toContain("MEMORY");
		// And the numbers a panel shows agree with the split.
		const chars = etaPromptBlockChars("BASE", state);
		expect(chars.stableChars).toBe(stable.reduce((sum, part) => sum + part.length, 0));
		expect(chars.adaptiveChars).toBe(adaptive.reduce((sum, part) => sum + part.length, 0));
	});

	it("names each section, so a UI can show the prompt as blocks", () => {
		const sections = etaPromptSectionsDetailed("BASE", { persona: "P", memory: "M" });
		expect(sections.map((section) => section.name)).toEqual(["base", "persona", "memory"]);
		expect(sections.map((section) => section.stable)).toEqual([true, true, false]);
	});

	it("leaves out what is empty, and a finished goal is not pursued", () => {
		expect(composeEtaSystemPrompt("BASE", {})).toBe("BASE");
		const done = composeEtaSystemPrompt("BASE", { goal: { objective: "x", status: "completed" } });
		expect(done).toBe("BASE");
		expect(composeEtaSystemPrompt("BASE", { tasks: [] })).toBe("BASE");
	});

	it("states the goal's rules in the same words every turn", () => {
		// The text is a contract: it is what the model is told about persistence,
		// and it is what a provider caches alongside the persona.
		expect(goalPursuitGuidelines("port the harness")).toContain("Goal: port the harness");
		expect(goalPursuitGuidelines("port the harness")).toContain("Only mark done when the end state is verified.");
		expect(GOAL_CONTINUATION).toBe("[goal] keep going: make concrete progress on the active goal, or finish it.");
	});

	it("ships the base prompt and the builtin personas", () => {
		expect(DEFAULT_SYSTEM_PROMPT).toContain("You are Eta");
		expect(DEFAULT_SYSTEM_PROMPT).toContain("<current_tasks>");
		expect(Object.keys(builtinPersonas()).sort()).toEqual(["Artist", "Executor", "Insighter", "Thinker"]);
	});
});

describe("the skills catalog block", () => {
	const visible = {
		name: "visible",
		description: "Use <this> & that",
		content: "c",
		filePath: "/skills/visible/SKILL.md",
	};
	const second = { name: "second", description: "Second skill", content: "c", filePath: "/skills/second/SKILL.md" };
	const hidden = { ...visible, name: "hidden", filePath: "/skills/hidden/SKILL.md", disableModelInvocation: true };

	it("lists the visible skills in order and skips the model-disabled ones", () => {
		expect(formatSkillsForSystemPrompt([visible, hidden, second])).toBe(
			`The following skills provide specialized instructions for specific tasks.
Read the full skill file when the task matches its description.
When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.

<available_skills>
  <skill>
    <name>visible</name>
    <description>Use &lt;this&gt; &amp; that</description>
    <location>/skills/visible/SKILL.md</location>
  </skill>
  <skill>
    <name>second</name>
    <description>Second skill</description>
    <location>/skills/second/SKILL.md</location>
  </skill>
</available_skills>`,
		);
	});

	it("is empty when nothing is model-visible", () => {
		expect(formatSkillsForSystemPrompt([hidden])).toBe("");
		expect(formatSkillsForSystemPrompt([])).toBe("");
	});

	it("escapes XML in every field a model reads", () => {
		expect(
			formatSkillsForSystemPrompt([
				{ name: "a&b", description: `Quote "double" and 'single'`, filePath: '/skills/<bad>&"quote"/SKILL.md' },
			]),
		).toContain(
			"<name>a&amp;b</name>\n    <description>Quote &quot;double&quot; and &apos;single&apos;</description>\n    <location>/skills/&lt;bad&gt;&amp;&quot;quote&quot;/SKILL.md</location>",
		);
	});
});
