import { describe, expect, it } from "bun:test";
import { renderPlatformBlock } from "../src/platform-prompt.ts";

const base = {
	cwd: "/work/0xts",
	home: "/home/lemon",
	configPath: "/home/lemon/.eta/config.json",
	memoryTarget: "/work/0xts/.eta/MEMORY.md",
};

describe("the platform briefing", () => {
	it("tells the agent where the app keeps its own files", () => {
		const text = renderPlatformBlock({ ...base, sessionDir: "/home/lemon/.eta/sessions/eta-1", memoryExists: false });
		expect(text.startsWith("<platform>")).toBe(true);
		expect(text.endsWith("</platform>")).toBe(true);
		expect(text).toContain("/home/lemon/.eta/config.json");
		// Headers and keys are the parts the agent is likely to need, and the ones it must not leak.
		expect(text).toContain("`headers`");
		expect(text).toContain("secrets");
		expect(text).toContain("/home/lemon/.eta/sessions/eta-1");
		// The journal is described as the app's own format, so a clever agent does not edit it.
		expect(text).toContain("journal.jsonl");
		expect(text).toContain("hand-editing it is not a supported operation");
	});

	it("says how a persona card is written and that it needs no restart", () => {
		const text = renderPlatformBlock({ ...base, memoryExists: true });
		expect(text).toContain("<id>.persona.md");
		expect(text).toContain("/home/lemon/.eta/persona");
		expect(text).toContain("/work/0xts/.eta/persona");
		expect(text).toContain("without a restart");
	});

	// The memory line is the one that changes with the session, because the action differs.
	it("points at the memory file when the project already has one", () => {
		const text = renderPlatformBlock({ ...base, memoryExists: true });
		expect(text).toContain("/work/0xts/.eta/MEMORY.md");
		expect(text).toContain("loaded above as the memory block");
		expect(text).not.toContain("nothing has been remembered");
	});

	it("tells the agent to create .eta/MEMORY.md when the project has none", () => {
		const text = renderPlatformBlock({ ...base, memoryExists: false });
		expect(text).toContain("nothing has been remembered");
		expect(text).toContain("create /work/0xts/.eta/");
		expect(text).toContain("MEMORY.md");
		// The rule, not just the instruction: the nearest one up the tree is what gets loaded.
		expect(text).toContain("nearest .eta/MEMORY.md up the tree");
	});

	it("leaves the session directory out when nothing is persisted", () => {
		const text = renderPlatformBlock({ ...base, memoryExists: true });
		expect(text).not.toContain("journal.jsonl");
	});
});
