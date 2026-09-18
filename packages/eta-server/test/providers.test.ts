import { describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProviderConfigStore, discoverProviderModels, KIMI_CODING_BASE_URL, type ProviderFetch } from "../src/providers.ts";
import { configModels, type EtaProviderConfig } from "../src/config.ts";
import { Host } from "../src/host.ts";
import { startServer } from "../src/server.ts";
import { modelDefaultThinking, modelThinkingLevels } from "@eta/core/provider-config";
import { BACKGROUND_CONTEXT } from "@eta/core";

const model = {
	id: "kimi-for-coding", context_length: 262144, display_name: "Kimi for Coding",
	supports_reasoning: true, supports_thinking_type: "both", supports_image_in: true,
	think_efforts: { support: true, valid_efforts: ["low", "high", "max"], default_effort: "high" },
};
const provider: EtaProviderConfig = { id: "local", kind: "openai-compatible", baseUrl: "http://127.0.0.1:7777/v1", apiKey: "private-test-key", models: [{ id: "m", contextWindow: 128000 }] };

async function removeWithRetry(path: string): Promise<void> {
	for (let attempt = 0; ; attempt++) {
		try {
			await rm(path, { recursive: true, force: true });
			return;
		} catch (error) {
			if (attempt >= 5 || (error as NodeJS.ErrnoException).code !== "EBUSY") throw error;
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
	}
}

async function fixture(run: (store: ProviderConfigStore, directory: string) => Promise<void>) {
	const directory = await mkdtemp(join(tmpdir(), "eta-providers-"));
	try { await run(new ProviderConfigStore(join(directory, "config.json")), directory); }
	finally { await removeWithRetry(directory); }
}

function requestFake(body: unknown, status = 200): ProviderFetch {
	return (async () => Response.json(body, { status })) as ProviderFetch;
}

describe("provider discovery and configuration", () => {
	it("discovers Kimi capabilities and effort levels from the endpoint", async () => {
		let seen: { url: string; init?: RequestInit } | undefined;
		const models = await discoverProviderModels({ ...provider, kind: "kimi-coding", baseUrl: KIMI_CODING_BASE_URL }, (async (url, init) => {
			seen = { url: String(url), init };
			return Response.json({ data: [model] });
		}) as ProviderFetch);
		expect(seen?.url).toBe(`${KIMI_CODING_BASE_URL}/models`);
		expect(new Headers(seen?.init?.headers).get("authorization")).toBe("Bearer private-test-key");
		expect(seen?.init?.redirect).toBe("error");
		expect(models[0]).toMatchObject({ id: model.id, reasoning: true, contextWindow: 262144, input: ["text", "image"], reasoningEfforts: ["low", "high", "max"], providerDefaultEffort: "high" });
		expect(modelThinkingLevels(models[0]!)).toEqual(["off", "low", "high", "max"]);
		expect(modelDefaultThinking(models[0]!)).toBe("high");
	});

	it("does not invent effort controls or an off switch for always-thinking models", async () => {
		const models = await discoverProviderModels({ ...provider, kind: "kimi-coding" }, requestFake({ data: [{ ...model, supports_thinking_type: "only", think_efforts: { support: false, valid_efforts: ["low"] } }] }));
		expect(modelThinkingLevels(models[0]!)).toEqual([]);
		expect(models[0]!.reasoningEfforts).toBeUndefined();
	});

	it("keeps API keys out of responses and preserves keys on blank edits", async () => {
		await fixture(async store => {
			let view = await store.view();
			view = await store.save({ revision: view.revision, provider });
			expect(JSON.stringify(view)).not.toContain("private-test-key");
			expect(view.providers[0]!.hasApiKey).toBe(true);
			view = await store.save({ revision: view.revision, provider: { ...provider, apiKey: undefined, name: "Renamed" } });
			expect(JSON.parse(await readFile(store.path, "utf8")).providers[0].apiKey).toBe("private-test-key");
			if (process.platform !== "win32") expect((await stat(store.path)).mode & 0o777).toBe(0o600);
			view = await store.save({ revision: view.revision, provider: { ...provider, apiKey: null } });
			expect(view.providers[0]!.hasApiKey).toBe(false);
		});
	});

	it("requires re-entry before sending a saved key to a different endpoint", async () => {
		await fixture(async store => {
			const view = await store.save({ revision: (await store.view()).revision, provider });
			await expect(store.discover({ provider: { ...provider, apiKey: undefined, baseUrl: "https://different.example/v1" } })).rejects.toThrow("key_required_for_url");
			expect((await store.view()).revision).toBe(view.revision);
		});
	});

	it("sends custom headers on model listing and lets a null value suppress built-in ones", async () => {
		let seen: RequestInit | undefined;
		const models = await discoverProviderModels({ ...provider, headers: { "X-Title": "eta-agent", "User-Agent": "eta-agent/1", Authorization: null } }, (async (_url, init) => {
			seen = init;
			return Response.json({ data: [model] });
		}) as ProviderFetch);
		const headers = new Headers(seen?.headers);
		expect(headers.get("x-title")).toBe("eta-agent");
		expect(headers.get("user-agent")).toBe("eta-agent/1");
		expect(headers.get("accept")).toBe("application/json");
		// A saved key must not leak to an endpoint that asked for a different auth header.
		expect(headers.get("authorization")).toBeNull();
		expect(models).toHaveLength(1);
	});

	it("stores and echoes custom headers, keeps them on unrelated edits, and rejects malformed ones", async () => {
		await fixture(async store => {
			let view = await store.save({ revision: (await store.view()).revision, provider: { ...provider, headers: { "X-Title": null, "User-Agent": "eta-agent/1" } } });
			expect(view.providers[0]!.headers).toEqual({ "X-Title": null, "User-Agent": "eta-agent/1" });
			expect(JSON.parse(await readFile(store.path, "utf8")).providers[0].headers).toEqual({ "X-Title": null, "User-Agent": "eta-agent/1" });
			view = await store.save({ revision: view.revision, provider: { ...provider, name: "Renamed" } });
			expect(view.providers[0]!.headers).toEqual({ "X-Title": null, "User-Agent": "eta-agent/1" });
			// Names are HTTP header names: case-insensitive by definition, so one entry survives.
			view = await store.save({ revision: view.revision, provider: { ...provider, headers: { "x-title": "first", "X-Title": "last" } } });
			expect(view.providers[0]!.headers).toEqual({ "X-Title": "last" });
			for (const headers of [{ "Bad Name": "x" }, { "X-Bad": "line\r\nbreak" }, { "X-Bad": 7 }, { "X-Bad": {} }]) {
				await expect(store.save({ revision: view.revision, provider: { ...provider, headers } })).rejects.toThrow("invalid_header");
			}
			view = await store.save({ revision: view.revision, provider: { ...provider, headers: null } });
			expect(view.providers[0]!.headers).toBeUndefined();
			expect(JSON.parse(await readFile(store.path, "utf8")).providers[0].headers).toBeUndefined();
		});
	});

	it("serializes competing saves and preserves other providers and top-level configuration", async () => {
		await fixture(async store => {
			await writeFile(store.path, JSON.stringify({ extra: "keep", providers: [provider] }));
			const revision = (await store.view()).revision;
			const results = await Promise.allSettled([
				store.save({ revision, provider: { ...provider, id: "second" } }),
				store.save({ revision, provider: { ...provider, id: "third" } }),
			]);
			expect(results.map(result => result.status)).toEqual(["fulfilled", "rejected"]);
			const saved = JSON.parse(await readFile(store.path, "utf8"));
			expect(saved.extra).toBe("keep");
			expect(saved.providers.map((p: { id: string }) => p.id)).toEqual(["local", "second"]);
		});
	});

	it("never overwrites a malformed existing config", async () => {
		await fixture(async store => {
			await writeFile(store.path, "{broken");
			await expect(store.view()).rejects.toThrow("invalid_saved_config");
			await expect(store.save({ provider, revision: "x" })).rejects.toThrow("invalid_saved_config");
			expect(await readFile(store.path, "utf8")).toBe("{broken");
		});
	});

	it("refresh preserves manual overrides and valid user effort preferences", async () => {
		await fixture(async store => {
			const custom = { ...provider, models: [{ id: model.id, reasoning: true, reasoningEfforts: ["low", "high"], providerDefaultEffort: "high", thinkingMode: "both", defaultThinking: "low", overrides: { contextWindow: 64000 } }] };
			const view = await store.save({ revision: (await store.view()).revision, provider: custom });
			const discovery = new ProviderConfigStore(store.path, requestFake({ data: [model] }));
			const result = await discovery.discover({ provider: { ...custom, apiKey: undefined } });
			expect(result.models[0]!.overrides?.contextWindow).toBe(64000);
			expect(result.models[0]!.defaultThinking).toBe("low");
			expect((await store.view()).revision).toBe(view.revision);
		});
	});

	it("treats the Responses protocol as a custom endpoint and rejects unknown kinds", async () => {
		await fixture(async store => {
			// A custom kind needs no key, exactly like openai-compatible.
			const custom = { ...provider, kind: "openai-responses" as const, apiKey: undefined, baseUrl: "https://example.com/v1", models: [{ id: "grok-4.6", overrides: { contextWindow: 2_000_000 } }] };
			await store.save({ revision: (await store.view()).revision, provider: custom });
			const view = await store.view();
			expect(view.providers[0]!.kind).toBe("openai-responses");
			expect(view.providers[0]!.hasApiKey).toBe(false);
			const discovery = new ProviderConfigStore(store.path, requestFake({ data: [{ id: "grok-4.6" }] }));
			expect((await discovery.discover({ provider: custom })).models[0]!.overrides?.contextWindow).toBe(2_000_000);
			await expect(store.save({ revision: view.revision, provider: { ...custom, kind: "openai-nonsense" as never } })).rejects.toThrow("invalid_provider");
		});
	});

	it("retains the saved catalog when refresh fails and sanitizes upstream errors", async () => {
		await fixture(async store => {
			const view = await store.save({ revision: (await store.view()).revision, provider });
			const discovery = new ProviderConfigStore(store.path, requestFake({ error: "private-test-key leaked upstream" }, 401));
			await expect(discovery.discover({ provider })).rejects.toThrow("authentication_failed");
			expect(await store.view()).toEqual(view);
		});
	});
});

function llmServer(toolCall = false) {
	const payloads: Record<string, any>[] = [];
	const headers: Headers[] = [];
	const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
		if (new URL(request.url).pathname === "/v1/models") return Response.json({ data: [model] });
		headers.push(request.headers);
		const body = await request.json() as Record<string, any>;
		payloads.push(body);
		const needsTool = toolCall && !body.messages.some((message: { role: string }) => message.role === "tool");
		const delta = needsTool
			? { role: "assistant", reasoning_content: "Read the current tasks.", tool_calls: [{ index: 0, id: "call-list", type: "function", function: { name: "TaskList", arguments: "{}" } }] }
			: { role: "assistant", content: "connected" };
		const chunk = { id: "test", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason: needsTool ? "tool_calls" : "stop" }] };
		return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
	} });
	return { server, payloads, headers, url: `http://127.0.0.1:${server.port}/v1` };
}

/**
 * Responses-API stand-in: the same JSON bodies, different event names and no `[DONE]` sentinel.
 * Emits the smallest stream the adapter accepts — an item, a delta, and a terminal response.
 */
function responsesServer() {
	const payloads: Record<string, any>[] = [];
	const paths: string[] = [];
	const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
		paths.push(new URL(request.url).pathname);
		const body = await request.json() as Record<string, any>;
		payloads.push(body);
		const events = [
			{ type: "response.created", response: { id: "resp_test" } },
			{ type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_test", role: "assistant" } },
			{ type: "response.output_text.delta", output_index: 0, content_index: 0, item_id: "msg_test", delta: "connected" },
			{ type: "response.completed", response: { id: "resp_test", status: "completed", output: [], usage: {
				input_tokens: 11, output_tokens: 2, total_tokens: 13, input_tokens_details: { cached_tokens: 4 },
			} } },
		];
		return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
	} });
	return { server, payloads, paths, url: `http://127.0.0.1:${server.port}/v1` };
}

describe("provider runtime integration", () => {
	it("restores the actual thinking level and the session's compaction preference", async () => {
		await fixture(async (store, directory) => {
			const upstream = llmServer();
			const options = { configPath: store.path, dataDir: join(directory, "sessions"), heartbeatMs: 0 };
			const first = new Host(options);
			const second = new Host(options);
			try {
				const [discovered] = await discoverProviderModels({ ...provider, kind: "kimi-coding" }, requestFake({ data: [model] }));
				await first.saveProvider({ revision: (await store.view()).revision, provider: { ...provider, baseUrl: upstream.url, models: [{ ...discovered, defaultThinking: "max" }] } });
				await first.saveSettings({ keepRecentTokens: 12000 });
				await first.createSession("restore", "Thinker", directory);
				await first.saveSettings({ keepRecentTokens: 24000 });
				await first.close();
				await second.restoreSessions();
				expect(second.viewOf("restore")?.thinkingLevel).toBe("max");
				expect((await second.agentOf("restore")!.harness.getCompactionSettings(BACKGROUND_CONTEXT)).keepRecentTokens).toBe(12000);
			} finally { await first.close(); await second.close(); upstream.server.stop(true); }
		});
	});

	it("completes a streamed reasoning and tool-call round trip", async () => {
		await fixture(async (store, directory) => {
			const upstream = llmServer(true);
			const host = new Host({ configPath: store.path, dataDir: join(directory, "sessions"), heartbeatMs: 0 });
			try {
				const models = await discoverProviderModels({ ...provider, kind: "kimi-coding" }, requestFake({ data: [model] }));
				// A local fixture stands in for Kimi's wire protocol; no real credentials leave the machine.
				await writeFile(store.path, JSON.stringify({ providers: [{ ...provider, kind: "kimi-coding", baseUrl: upstream.url, models }] }));
				await host.createSession("tools", "Thinker", directory);
				await host.prompt("tools", "List the tasks");
				expect(upstream.payloads).toHaveLength(2);
				expect(upstream.payloads[1]!.messages.some((message: { role: string }) => message.role === "tool")).toBe(true);
				expect(upstream.payloads[1]!.messages.find((message: { tool_calls?: unknown }) => message.tool_calls)?.reasoning_content).toBe("Read the current tasks.");
				expect(upstream.payloads[1]!.reasoning_effort).toBe("high");
			} finally { await host.close(); upstream.server.stop(true); }
		});
	});

	it("sends the chosen Kimi effort through OpenAI Chat Completions", async () => {
		const upstream = llmServer();
		try {
			const [discovered] = await discoverProviderModels({ ...provider, kind: "kimi-coding" }, requestFake({ data: [model] }));
			const registry = configModels({ providers: [{ ...provider, kind: "kimi-coding", baseUrl: upstream.url, models: [discovered!] }] })!;
			const chosen = registry.getModel(provider.id, model.id)!;
			const result = await registry.completeSimple(chosen, { messages: [{ role: "user", content: "hello", timestamp: Date.now() }] }, { reasoning: "max" });
			expect(result.stopReason).toBe("stop");
			expect(upstream.payloads[0]!.reasoning_effort).toBe("max");
			expect(upstream.payloads[0]!.model).toBe(model.id);
			await registry.completeSimple(chosen, { messages: [{ role: "user", content: "hello", timestamp: Date.now() }] });
			expect(upstream.payloads[1]!.reasoning_effort).toBe("none");
		} finally { upstream.server.stop(true); }
	});

	it("posts to /responses for the Responses protocol and parses its stream", async () => {
		const upstream = responsesServer();
		try {
			const registry = configModels({ providers: [{ ...provider, kind: "openai-responses", baseUrl: upstream.url, models: [{ id: "grok-4.6" }] }] })!;
			const chosen = registry.getModel(provider.id, "grok-4.6")!;
			expect(chosen.api).toBe("openai-responses");
			const result = await registry.completeSimple(chosen, { messages: [{ role: "user", content: "hello", timestamp: Date.now() }] });
			expect(result.stopReason).toBe("stop");
			expect(result.content.filter((block): block is { type: "text"; text: string } => block.type === "text").map(block => block.text).join("")).toBe("connected");
			expect(result.usage.input).toBe(7);
			expect(result.usage.cacheRead).toBe(4);
			// The transport is the whole point: same provider record, different endpoint.
			expect(upstream.paths).toEqual(["/v1/responses"]);
			expect(upstream.payloads[0]!.model).toBe("grok-4.6");
			// Responses takes input items, and has no chat `messages` or `max_tokens` fields.
			expect(Array.isArray(upstream.payloads[0]!.input)).toBe(true);
			expect(upstream.payloads[0]!.messages).toBeUndefined();
			expect(upstream.payloads[0]!.max_tokens).toBeUndefined();
			expect(upstream.payloads[0]!.store).toBe(false);
		} finally { upstream.server.stop(true); }
	});

	it("keeps Chat Completions flags off a Responses provider", async () => {
		const upstream = responsesServer();
		try {
			const registry = configModels({ providers: [{ ...provider, kind: "openai-responses", baseUrl: upstream.url, models: [{ id: "grok-4.6", reasoning: true, thinkingMode: "both", reasoningEfforts: ["low", "high"], providerDefaultEffort: "high" }] }] })!;
			await registry.completeSimple(registry.getModel(provider.id, "grok-4.6")!, { messages: [{ role: "user", content: "hello", timestamp: Date.now() }] }, { reasoning: "high" });
			const body = upstream.payloads[0]!;
			// `max_output_tokens`, not the Chat Completions `max_tokens` the kimi/deepseek compat names.
			expect(body.max_output_tokens).toBeDefined();
			expect(body.reasoning_effort).toBeUndefined();
			expect(body.reasoning).toMatchObject({ effort: "high" });
		} finally { upstream.server.stop(true); }
	});

	it("puts configured headers on the inference request, overriding the adapter defaults", async () => {
		const upstream = llmServer();
		try {
			const [discovered] = await discoverProviderModels({ ...provider, kind: "kimi-coding" }, requestFake({ data: [model] }));
			const registry = configModels({ providers: [{ ...provider, kind: "kimi-coding", baseUrl: upstream.url, headers: { "X-Title": "eta-agent", "User-Agent": "eta-agent/1" }, models: [discovered!] }] })!;
			await registry.completeSimple(registry.getModel(provider.id, model.id)!, { messages: [{ role: "user", content: "hello", timestamp: Date.now() }] });
			expect(upstream.headers).toHaveLength(1);
			expect(upstream.headers[0]!.get("x-title")).toBe("eta-agent");
			// pi would send its own “pi (…)” User-Agent; the configured one must win.
			expect(upstream.headers[0]!.get("user-agent")).toBe("eta-agent/1");
			expect(upstream.headers[0]!.get("authorization")).toBe("Bearer private-test-key");
		} finally { upstream.server.stop(true); }
	});

	it("adds a provider to an existing faux session without restart and uses its default effort", async () => {
		await fixture(async (store, directory) => {
			const upstream = llmServer();
			const host = new Host({ configPath: store.path, dataDir: join(directory, "sessions"), heartbeatMs: 0 });
			try {
				await host.createSession("one", "Thinker", directory);
				const [discovered] = await discoverProviderModels({ ...provider, kind: "kimi-coding" }, requestFake({ data: [model] }));
				await host.saveProvider({ revision: (await store.view()).revision, provider: { ...provider, baseUrl: upstream.url, models: [{ ...discovered, defaultThinking: "max" }] } });
				await host.modelSet("one", `local:${model.id}`);
				await host.prompt("one", "hello");
				expect(upstream.payloads[0]!.model).toBe(model.id);
				expect(upstream.payloads[0]!.reasoning_effort).toBe("max");
				await expect(host.deleteProvider("local", (await store.view()).revision)).rejects.toThrow("provider_in_use");
			} finally { await host.close(); upstream.server.stop(true); }
		});
	});

	it("serves redacted settings APIs and refuses cross-origin management requests", async () => {
		await fixture(async (store, directory) => {
			const app = await startServer({ hostname: "127.0.0.1", port: 0, configPath: store.path, dataDir: join(directory, "sessions"), heartbeatMs: 0 });
			const url = `http://127.0.0.1:${app.port}/api/providers`;
			try {
				const view = await (await fetch(url)).json() as { revision: string };
				const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ revision: view.revision, provider }) });
				expect(response.status).toBe(200);
				expect(await response.text()).not.toContain("private-test-key");
				const denied = await fetch(url, { headers: { origin: "https://unrelated.example" } });
				expect(denied.status).toBe(403);
				expect(denied.headers.get("access-control-allow-origin")).toBeNull();
			} finally { app.close(); await app.host.close(); }
		});
	});

	it("deletes an unused provider through HTTP and clears its default model", async () => {
		await fixture(async (store, directory) => {
			let saved = await store.save({ revision: (await store.view()).revision, provider });
			saved = await store.setDefault({ revision: saved.revision, defaultModel: "local:m" });
			const app = await startServer({ hostname: "127.0.0.1", port: 0, configPath: store.path, dataDir: join(directory, "sessions"), heartbeatMs: 0 });
			try {
				await app.host.saveSettings({ modelId: "local:m", thinkingLevel: "high" });
				const response = await fetch(`http://127.0.0.1:${app.port}/api/providers/local`, {
					method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ revision: saved.revision }),
				});
				expect(response.status).toBe(200);
				const result = await response.json() as { providers: unknown[]; defaultModel?: string };
				expect(result.providers).toEqual([]);
				expect(result.defaultModel).toBeUndefined();
				expect(app.host.settings().modelId).toBeUndefined();
				expect((await store.view()).providers).toEqual([]);
			} finally { app.close(); await app.host.close(); }
		});
	});
});
