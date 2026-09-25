import { Context } from "cordis";
import { describe, expect, it } from "vitest";
import { PersonaService, renderPersonaBlock } from "../src/kernel/persona.ts";
import { kernelOn } from "../src/types/events.ts";
import type { PersonaCard } from "../src/types/persona.ts";

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
