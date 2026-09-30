/**
 * Config → Models (S20).
 *
 * Two things matter and both are about what a request actually carries: a configured provider's
 * headers reach the request (that is how a custom `User-Agent` gets to an endpoint that requires
 * one), and one provider that cannot be built does not take the others down with it.
 *
 * The request itself is checked through a fake fetch: the model layer is real (pi-ai builds and
 * streams), only the network is scripted.
 */
import { describe, expect, it } from "vitest";
import { parseProviderModelCatalog, providerModelCatalog, resolveConfiguredModels } from "../src/providers/catalog";
import type { EtaProviderConfig } from "../src/providers/config-types";
import { discoverModels } from "../src/providers/discovery";
import { buildModels, buildProvider } from "../src/providers/runtime";

/** A provider that speaks to a test server, so the request it builds can be inspected. */
function localProvider(overrides: Partial<EtaProviderConfig> = {}): EtaProviderConfig {
	return {
		id: "local",
		kind: "openai-compatible",
		baseUrl: "https://local.test/v1",
		apiKey: "sk-test",
		models: [{ id: "m1", contextWindow: 32_000, maxTokens: 1_000 }],
		...overrides,
	};
}

describe("building the model layer", () => {
	it("builds a provider whose models are the configured ones", async () => {
		const { models, failed } = await buildModels([localProvider()]);
		expect(failed).toEqual([]);
		expect(models?.getModel("local", "m1")).toMatchObject({ id: "m1", provider: "local", contextWindow: 32_000 });
		expect(models?.getModel("local", "m1")?.baseUrl).toBe("https://local.test/v1");
		// The model the config does not mention is not there: the list is the config's.
		expect(models?.getModel("local", "m2")).toBeUndefined();
	});

	it("carries the provider's headers onto every model of that provider", async () => {
		const { models } = await buildModels([
			localProvider({ headers: { "User-Agent": "eta/1", "X-Empty": null, "X-Drop": "" } }),
		]);
		const model = models?.getModel("local", "m1") as { headers?: Record<string, string> } | undefined;
		expect(model?.headers).toEqual({ "User-Agent": "eta/1" });
	});

	it("offers no model layer when nothing is configured", async () => {
		const { models, failed } = await buildModels([]);
		expect(models).toBeUndefined();
		expect(failed).toEqual([]);
	});

	it("reports a provider it cannot build and keeps the rest", async () => {
		const failures: string[] = [];
		const { models, failed } = await buildModels(
			[
				localProvider({ id: "good" }),
				// A kind the catalog does not know: nothing to build a runtime from.
				localProvider({ id: "bad", kind: "not-a-kind" as never }),
				localProvider({ id: "also-good" }),
			],
			{ warn: (message) => failures.push(message) },
		);
		expect(failed.map((entry) => entry.id)).toEqual(["bad"]);
		expect(failed[0]?.error).toContain("unsupported provider kind");
		expect(models?.getModel("good", "m1")).toBeDefined();
		expect(models?.getModel("also-good", "m1")).toBeDefined();
		expect(models?.getModel("bad", "m1")).toBeUndefined();
		expect(failures[0]).toContain("bad");
	});

	it("builds a provider that has no key at all, for a local endpoint", async () => {
		const provider = await buildProvider(localProvider({ apiKey: undefined }));
		expect(provider.id).toBe("local");
	});
});

describe("what the catalog says about a provider", () => {
	it("knows a built-in kind's models, with capabilities", () => {
		const models = providerModelCatalog({ kind: "deepseek", baseUrl: "https://api.deepseek.com" });
		expect(models.length).toBeGreaterThan(0);
		expect(models[0]).toHaveProperty("id");
		expect(models.some((model) => model.contextWindow !== undefined)).toBe(true);
	});

	it("knows nothing about an endpoint it has never heard of", () => {
		expect(providerModelCatalog({ kind: "openai-compatible", baseUrl: "https://nobody.test/v1" })).toEqual([]);
	});

	it("fills a saved model in from the catalog, without replacing what the user chose", () => {
		const known = providerModelCatalog({ kind: "deepseek", baseUrl: "https://api.deepseek.com" })[0]?.id as string;
		const resolved = resolveConfiguredModels({ kind: "deepseek", baseUrl: "https://api.deepseek.com" }, [
			{ id: known, name: "my name" },
		]);
		expect(resolved[0]?.name).toBe("my name");
		// What the catalog knows that the user did not say is filled in.
		expect(resolved[0]?.contextWindow).toBeGreaterThan(0);
	});

	it("drops a model a restricted provider does not serve", () => {
		// A provider whose catalog lists its models serves only those: an id the user typed has to
		// be rejected here, or it becomes an alias for something the endpoint will refuse.
		const resolved = resolveConfiguredModels({ kind: "deepseek", baseUrl: "https://api.deepseek.com" }, [
			{ id: "made-up-model" },
		]);
		expect(resolved).toEqual([]);
	});

	it("refuses a catalog that does not describe itself honestly", () => {
		expect(() => parseProviderModelCatalog({ version: 2, providers: [] })).toThrow(/version/);
		expect(() =>
			parseProviderModelCatalog({
				version: 1,
				providers: [
					{
						id: "a",
						match: { kinds: ["deepseek"], baseUrls: [] },
						auth: { adapter: "api-key", required: true },
						discovery: { adapter: "openai-models" },
						runtime: { adapter: "openai-chat" },
						restrictToListedModels: true,
						models: [{ id: "m1", contextWindow: 100, maxTokens: 200 }],
					},
				],
			}),
		).toThrow(/token limits/);
	});
});

describe("discovery", () => {
	/** A fetch that answers `/models` and records what it was asked. */
	function fakeFetch(body: unknown, status = 200) {
		const calls: { url: string; headers: Record<string, string> }[] = [];
		const send = (async (url: string, init?: { headers?: Record<string, string> }) => {
			calls.push({ url: String(url), headers: init?.headers ?? {} });
			return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
		}) as unknown as typeof fetch;
		return { send, calls };
	}

	it("asks the endpoint with the same key and headers a request would carry", async () => {
		const { send, calls } = fakeFetch({ data: [{ id: "m1", context_window: 200_000, max_tokens: 8_000 }] });
		const { models } = await buildModels([localProvider({ headers: { "User-Agent": "eta/1" } })], { fetch: send });
		// The refresh is what calls fetch; the model layer's own `refresh` drives it.
		await models?.refresh({ providers: ["local"], allowNetwork: true, force: true });
		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toBe("https://local.test/v1/models");
		expect(calls[0]?.headers.Authorization).toBe("Bearer sk-test");
		expect(calls[0]?.headers["User-Agent"]).toBe("eta/1");
	});

	it("turns the answer into models, skipping entries that are not models at all", async () => {
		const { send } = fakeFetch({
			data: [{ id: "good", context_window: 200_000, max_tokens: 8_000 }, { id: "no-window" }, { notAModel: true }],
		});
		const { models } = await buildModels([localProvider()], { fetch: send });
		const result = await models?.refresh({ providers: ["local"], allowNetwork: true, force: true });
		expect(result?.errors.size).toBe(0);
		const ids = models?.getModels("local").map((model) => model.id) ?? [];
		expect(ids).toContain("good");
		// An entry with no id is not a model; the ones with ids are, and the models the config
		// declared are still there — a refresh adds what the endpoint knows, it does not erase.
		expect(ids).toContain("no-window");
		expect(ids).toContain("m1");
		expect(ids).toHaveLength(3);
	});

	it("skips a discovered model with no context window when the provider requires one", async () => {
		// Guessing a window here is how a 1M-token model gets compacted at 128k, so a provider
		// whose discovery demands one has the entry dropped instead.
		const { send } = fakeFetch({
			data: [{ id: "kimi-for-coding", context_window: 200_000, max_tokens: 8_000 }, { id: "no-window" }],
		});
		const discovered = await discoverModels({
			reference: { kind: "kimi-coding", baseUrl: "https://api.kimi.com/coding/v1" },
			fetch: send,
		});
		expect(discovered.error).toBeUndefined();
		expect(discovered.models.map((model) => model.id)).toEqual(["kimi-for-coding"]);
		// The same answer from a provider that does not require one keeps both.
		const loose = await discoverModels({
			reference: { kind: "openai-compatible", baseUrl: "https://x.test/v1" },
			fetch: send,
		});
		expect(loose.models.map((model) => model.id)).toEqual(["kimi-for-coding", "no-window"]);
	});

	it("reports a failure instead of pretending the provider serves nothing", async () => {
		const { send } = fakeFetch({ error: "nope" }, 401);
		const { models } = await buildModels([localProvider()], { fetch: send });
		const result = await models?.refresh({ providers: ["local"], allowNetwork: true, force: true });
		expect(result?.errors.size).toBe(1);
		// The models the config declared are still there: a failed refresh is not a wipe.
		expect(models?.getModel("local", "m1")).toBeDefined();
	});
});

describe("discovery on its own", () => {
	it("refuses a provider that does not publish a model list", async () => {
		// `deepseek`'s catalog entry discovers from the endpoint; the codex kind is the one that
		// serves a fixed list, so that is what "does not publish" means here.
		const result = await discoverModels({
			reference: { kind: "openai-codex", baseUrl: "https://chatgpt.com/backend-api" },
		});
		expect(result.models).toEqual([]);
		expect(result.error).toContain("does not publish");
	});

	it("says what went wrong rather than returning an empty list", async () => {
		const notJson = (async () => new Response("hello", { status: 200 })) as unknown as typeof fetch;
		expect(
			(
				await discoverModels({
					reference: { kind: "openai-compatible", baseUrl: "https://x.test/v1" },
					fetch: notJson,
				})
			).error,
		).toContain("not JSON");
		const wrongShape = (async () =>
			new Response(JSON.stringify({ models: [] }), { status: 200 })) as unknown as typeof fetch;
		expect(
			(
				await discoverModels({
					reference: { kind: "openai-compatible", baseUrl: "https://x.test/v1" },
					fetch: wrongShape,
				})
			).error,
		).toContain("no data array");
	});
});
