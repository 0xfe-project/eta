import { Context } from "cordis";
import { describe, expect, it } from "vitest";
import { PersonaService } from "../src/kernel/persona";
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

	it("switch activates cards in order", () => {
		const { persona, dispose } = withPersona();
		persona.loadCards([card("a", "alpha"), card("b", "beta")]);
		const { active, missing } = persona.setActive(["b", "a"]);
		expect(active.map((c) => c.id)).toEqual(["b", "a"]);
		expect(missing).toEqual([]);
		expect(persona.active().map((c) => c.content)).toEqual(["beta", "alpha"]);
		dispose();
	});

	it("missing persona degrades: reported, warned, session intact", () => {
		const { persona, events, dispose } = withPersona();
		persona.loadCards([card("a", "alpha")]);
		const { active, missing } = persona.setActive(["a", "Ghost"]);
		// The session survives: found card stays active, ghost is reported.
		expect(active.map((c) => c.id)).toEqual(["a"]);
		expect(missing).toEqual(["Ghost"]);
		expect(persona.active().map((c) => c.content)).toEqual(["alpha"]);
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
		expect(persona.active().map((c) => c.content)).toEqual(["now real"]);
		expect(persona.activeNamesList()).toEqual(["Ghost"]);
		// No stale missing warning from the reload path.
		expect(events.filter((e) => e.name === "persona:missing")).toHaveLength(1);
		dispose();
	});
});
