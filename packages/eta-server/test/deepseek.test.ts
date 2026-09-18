import { describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { modelDefaultThinking, modelThinkingLevels } from "@eta/core/provider-config";
import { configModels } from "../src/config.ts";
import { DEEPSEEK_BASE_URL, ProviderConfigStore, discoverProviderModels, type ProviderFetch } from "../src/providers.ts";

const provider = { id: "deepseek", kind: "deepseek" as const, baseUrl: DEEPSEEK_BASE_URL, apiKey: "test-key", models: [] };
const modelIds = ["deepseek-flash", "deepseek-v4-pro"];
const data = modelIds.map(id => ({ id, object: "model", owned_by: "deepseek" }));
const response = (models: unknown[]): ProviderFetch => async () => Response.json({ object: "list", data: models });

describe("DeepSeek provider", () => {
	it("enriches the official minimal model list with documented efforts", async () => {
		const models = await discoverProviderModels(provider, response(data));
		expect(models.map(model => model.id)).toEqual(modelIds);
		for (const model of models) {
			expect(modelThinkingLevels(model)).toEqual(["off", "low", "high", "max"]);
			expect(modelDefaultThinking(model)).toBe("high");
			expect(model.maxTokens).toBe(131072);
		}
		expect(models[0]!.input).toEqual(["text", "image"]);
		expect(models[1]!.input).toEqual(["text"]);
	});

	it("admits only deepseek-flash and deepseek-v4-pro", async () => {
		const ids = ["deepseek-flash", "deepseek-v4-pro", "deepseek-v4-flash", "deepseek-v4-flash-vision-exp", "deepseek-future"];
		const models = await discoverProviderModels(provider, response(ids.map(id => ({ id }))));
		expect(models.map(model => model.id)).toEqual(modelIds);
	});

	it("lets explicit API metadata override the documented fallback", async () => {
		const [model] = await discoverProviderModels(provider, response([{
			id: "deepseek-flash", context_length: 2000000, supports_image_in: false,
			think_efforts: { support: true, valid_efforts: ["low", "max"], default_effort: "max" },
		}]));
		expect(model!.contextWindow).toBe(2000000);
		expect(model!.input).toEqual(["text"]);
		expect(modelThinkingLevels(model!)).toEqual(["off", "low", "max"]);
		expect(modelDefaultThinking(model!)).toBe("max");
	});

	it("preserves explicit endpoint metadata when saving a restricted catalog", async () => {
		const directory = await mkdtemp(join(tmpdir(), "eta-deepseek-explicit-"));
		const store = new ProviderConfigStore(join(directory, "config.json"), response([{
			id: "deepseek-flash", context_length: 2000000, supports_image_in: false,
			think_efforts: { support: true, valid_efforts: ["low", "max"], default_effort: "max" },
		}]));
		try {
			const discovered = await store.discover({ provider });
			const saved = await store.save({ revision: (await store.view()).revision, provider: { ...provider, models: discovered.models } });
			expect(saved.providers[0]!.models[0]).toMatchObject({ contextWindow: 2000000, input: ["text"], reasoningEfforts: ["low", "max"], providerDefaultEffort: "max" });
		} finally { await rm(directory, { recursive: true, force: true }); }
	});

	it("honors an explicit removal of effort controls and a smaller context", async () => {
		const [model] = await discoverProviderModels(provider, response([{
			id: "deepseek-flash", context_length: 64000, think_efforts: { support: false },
		}]));
		expect(modelThinkingLevels(model!)).toEqual([]);
		expect(model!.providerDefaultEffort).toBeUndefined();
		expect(model!.maxTokens).toBe(64000);
	});

	it("uses the official endpoint and requires a key", async () => {
		const directory = await mkdtemp(join(tmpdir(), "eta-deepseek-"));
		let requestedUrl = "";
		let authorization = "";
		const store = new ProviderConfigStore(join(directory, "config.json"), async (url, init) => {
			requestedUrl = url;
			authorization = new Headers(init?.headers).get("authorization") ?? "";
			return Response.json({ data });
		});
		try {
			await expect(store.discover({ provider: { ...provider, apiKey: undefined } })).rejects.toThrow("deepseek_key_required");
			const discovered = await store.discover({ provider: { ...provider, baseUrl: "https://unrelated.example" } });
			expect(requestedUrl).toBe("https://api.deepseek.com/models");
			expect(authorization).toBe("Bearer test-key");
			const saved = await store.save({ revision: (await store.view()).revision, provider: { ...provider, models: discovered.models } });
			expect(saved.providers[0]!.kind).toBe("deepseek");
			expect(JSON.stringify(saved)).not.toContain("test-key");
		} finally { await rm(directory, { recursive: true, force: true }); }
	});

	it("serializes off, canonical levels and legacy aliases to DeepSeek request fields", async () => {
		const bodies: any[] = [];
		const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
			const body = await request.json(); bodies.push(body);
			return new Response(`data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", created: 1, model: "deepseek-flash", choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
		} });
		try {
			const models = await discoverProviderModels(provider, response(data));
			const registry = configModels({ providers: [{ ...provider, baseUrl: `http://127.0.0.1:${server.port}`, models }] })!;
			for (const id of modelIds) {
				const model = registry.getModel("deepseek", id)!;
				for (const effort of ["off", "low", "high", "max", "minimal", "medium", "xhigh"] as const) {
					const result = await registry.completeSimple(model, { messages: [{ role: "user", content: "hello", timestamp: 0 }] }, effort === "off" ? {} : { reasoning: effort });
					expect(result.stopReason).toBe("stop");
					const body = bodies.at(-1)!;
					expect(body.model).toBe(id);
					expect(body.thinking).toEqual({ type: effort === "off" ? "disabled" : "enabled" });
					const mapped = effort === "minimal" ? "low" : effort === "medium" || effort === "xhigh" ? "high" : effort;
					expect(body.reasoning_effort).toBe(effort === "off" ? undefined : mapped);
				}
			}
		} finally { server.stop(true); }
	});
});
