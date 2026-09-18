import { describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUILTIN_PROVIDER_PRESETS, modelDefaultThinking, modelThinkingLevels } from "@eta/core/provider-config";
import { configModels } from "../src/config.ts";
import { parseProviderModelCatalog, providerDefinitionForKind, providerModelCatalog, providerModelDefinition, resolveConfiguredModels } from "../src/provider-model-catalog.ts";
import { ProviderConfigStore, ZAI_BASE_URL, ZAI_CODING_CN_BASE_URL, discoverProviderModels, type ProviderFetch } from "../src/providers.ts";

const response = (ids: string[]): ProviderFetch => async () => Response.json({ data: ids.map(id => ({ id, object: "model", owned_by: "zai" })) });

for (const provider of [
	{ id: "zai-coding-cn", kind: "zai-coding-cn" as const, baseUrl: ZAI_CODING_CN_BASE_URL },
	{ id: "zai", kind: "zai" as const, baseUrl: ZAI_BASE_URL },
]) {
	describe(`${provider.kind} provider`, () => {
		it("keeps the curated two-model catalog and its input capabilities", () => {
			const models = providerModelCatalog(provider);
			expect(models.map(model => model.id)).toEqual(["glm-5.3", "glm-5.3-flash"]);
			expect(models.map(model => model.input)).toEqual([["text"], ["text", "image"]]);
			for (const model of models) {
				expect(modelThinkingLevels(model)).toEqual(["off", "low", "high", "max"]);
				expect(modelDefaultThinking(model)).toBe("off");
				expect(model.contextWindow).toBe(1_000_000);
				expect(model.maxTokens).toBe(131_072);
			}
		});

		it("validates the key against /models and ignores unlisted aliases", async () => {
			let url = "";
			let authorization = "";
			const models = await discoverProviderModels({ ...provider, apiKey: "test-key", models: [] }, async (input, init) => {
				url = input;
				authorization = new Headers(init?.headers).get("authorization") ?? "";
				return response(["glm-5.3", "glm-5.3-flash", "glm-5.3-flashx"])(input, init);
			});
			expect(url).toBe(`${provider.baseUrl}/models`);
			expect(authorization).toBe("Bearer test-key");
			expect(models.map(model => model.id)).toEqual(["glm-5.3", "glm-5.3-flash"]);
		});
	});
}

describe("provider model catalog validation", () => {
	it("covers every built-in provider with an explicit model list", () => {
		for (const [kind, preset] of Object.entries(BUILTIN_PROVIDER_PRESETS)) {
			expect(providerModelCatalog({ kind: kind as keyof typeof BUILTIN_PROVIDER_PRESETS, baseUrl: preset.baseUrl }).length).toBeGreaterThan(0);
		}
	});

	const catalog = (models: Record<string, unknown>[]) => ({
		version: 1,
		providers: [{
			id: "sample",
			match: { kinds: ["openai-compatible"], baseUrls: ["https://example.test/v1"] },
			auth: { adapter: "api-key", required: false },
			discovery: { adapter: "openai-models" },
			runtime: { adapter: "openai-chat" },
			restrictToListedModels: false,
			models,
		}],
	});

	it("keeps auth, discovery and runtime policy in the same strict definition", () => {
		const entry = parseProviderModelCatalog(catalog([{ id: "m", input: ["text"] }])).get("sample")!;
		expect(entry.auth).toEqual({ adapter: "api-key", required: false });
		expect(entry.discovery).toEqual({ adapter: "openai-models", requireContextWindow: false });
		expect(entry.runtime).toEqual({ adapter: "openai-chat" });
		expect(providerDefinitionForKind("zai")?.runtime).toMatchObject({ adapter: "openai-chat", thinking: "zai", toolStream: "zai" });
		expect(providerDefinitionForKind("openai-responses")?.runtime.adapter).toBe("openai-responses");
	});

	it("rejects unknown fields, invalid modalities and duplicate models", () => {
		expect(() => parseProviderModelCatalog({ ...catalog([{ id: "m", input: ["text"] }]), extra: true })).toThrow("root field");
		expect(() => parseProviderModelCatalog(catalog([{ id: "m", input: ["audio"] }]))).toThrow("input");
		expect(() => parseProviderModelCatalog(catalog([{ id: "m", input: ["text"] }, { id: "m", input: ["text"] }]))).toThrow("duplicate model");
	});
});

describe("GLM provider configuration", () => {
	it("matches custom providers only at an exact official base URL", () => {
		expect(providerModelDefinition({ kind: "openai-compatible", baseUrl: `${ZAI_BASE_URL}/` }, "glm-5.3-flash")?.input).toEqual(["text", "image"]);
		expect(providerModelDefinition({ kind: "openai-compatible", baseUrl: "https://api.z.ai/api/paas/v4" }, "glm-5.3-flash")).toBeUndefined();
		expect(providerModelDefinition({ kind: "openai-compatible", baseUrl: "https://proxy.example/v1" }, "glm-5.3-flash")).toBeUndefined();
		expect(resolveConfiguredModels({ kind: "openai-compatible", baseUrl: ZAI_BASE_URL }, [{ id: "private-model", overrides: { input: ["text", "image"] } }])).toEqual([{ id: "private-model", overrides: { input: ["text", "image"] } }]);
	});

	it("requires a key, forces the preset endpoint and rejects models outside the catalog", async () => {
		const directory = await mkdtemp(join(tmpdir(), "eta-zai-"));
		let requested = "";
		const store = new ProviderConfigStore(join(directory, "config.json"), async (url, init) => {
			requested = url;
			return response(["glm-5.3", "glm-5.3-flash"])(url, init);
		});
		const provider = { id: "zai", kind: "zai" as const, baseUrl: "https://wrong.example/v1", models: [] };
		try {
			await expect(store.discover({ provider })).rejects.toThrow("key_required");
			const discovered = await store.discover({ provider: { ...provider, apiKey: "test-key" } });
			expect(requested).toBe(`${ZAI_BASE_URL}/models`);
			const saved = await store.save({ revision: (await store.view()).revision, provider: { ...provider, apiKey: "test-key", models: discovered.models } });
			expect(saved.providers[0]?.models.map(model => model.id)).toEqual(["glm-5.3", "glm-5.3-flash"]);
			await expect(store.save({ revision: saved.revision, provider: { ...provider, apiKey: undefined, models: [{ id: "glm-5.3-flashx" }] } })).rejects.toThrow("invalid_model");
		} finally { await rm(directory, { recursive: true, force: true }); }
	});

	it("uses the shared Chat Completions runtime with ZAI compatibility", async () => {
		const payloads: Record<string, any>[] = [];
		const authorizations: string[] = [];
		const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
			authorizations.push(request.headers.get("authorization") ?? "");
			payloads.push(await request.json() as Record<string, any>);
			const chunk = { id: "test", object: "chat.completion.chunk", created: 1, model: "glm-5.3", choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: "stop" }] };
			return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
		} });
		try {
			const models = [...providerModelCatalog({ kind: "zai", baseUrl: ZAI_BASE_URL }).filter(model => model.id === "glm-5.3"), { id: "glm-5.3-flashx" }];
			const registry = configModels({ providers: [{ id: "zai", kind: "zai", baseUrl: `http://127.0.0.1:${server.port}`, apiKey: "eta-key", models }] })!;
			expect(registry.getModel("zai", "glm-5.3-flashx")).toBeUndefined();
			const model = registry.getModel("zai", "glm-5.3")!;
			expect(model.input).toEqual(["text"]);
			expect(model.api).toBe("openai-completions");
			expect(model.compat).toMatchObject({ thinkingFormat: "zai", zaiToolStream: true, supportsDeveloperRole: false, supportsStore: false });
			await registry.completeSimple(model, { messages: [{ role: "user", content: "hello", timestamp: 0 }] });
			await registry.completeSimple(model, { messages: [{ role: "user", content: "hello", timestamp: 0 }] }, { reasoning: "high" });
			expect(authorizations).toEqual(["Bearer eta-key", "Bearer eta-key"]);
			expect(payloads[0]!.thinking).toEqual({ type: "disabled" });
			expect(payloads[0]!.reasoning_effort).toBeUndefined();
			expect(payloads[1]!.thinking).toMatchObject({ type: "enabled" });
			expect(payloads[1]!.reasoning_effort).toBe("high");
		} finally { server.stop(true); }
	});
});
