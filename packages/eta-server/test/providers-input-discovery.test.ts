/**
 * Input modalities found at discovery: what a custom endpoint's `/models` declares, what
 * models.dev says of a gateway's prefixed ids, and what the user's own config keeps over both.
 * Nothing here reaches a real endpoint or models.dev.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listProviderModels } from "../src/providers/discovery";
import { MODELS_DEV_URL } from "../src/providers/metadata";
import { ProviderConfigStore, revisionOf } from "../src/providers/store";

const BASE = "https://gateway.example.test/v1";

const MODELS_DEV = {
  anthropic: {
    id: "anthropic",
    npm: "@ai-sdk/anthropic",
    models: {
      "model-a": {
        id: "model-a",
        modalities: { input: ["text", "image"] },
      },
      "model-a-full": {
        id: "model-a-full",
        reasoning: true,
        reasoning_options: [{ type: "effort", values: ["low", "high"] }],
        limit: { context: 200000, output: 64000 },
        modalities: { input: ["text", "image"] },
      },
      "text-only": { id: "text-only", modalities: { input: ["text"] } },
      "no-modalities": { id: "no-modalities" },
    },
  },
  // Two listings that agree, and two that do not.
  "reseller-a": {
    id: "reseller-a",
    npm: "@ai-sdk/openai-compatible",
    api: "https://a.example/v1",
    models: {
      "agreed-model": {
        id: "agreed-model",
        limit: { context: 128000, output: 8000 },
      },
      "disputed-model": {
        id: "disputed-model",
        limit: { context: 128000, output: 8000 },
        modalities: { input: ["text", "image"] },
      },
    },
  },
  "reseller-b": {
    id: "reseller-b",
    npm: "@ai-sdk/openai-compatible",
    api: "https://b.example/v1",
    models: {
      "agreed-model": {
        id: "agreed-model",
        limit: { context: 128000, output: 8000 },
      },
      "disputed-model": {
        id: "disputed-model",
        limit: { context: 64000, output: 8000 },
        modalities: { input: ["text"] },
      },
    },
  },
};

function endpoint(list: unknown[]): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input);
    if (url === MODELS_DEV_URL) return Response.json(MODELS_DEV);
    if (url === `${BASE}/models`) return Response.json({ data: list });
    return new Response(null, { status: 404 });
  }) as unknown as typeof fetch;
}

const list = (data: unknown[]) =>
  listProviderModels({
    reference: { kind: "openai-responses", baseUrl: BASE },
    fetch: endpoint(data),
  });

describe("input declared by the endpoint's /models", () => {
  it("reads the common spellings of an image input", async () => {
    const { models } = await list([
      { id: "a", architecture: { input_modalities: ["text", "image"] } },
      { id: "b", input_modalities: ["Image", "text"] },
      { id: "c", supported_input_modalities: ["text", "image"] },
      { id: "d", modalities: ["text", "image"] },
      { id: "e", modalities: { input: ["text", "image"] } },
      { id: "f", capabilities: { vision: true } },
    ]);
    expect(models.map((model) => model.input)).toEqual(
      Array.from({ length: 6 }, () => ["text", "image"]),
    );
  });

  it("keeps a declared text-only model text-only, even where models.dev says image", async () => {
    const { models } = await list([
      { id: "gateway/model-a", input_modalities: ["text"] },
    ]);
    expect(models).toEqual([{ id: "gateway/model-a", input: ["text"] }]);
  });
});

describe("reasoning declared by the endpoint's /models", () => {
  it("reads reasoning and the effort levels from a gateway's entry", async () => {
    const { models } = await list([
      {
        id: "gateway/model-b",
        reasoning: true,
        reasoning_levels: ["low", "high", "max"],
        supported_reasoning_levels: [
          { effort: "low" },
          { effort: "high" },
          { effort: "max" },
        ],
        supported_parameters: ["tools", "tool_choice", "reasoning"],
        context_length: 1000000,
        context_window: 1000000,
        max_output_tokens: 200000,
        modalities: { input: ["text", "image", "pdf"] },
      },
    ]);
    expect(models).toEqual([
      {
        id: "gateway/model-b",
        input: ["text", "image"],
        contextWindow: 1000000,
        maxTokens: 200000,
        reasoning: true,
        reasoningEfforts: ["low", "high", "max"],
      },
    ]);
  });

  it("falls back to reasoning_levels, and flags reasoning from supported_parameters", async () => {
    const { models } = await list([
      { id: "a", reasoning_levels: ["medium", "high"] },
      { id: "b", supported_parameters: ["reasoning"] },
    ]);
    expect(models).toEqual([
      // Levels it can be asked for say it reasons, even without `reasoning: true`.
      { id: "a", reasoning: true, reasoningEfforts: ["medium", "high"] },
      { id: "b", reasoning: true },
    ]);
  });

  it("keeps a declared none as the model's off switch", async () => {
    const { models } = await list([
      { id: "a", reasoning: true, reasoning_levels: ["none", "high"] },
      {
        id: "b",
        supported_reasoning_levels: [{ effort: "none" }, { effort: "low" }],
      },
      { id: "c", reasoning: true, reasoning_levels: ["high", "max"] },
    ]);
    expect(models).toEqual([
      {
        id: "a",
        reasoning: true,
        reasoningEfforts: ["high"],
        thinkingMode: "both",
      },
      {
        id: "b",
        reasoning: true,
        reasoningEfforts: ["low"],
        thinkingMode: "both",
      },
      { id: "c", reasoning: true, reasoningEfforts: ["high", "max"] },
    ]);
  });

  it("leaves out level names eta has none for", async () => {
    const { models } = await list([
      { id: "a", reasoning: true, reasoning_levels: ["off", "turbo", "low"] },
    ]);
    expect(models).toEqual([
      { id: "a", reasoning: true, reasoningEfforts: ["low"] },
    ]);
  });

  it("writes nothing when the entry says nothing about reasoning", async () => {
    const { models } = await list([
      { id: "a" },
      { id: "c", reasoning_levels: "high", supported_reasoning_levels: [] },
    ]);
    expect(models).toEqual([{ id: "a" }, { id: "c" }]);
  });

  it("keeps a reasoning: false said outright", async () => {
    const { models } = await list([
      { id: "b", reasoning: false, supported_parameters: ["tools"] },
    ]);
    expect(models).toEqual([{ id: "b", reasoning: false }]);
  });
});

describe("window and output limit declared by the endpoint's /models", () => {
  it("reads the common spellings of the context length", async () => {
    const { models } = await list([
      { id: "a", context_length: 1001 },
      { id: "b", max_context_length: 1002 },
      { id: "c", max_model_len: 1003 },
      { id: "d", top_provider: { context_length: 1004 } },
      { id: "e", inputTokenLimit: 1005 },
      { id: "f", context_window: 1006 },
    ]);
    expect(models.map((model) => model.contextWindow)).toEqual([
      1001, 1002, 1003, 1004, 1005, 1006,
    ]);
  });

  it("reads the common spellings of the output limit", async () => {
    const { models } = await list([
      { id: "a", max_output_tokens: 501 },
      { id: "b", top_provider: { max_completion_tokens: 502 } },
      { id: "c", outputTokenLimit: 503 },
      { id: "d", max_tokens: 504 },
    ]);
    expect(models.map((model) => model.maxTokens)).toEqual([
      501, 502, 503, 504,
    ]);
  });

  it("ignores values that are not positive integers", async () => {
    const { models } = await list([
      { id: "a", context_length: "1000", max_output_tokens: -1 },
    ]);
    expect(models).toEqual([{ id: "a" }]);
  });

  it("takes the endpoint's number over models.dev's", async () => {
    const { models } = await list([
      { id: "gateway/model-a-full", context_length: 32000 },
    ]);
    expect(models[0]).toMatchObject({
      contextWindow: 32000,
      maxTokens: 64000,
    });
  });
});

describe("input from models.dev for a custom endpoint", () => {
  it("fills window, output limit, input and reasoning from a gateway-prefixed id", async () => {
    const { models } = await list([{ id: "gateway/model-a-full" }]);
    expect(models).toEqual([
      {
        id: "gateway/model-a-full",
        contextWindow: 200000,
        maxTokens: 64000,
        input: ["text", "image"],
        reasoning: true,
        reasoningEfforts: ["low", "high"],
      },
    ]);
  });

  it("fills a field when every listing agrees, and leaves out the one they dispute", async () => {
    const { models } = await list([
      { id: "gw/agreed-model" },
      { id: "gw/disputed-model" },
    ]);
    expect(models).toEqual([
      { id: "gw/agreed-model", contextWindow: 128000, maxTokens: 8000 },
      { id: "gw/disputed-model", maxTokens: 8000 },
    ]);
  });

  it("looks a gateway-prefixed id up by its last segment", async () => {
    const { models } = await list([
      { id: "gateway/model-a" },
      { id: "vendor/text-only" },
      { id: "model-a" },
    ]);
    expect(models).toEqual([
      { id: "gateway/model-a", input: ["text", "image"] },
      { id: "vendor/text-only", input: ["text"] },
      { id: "model-a", input: ["text", "image"] },
    ]);
  });

  it("writes no input for a model nothing knows, or one the catalog lists without inputs", async () => {
    const { models } = await list([
      { id: "gateway/unknown-model" },
      { id: "no-modalities" },
      { id: "capabilities-without-vision", capabilities: { vision: false } },
    ]);
    for (const model of models) expect(model).not.toHaveProperty("input");
  });

  it("is a supplement: an unreachable catalog leaves the list as it was", async () => {
    const send = (async (input: Parameters<typeof fetch>[0]) =>
      String(input) === MODELS_DEV_URL
        ? new Response(null, { status: 500 })
        : Response.json({
            data: [{ id: "gateway/model-a" }],
          })) as unknown as typeof fetch;
    const result = await listProviderModels({
      reference: { kind: "openai-responses", baseUrl: BASE },
      fetch: send,
    });
    expect(result.models).toEqual([{ id: "gateway/model-a" }]);
  });
});

describe("a refresh and what the user already chose", () => {
  const roots: string[] = [];
  afterEach(async () => {
    for (const root of roots.splice(0))
      await rm(root, { recursive: true, force: true });
  });

  it("keeps the user's input and overrides.input over what discovery found", async () => {
    const root = await mkdtemp(join(tmpdir(), "eta-input-"));
    roots.push(root);
    const path = join(root, "config.json");
    const store = new ProviderConfigStore({ path });
    const mine = [
      {
        id: "kept",
        input: ["text" as const],
        contextWindow: 4096,
        maxTokens: 512,
        reasoning: false,
      },
      {
        id: "overridden",
        overrides: { input: ["text" as const], contextWindow: 1234 },
      },
      { id: "bare" },
    ];
    await store.save({
      revision: revisionOf(""),
      provider: {
        id: "custom",
        kind: "openai-responses",
        baseUrl: BASE,
        models: mine,
      },
    });
    const { models } = await list([
      {
        id: "kept",
        input_modalities: ["text", "image"],
        context_length: 99999,
        max_output_tokens: 9999,
      },
      { id: "overridden", input_modalities: ["text", "image"] },
      { id: "bare", input_modalities: ["text", "image"] },
    ]);
    await store.updateModels("custom", models, "now", { delist: false });
    const saved = JSON.parse(await readFile(path, "utf8")).providers[0].models;
    expect(saved).toEqual([
      {
        id: "kept",
        input: ["text"],
        contextWindow: 4096,
        maxTokens: 512,
        reasoning: false,
      },
      {
        id: "overridden",
        input: ["text", "image"],
        overrides: { input: ["text"], contextWindow: 1234 },
      },
      { id: "bare", input: ["text", "image"] },
    ]);
  });
});
