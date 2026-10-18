/**
 * The provider vocabulary (`providers/config-types.ts`).
 *
 * These are the rules a hand-edited config file is read through, and the ones a settings form is
 * written through. None of them need a file: they are about what a kind means, what a model
 * declares, and which headers survive.
 */
import { describe, expect, it } from "vitest";
import {
	applyProviderHeaders,
	configDefaultModel,
	effectiveModel,
	isCustomKind,
	modelDefaultThinking,
	modelSupportsVision,
	modelThinkingLevels,
	providerPreset,
	providerSummary,
	sanitizeProviderHeaders,
} from "../src/providers/config-types";

describe("kinds", () => {
	it("knows which kinds bring their own endpoint", () => {
		expect(providerPreset("deepseek")?.baseUrl).toContain("deepseek.com");
		expect(providerPreset("openai-compatible")).toBeUndefined();
		expect(isCustomKind(undefined)).toBe(true);
		expect(isCustomKind("openai-compatible")).toBe(true);
		expect(isCustomKind("openai-responses")).toBe(true);
		expect(isCustomKind("deepseek")).toBe(false);
	});
});

describe("what a model declares", () => {
	it("keeps `unknown` and `none` apart", () => {
		// A model that says it does not reason has one setting left: off.
		expect(modelThinkingLevels({ id: "m", reasoning: false })).toEqual(["off"]);
		expect(modelThinkingLevels({ id: "m", thinkingMode: "no" })).toEqual(["off"]);
		// A model that says nothing is *unknown*: inventing an off switch for a provider that
		// always thinks is worse than offering nothing.
		expect(modelThinkingLevels({ id: "m" })).toEqual([]);
		expect(modelThinkingLevels({ id: "m", reasoning: true })).toEqual([]);
	});

	it("offers the declared efforts, and an off switch only when the model has one", () => {
		expect(
			modelThinkingLevels({ id: "m", reasoning: true, reasoningEfforts: ["low", "high"], thinkingMode: "only" }),
		).toEqual(["low", "high"]);
		expect(
			modelThinkingLevels({ id: "m", reasoning: true, reasoningEfforts: ["low", "high"], thinkingMode: "both" }),
		).toEqual(["off", "low", "high"]);
	});

	it("picks a default thinking level that the model actually has", () => {
		const model = {
			id: "m",
			reasoning: true,
			reasoningEfforts: ["low", "high"] as ("low" | "high")[],
			thinkingMode: "both" as const,
		};
		// A preference that is not offered is ignored rather than sent.
		expect(modelDefaultThinking({ ...model, defaultThinking: "max" })).toBe("off");
		expect(modelDefaultThinking({ ...model, defaultThinking: "high" })).toBe("high");
		expect(modelDefaultThinking({ ...model, providerDefaultEffort: "low" })).toBe("low");
		// And a model with no off switch cannot be asked for one.
		expect(modelDefaultThinking({ id: "m", reasoning: true, reasoningEfforts: ["low"], thinkingMode: "only" })).toBe(
			"off",
		);
	});

	it("lets overrides correct what a catalog said, without replacing the model", () => {
		const model = { id: "m", contextWindow: 100, overrides: { contextWindow: 200, name: "corrected" } };
		expect(effectiveModel(model)).toMatchObject({ id: "m", contextWindow: 200, name: "corrected" });
		expect(modelSupportsVision({ input: ["text", "image"] })).toBe(true);
		expect(modelSupportsVision({ input: ["text"] })).toBe(false);
		expect(modelSupportsVision({})).toBeUndefined();
	});
});

describe("headers", () => {
	it("drops names a request could not carry, and collapses duplicates", () => {
		const headers = sanitizeProviderHeaders({
			"User-Agent": "eta/1",
			"user-agent": "eta/2",
			"bad name": "x",
			"X-Keep": "  spaced  ",
		});
		expect(headers).toEqual({ "user-agent": "eta/2", "X-Keep": "spaced" });
	});

	it("treats an empty value as an explicit removal", () => {
		expect(sanitizeProviderHeaders({ "X-Drop": "", "X-Null": null })).toEqual({ "X-Drop": null, "X-Null": null });
	});

	it("applies overrides case-insensitively, and a null removes what the transport would add", () => {
		const merged = applyProviderHeaders(
			{ "User-Agent": "default/1", Authorization: "Bearer x" },
			{ "user-agent": "eta/1", Authorization: null },
		);
		// One User-Agent, the provider's.
		expect(merged["user-agent"]).toBe("eta/1");
		expect(Object.keys(merged).filter((name) => name.toLowerCase() === "user-agent")).toHaveLength(1);
		// And the suppressed one is gone rather than emptied.
		expect(merged.Authorization).toBeUndefined();
	});
});

describe("the config as a client sees it", () => {
	it("turns a key into a boolean and never carries the secret", () => {
		const summary = providerSummary({
			id: "a",
			baseUrl: "https://a.example/v1",
			apiKey: "sk-secret",
			models: [{ id: "m", defaultThinking: "high" }],
		});
		expect(summary.hasApiKey).toBe(true);
		expect(JSON.stringify(summary)).not.toContain("sk-secret");
		expect(summary.kind).toBe("openai-compatible");
	});

	it("resolves the default model, falling back to the first configured one", () => {
		const config = { providers: [{ id: "a", baseUrl: "x", models: [{ id: "m1" }, { id: "m2" }] }] };
		expect(configDefaultModel(config)).toEqual({ provider: "a", modelId: "m1" });
		expect(configDefaultModel({ ...config, defaultModel: "a:m2" })).toEqual({ provider: "a", modelId: "m2" });
		// A default that no longer resolves is returned as written: the config file said it, and
		// the honest failure (`model_unavailable`) belongs at the request that asks for it, not
		// here where the answer would be a silent substitution for the model the user chose.
		expect(configDefaultModel({ ...config, defaultModel: "gone:away" })).toEqual({
			provider: "gone",
			modelId: "away",
		});
		expect(configDefaultModel({})).toBeUndefined();
	});
});
