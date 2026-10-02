/**
 * The prompt a session actually sends (H11a).
 *
 * Before this, every block existed and nothing assembled them: an `openSession`
 * session ran with no system prompt at all. What is pinned here is the assembly —
 * which blocks appear, in which order, that the stable prefix does not move between
 * generations while the adaptive tail does, and that a host's own prompt still wins.
 */
import { MemoryStorage } from "@eta/core/storage";
import { assistantMessage, fakeModels } from "@eta/core/testing";
import { describe, expect, it } from "vitest";
import { openSession } from "../src/open";
import { DEFAULT_SYSTEM_PROMPT } from "../src/prompts";

const userMsg = (text: string) => ({
	role: "user" as const,
	content: [{ type: "text" as const, text }],
	timestamp: 0,
});

/** The system prompt of the last request the model saw. */
const promptOf = (models: ReturnType<typeof fakeModels>): string => models.calls.at(-1)?.context.systemPrompt ?? "";

async function sessionWith(
	options: Parameters<typeof openSession>[0] = { storage: new MemoryStorage(), models: fakeModels([]) as never },
) {
	const session = await openSession(options);
	return session;
}

describe("the default system prompt", () => {
	it("is the harness's base prompt, even with nothing else configured", async () => {
		const models = fakeModels([assistantMessage({ content: [{ type: "text", text: "ok" }] })]);
		const session = await sessionWith({ storage: new MemoryStorage(), models: models as never });
		session.kernel.inject(userMsg("hello"));
		await session.runner.run();

		expect(promptOf(models)).toBe(DEFAULT_SYSTEM_PROMPT);
		await session.kernel.dispose();
		session.stop();
	});

	it("assembles base → persona → skills → platform, then goal → tasks → memory", async () => {
		const models = fakeModels([assistantMessage({ content: [{ type: "text", text: "ok" }] })]);
		const session = await sessionWith({
			storage: new MemoryStorage(),
			models: models as never,
			platform: {
				home: "/home/u",
				cwd: "/work/eta",
				configPath: "/home/u/.eta/config.json",
				memoryTarget: "/work/eta/.eta/MEMORY.md",
				memoryExists: true,
			},
			skillsSection: "<skills>catalog-marker</skills>",
			memorySource: () => "<memory>KUMQUAT-9 was decided</memory>",
		});
		session.kernel.persona.loadCards([{ id: "Executor", name: "Executor", content: "Ship it." }]);
		session.kernel.persona.setActive(["Executor"]);
		session.kernel.goal.set("land the port");
		session.kernel.tasks.create("keep the harness green");
		session.kernel.inject(userMsg("hello"));
		await session.runner.run();

		const prompt = promptOf(models);
		// Specific to each *block*: the base prompt itself mentions
		// `<current_tasks>` (it tells the agent to read that list), so the task block
		// is identified by the task, not by the tag.
		const order = [
			"You are Eta",
			"Ship it.",
			"catalog-marker",
			"Config: /home/u/.eta/config.json",
			"land the port",
			"keep the harness green",
			"KUMQUAT-9",
		].map((needle) => {
			const at = prompt.indexOf(needle);
			expect(at, `missing from the prompt: ${needle}`).toBeGreaterThanOrEqual(0);
			return at;
		});
		expect(order).toEqual([...order].sort((a, b) => a - b));

		// The sections the prompt panel reads say the same thing.
		const sections = await session.promptSections();
		expect(sections.sections.map((section) => section.name)).toEqual([
			"base",
			"persona",
			"skills",
			"platform",
			"goal",
			"tasks",
			"memory",
		]);
		expect(sections.stableChars).toBeGreaterThan(0);
		expect(sections.adaptiveChars).toBeGreaterThan(0);

		// Persona is in the prompt once — the runner no longer folds it in as well.
		expect(prompt.split("Ship it.").length - 1).toBe(1);
		await session.kernel.dispose();
		session.stop();
	});

	it("re-reads the adaptive blocks every generation, and leaves the prefix alone", async () => {
		const models = fakeModels([
			assistantMessage({ content: [{ type: "text", text: "first" }] }),
			assistantMessage({ content: [{ type: "text", text: "second" }] }),
		]);
		let memory = "<memory>nothing yet</memory>";
		const session = await sessionWith({
			storage: new MemoryStorage(),
			models: models as never,
			platform: {
				home: "/home/u",
				cwd: "/work",
				configPath: "/cfg",
				memoryTarget: "/work/.eta/MEMORY.md",
				memoryExists: true,
			},
			memorySource: () => memory,
		});
		session.kernel.inject(userMsg("one"));
		await session.runner.run();
		const first = promptOf(models);

		// A note written in between is in the *next* prompt, while the stable part of
		// the prompt is byte-identical — which is what a provider cache keeps.
		memory = "<memory>the index is missing</memory>";
		session.kernel.tasks.create("something new");
		session.kernel.inject(userMsg("two"));
		await session.runner.run();
		const second = promptOf(models);

		expect(second).toContain("the index is missing");
		expect(second).toContain("something new");
		expect(second).not.toContain("nothing yet");
		const stableOf = (prompt: string): string => prompt.slice(0, prompt.indexOf("<platform>"));
		expect(stableOf(second)).toBe(stableOf(first));
		await session.kernel.dispose();
		session.stop();
	});

	it("lets a host's own prompt win over the assembly", async () => {
		const models = fakeModels([assistantMessage({ content: [{ type: "text", text: "ok" }] })]);
		const session = await sessionWith({
			storage: new MemoryStorage(),
			models: models as never,
			runner: { systemPrompt: "just this" },
			memorySource: () => "<memory>ignored</memory>",
		});
		session.kernel.inject(userMsg("hello"));
		await session.runner.run();
		expect(promptOf(models)).toBe("just this");
		await session.kernel.dispose();
		session.stop();
	});

	it("survives a session whose blocks are all empty", async () => {
		const models = fakeModels([assistantMessage({ content: [{ type: "text", text: "ok" }] })]);
		const session = await sessionWith({
			storage: new MemoryStorage(),
			models: models as never,
			baseSystemPrompt: "",
			memorySource: () => undefined,
		});
		session.kernel.inject(userMsg("hello"));
		await session.runner.run();
		// Nothing to say is not a broken prompt: no system prompt is sent at all.
		expect(models.calls.at(-1)?.context.systemPrompt ?? "").toBe("");
		await session.kernel.dispose();
		session.stop();
	});
});

describe("what a restarted session composes", () => {
	it("brings back the goal and the ledger into the prompt", async () => {
		const storage = new MemoryStorage();
		const first = await sessionWith({ storage, models: fakeModels([]) as never });
		first.kernel.goal.set("survive a restart");
		first.kernel.tasks.create("remember me");
		await first.journaling.flush();
		await first.kernel.dispose();
		first.stop();

		const models = fakeModels([assistantMessage({ content: [{ type: "text", text: "ok" }] })]);
		const restarted = await sessionWith({ storage, models: models as never });
		restarted.kernel.inject(userMsg("carry on"));
		await restarted.runner.run();
		const prompt = promptOf(models);
		expect(prompt).toContain("survive a restart");
		expect(prompt).toContain("remember me");
		await restarted.kernel.dispose();
		restarted.stop();
	});
});
