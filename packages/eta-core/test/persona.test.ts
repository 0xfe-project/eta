import { Context } from "cordis";
import { describe, expect, it } from "vitest";
import { Kernel, Runner } from "../src/index";
import { PersonaService, renderPersonaBlock } from "../src/kernel/persona";
import { assistantMessage, fakeModels } from "../src/testing/fake-provider";
import { kernelOn } from "../src/types/events";
import type { PersonaCard } from "../src/types/persona";

function card(id: string, content = `${id} body`): PersonaCard {
	return { id, name: id, content };
}

function withPersona() {
	const ctx = new Context();
	const persona = new PersonaService(ctx);
	const events: { name: string; payload: unknown }[] = [];
	const on = kernelOn(ctx);
	const offs = [
		on("persona:loaded", (p) => events.push({ name: "persona:loaded", payload: p })),
		on("persona:switched", (p) => events.push({ name: "persona:switched", payload: p })),
		on("persona:missing", (p) => events.push({ name: "persona:missing", payload: p })),
	];
	return {
		ctx,
		persona,
		events,
		dispose: () => {
			for (const off of offs) off();
			void ctx.fiber.dispose();
		},
	};
}

describe("persona service", () => {
	it("loads cards and reports each load on the bus", () => {
		const { persona, events, dispose } = withPersona();
		persona.loadCards([card("Thinker"), card("Executor")]);
		expect(persona.list().map((c) => c.id)).toEqual(["Thinker", "Executor"]);
		expect(events.filter((e) => e.name === "persona:loaded")).toHaveLength(2);
		dispose();
	});

	it("switch activates in order and renders the joined block", () => {
		const { persona, dispose } = withPersona();
		persona.loadCards([card("a", "alpha"), card("b", "beta")]);
		const { active, missing } = persona.setActive(["b", "a"]);
		expect(active.map((c) => c.id)).toEqual(["b", "a"]);
		expect(missing).toEqual([]);
		expect(persona.renderActive().text).toBe("beta\n\nalpha");
		dispose();
	});

	it("missing persona degrades: reported, warned, session intact", () => {
		const { persona, events, dispose } = withPersona();
		persona.loadCards([card("a", "alpha")]);
		const { active, missing } = persona.setActive(["a", "Ghost"]);
		// The session survives: found card stays active, ghost is reported.
		expect(active.map((c) => c.id)).toEqual(["a"]);
		expect(missing).toEqual(["Ghost"]);
		expect(persona.renderActive().text).toBe("alpha");
		expect(events.filter((e) => e.name === "persona:missing")).toEqual([
			{ name: "persona:missing", payload: { id: "Ghost" } },
		]);
		// And the switch event carries both halves for the UI.
		const switched = events.find((e) => e.name === "persona:switched");
		expect(switched?.payload).toMatchObject({ missing: ["Ghost"] });
		dispose();
	});

	it("a reload that fixes a missing card re-resolves the active set", () => {
		const { persona, events, dispose } = withPersona();
		persona.loadCards([card("a")]);
		persona.setActive(["Ghost"]);
		persona.loadCards([card("a"), card("Ghost", "now real")]);
		expect(persona.renderActive().text).toBe("now real");
		expect(persona.activeNamesList()).toEqual(["Ghost"]);
		// No stale missing warning from the reload path.
		expect(events.filter((e) => e.name === "persona:missing")).toHaveLength(1);
		dispose();
	});

	it("renderPersonaBlock is pure and reports misses in order", () => {
		const cards = new Map([
			["x", card("x", "ex")],
			["y", card("y", "why")],
		]);
		expect(renderPersonaBlock(["y", "x", "z"], cards)).toEqual({ text: "why\n\nex", missing: ["z"] });
		expect(renderPersonaBlock([], cards)).toEqual({ text: "", missing: [] });
	});
});

// Every point below is a line of eta-agent's persona.ts, checked one by one.
describe("persona fidelity against eta-agent's persona.ts", () => {
	it("trims each card and joins the block with a blank line", () => {
		const cards = new Map([
			["a", card("a", "  first card  ")],
			["b", card("b", "\nsecond card\n")],
		]);
		expect(renderPersonaBlock(["a", "b"], cards)).toEqual({ text: "first card\n\nsecond card", missing: [] });
	});

	it("reports misses in the requested order and renders nothing for them", () => {
		const cards = new Map([["a", card("a", "A")]]);
		expect(renderPersonaBlock(["x", "a", "y"], cards)).toEqual({ text: "A", missing: ["x", "y"] });
	});

	it("an empty name list renders nothing and reports nothing", () => {
		expect(renderPersonaBlock([], new Map())).toEqual({ text: "", missing: [] });
	});

	it("the active persona reaches the provider's system prompt", async () => {
		const kernel = Kernel.create({ config: { model: { provider: "p", modelId: "m" } } });
		const fake = fakeModels([assistantMessage()]);
		kernel.persona.loadCards([card("Executor", "You are the executor."), card("Other", "You are someone else.")]);
		kernel.persona.setActive(["Executor"]);
		const runner = new Runner(kernel, { models: fake, systemPrompt: "base prompt" });
		kernel.inject({ role: "user", content: [{ type: "text", text: "go" }], timestamp: 0 });
		await runner.run();

		const systemPrompt = fake.calls[0]!.context.systemPrompt ?? "";
		expect(systemPrompt).toContain("base prompt");
		expect(systemPrompt).toContain("You are the executor.");
		expect(systemPrompt).not.toContain("You are someone else.");
		// The block is appended after the base prompt, separated by a blank line.
		expect(systemPrompt).toBe("base prompt\n\nYou are the executor.");
		void kernel.dispose();
	});

	it("a missing active persona still leaves the rest of the prompt intact", async () => {
		const kernel = Kernel.create({ config: { model: { provider: "p", modelId: "m" } } });
		const fake = fakeModels([assistantMessage()]);
		kernel.persona.loadCards([card("Executor", "still here")]);
		kernel.persona.setActive(["Ghost", "Executor"]);
		const runner = new Runner(kernel, { models: fake, systemPrompt: "base" });
		kernel.inject({ role: "user", content: [{ type: "text", text: "go" }], timestamp: 0 });
		await runner.run();
		expect(fake.calls[0]!.context.systemPrompt).toBe("base\n\nstill here");
		void kernel.dispose();
	});
});
