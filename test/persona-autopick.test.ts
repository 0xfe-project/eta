import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, type Api, type Context, type Model, type MutableModels } from "@earendil-works/pi-ai";
import { choosePersona, fallbackPersonaId, parsePersonaAnswer, suggestPersonaId } from "../src/persona-autopick.ts";

const CARDS: Record<string, string> = {
	Thinker: "# Thinker\nINTP card",
	Executor: "# Executor\nDoer card",
	Insighter: "# Insighter\nObserver card",
};

function fauxPick(
	response: ((context: Context, options: Record<string, unknown> | undefined) => AssistantLike) | AssistantLike,
): { models: MutableModels; model: Model<Api> } {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	faux.setResponses([typeof response === "function" ? (context, options) => response(context, options as Record<string, unknown> | undefined) : response]);
	return { models, model: faux.getModel() as Model<Api> };
}
type AssistantLike = ReturnType<typeof fauxAssistantMessage>;

describe("parsePersonaAnswer", () => {
	it("reads the card the answer names, whatever it is wrapped in", () => {
		const ids = Object.keys(CARDS);
		expect(parsePersonaAnswer("Executor", ids)).toBe("Executor");
		expect(parsePersonaAnswer('`"Executor"`', ids)).toBe("Executor");
		expect(parsePersonaAnswer('{"persona": "Insighter"}', ids)).toBe("Insighter");
		expect(parsePersonaAnswer("I'd open this on Thinker, since the ask is analysis.", ids)).toBe("Thinker");
		// A model hedging between two cards states its pick first.
		expect(parsePersonaAnswer("Executor or Thinker, both fit.", ids)).toBe("Executor");
	});

	it("refuses anything that is not a whole card on the list", () => {
		const ids = Object.keys(CARDS);
		// "thinkerlite" merely contains a card name, and a card that went missing is not a pick.
		expect(parsePersonaAnswer("thinkerlite or Execute it", ids)).toBe(undefined);
		expect(parsePersonaAnswer("Coach", ids)).toBe(undefined);
		expect(parsePersonaAnswer("", ids)).toBe(undefined);
	});
});

describe("choosePersona", () => {
	it("asks the model with the real card list and no effort, and returns the card it names", async () => {
		let asked: { context: Context; options: Record<string, unknown> } | undefined;
		const { models, model } = fauxPick((context, options) => {
			asked = { context, options: options ?? {} };
			return fauxAssistantMessage("Executor");
		});
		const prompt = "帮我把这个模块拆开";
		expect(await choosePersona({ models, model, cards: CARDS, prompt })).toBe("Executor");

		const user = asked?.context.messages[0];
		const text = typeof user?.content === "string" ? user.content : "";
		expect(asked?.context.systemPrompt).toContain("exactly one id");
		// One line per card, described the way the picker describes it: the model chooses on
		// what the person would have read.
		expect(text).toContain("- Thinker: Thinker");
		expect(text).toContain("- Executor: Executor");
		expect(text).toContain(prompt);
		// No effort is the point — pi reads it as "the card's off switch", so a model that can
		// stop thinking answers this without thinking.
		expect(asked?.options.reasoning).toBeUndefined();
		expect(asked?.options.reasoningEffort).toBeUndefined();
	});
});

describe("fallbackPersonaId", () => {
	it("prefers the configured default while it is still a card, and holds Thinker otherwise", () => {
		expect(fallbackPersonaId(CARDS, "Insighter")).toEqual({ id: "Insighter", source: "preferred" });
		expect(fallbackPersonaId(CARDS, "deleted-card")).toEqual({ id: "Thinker", source: "fallback" });
		expect(fallbackPersonaId({})).toEqual({ id: "Thinker", source: "fallback" });
	});
});

describe("suggestPersonaId", () => {
	const dir = mkdtempSync(join(tmpdir(), "eta-autopick-"));

	it("takes the fallback without attempting a call, with nothing to read or no model configured", async () => {
		const configPath = join(dir, "absent.json");
		expect(await suggestPersonaId({ cwd: dir, prompt: "   ", configPath, preferredId: "Executor" })).toEqual({ id: "Executor", source: "preferred" });
		expect(await suggestPersonaId({ cwd: dir, prompt: "重构它", configPath })).toEqual({ id: "Thinker", source: "fallback" });
	});

	it("takes the fallback when the configured endpoint refuses the call", async () => {
		const configPath = join(dir, "dead.json");
		writeFileSync(
			configPath,
			JSON.stringify({
				providers: [{ id: "dead", kind: "openai-compatible", baseUrl: "http://127.0.0.1:9/v1", models: [{ id: "m" }] }],
				defaultModel: "dead:m",
			}),
		);
		const pick = await suggestPersonaId({ cwd: dir, prompt: "重构它", configPath, preferredId: "Executor" });
		expect(pick).toEqual({ id: "Executor", source: "preferred" });
	});
});
