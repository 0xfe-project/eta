/**
 * OpenCode Zen and OpenCode Go: providers whose model list is their models.dev entry.
 *
 * `fixtures/models-dev-opencode.json` is the `opencode` and `opencode-go` entries of
 * https://models.dev/api.json as of 2026-11-13, trimmed to the fields eta reads. The counts
 * below are that day's: 139 Zen models (67 Chat Completions, 35 Responses, 25 Anthropic,
 * 11 Gemini, 1 Mistral) and 40 Go models (26, 6, 6, 2, 0).
 */
import type {
  ProviderCheck,
  ProviderCheckResult,
  ProviderDiscoverResult,
  ProviderRefreshResult,
  ProvidersView,
} from "@eta/client-contracts";
import type { StateSnapshot } from "@eta/client-wire-proto";
import type { EtaModelConfig } from "../src/providers/config-types";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUILTIN_PROVIDER_PRESETS } from "@eta/client-contracts";
import { Context } from "cordis";
import { afterEach, describe, expect, it, vi } from "vitest";
import { providersPlugin } from "../src/bundled/providers";
import { providerDefinitionForKind } from "../src/providers/catalog";
import { providerSummary } from "../src/providers/config-types";
import { discoverModels } from "../src/providers/discovery";
import {
  MODELS_DEV_URL,
  parseModelsDevModel,
  publicModelMetadata,
} from "../src/providers/metadata";
import {
  buildModels,
  buildProvider,
  withSessionHeader,
} from "../src/providers/runtime";
import { ProviderConfigStore } from "../src/providers/store";
import { WireService } from "../src/wire-service";
import snapshot from "./fixtures/models-dev-opencode.json";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

type Catalog = Record<
  string,
  { id: string; models: Record<string, Record<string, unknown>> }
>;
const clone = (): Catalog => structuredClone(snapshot) as unknown as Catalog;

function serving(body: unknown) {
  return vi
    .fn<typeof fetch>()
    .mockImplementation(async () => Response.json(body));
}

const ZEN = {
  kind: "opencode" as const,
  baseUrl: BUILTIN_PROVIDER_PRESETS.opencode.baseUrl,
};
const GO = {
  kind: "opencode-go" as const,
  baseUrl: BUILTIN_PROVIDER_PRESETS["opencode-go"].baseUrl,
};

function count<T>(items: readonly T[], key: (item: T) => string) {
  const counts: Record<string, number> = {};
  for (const item of items) counts[key(item)] = (counts[key(item)] ?? 0) + 1;
  return counts;
}

describe("parsing a models.dev model", () => {
  const provider = {
    npm: "@ai-sdk/openai-compatible",
    api: "https://opencode.ai/inference/openai/v1",
  };

  it("reads limits, inputs, reasoning levels and the off switch", () => {
    expect(
      parseModelsDevModel(
        "gpt-6-luna",
        snapshot["opencode-go"].models["gpt-6-luna"],
        provider,
      ),
    ).toEqual({
      id: "gpt-6-luna",
      name: "GPT-6 Luna",
      contextWindow: 1_050_000,
      maxTokens: 128_000,
      // pdf is not an input eta can send; text and image are kept.
      input: ["text", "image"],
      reasoning: true,
      // "none" among the efforts is the off switch.
      thinkingMode: "both",
      reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
      npm: "@ai-sdk/openai",
      api: "https://opencode.ai/inference/go/openai/v1",
    });
  });

  it("names no level for a toggle or a token budget, and falls back to the provider's protocol", () => {
    expect(
      parseModelsDevModel(
        "longcat-2.0",
        snapshot["opencode-go"].models["longcat-2.0"],
        provider,
      ),
    ).toMatchObject({
      reasoning: true,
      reasoningEfforts: [],
      npm: "@ai-sdk/openai-compatible",
      api: "https://opencode.ai/inference/go/openai/v1",
    });
    expect(
      parseModelsDevModel("x", { id: "x", reasoning: false }, provider),
    ).toEqual({ id: "x", reasoning: false, ...provider });
  });

  it("marks deprecated models", () => {
    expect(
      parseModelsDevModel(
        "cat-jam-free",
        snapshot["opencode-go"].models["cat-jam-free"],
        provider,
      ).deprecated,
    ).toBe(true);
  });

  it.each([
    [{ id: "other" }, "model id"],
    [{ id: "x", name: "" }, "name"],
    [{ id: "x", limit: { context: 0 } }, "context limit"],
    [{ id: "x", limit: { context: 10, output: 11 } }, "output limit"],
    [{ id: "x", modalities: { input: "text" } }, "input modalities"],
    [{ id: "x", reasoning: "yes" }, "reasoning"],
    [
      { id: "x", reasoning: true, reasoning_options: [{ type: "effort" }] },
      "reasoning options",
    ],
    [{ id: "x", provider: { npm: 3 } }, "npm"],
  ])("refuses a malformed entry %j", (entry, field) => {
    expect(() => parseModelsDevModel("x", entry, provider)).toThrow(
      `Invalid public model metadata: ${field}`,
    );
  });
});

describe("the OpenCode presets", () => {
  it("point at the OpenAI endpoint models.dev lists for each gateway", () => {
    for (const [reference, id] of [
      [ZEN, "opencode"],
      [GO, "opencode-go"],
    ] as const) {
      expect(reference.baseUrl).toBe(
        (snapshot as unknown as Catalog & Record<string, { api: string }>)[id]!
          .api,
      );
      const definition = providerDefinitionForKind(reference.kind);
      expect(definition?.discovery).toEqual({
        adapter: "models-dev",
        provider: id,
        requireContextWindow: false,
      });
      expect(definition?.auth.required).toBe(true);
    }
  });

  it("are summarised under the preset kind and need a key", () => {
    expect(
      providerSummary({ id: "opencode-zen", ...ZEN, models: [] }),
    ).toMatchObject({ kind: "opencode", hasApiKey: false });
  });
});

describe("discovering OpenCode models from models.dev", () => {
  it("sorts every Zen model by protocol, without a key or the user's headers", async () => {
    const send = serving(snapshot);
    const found = await discoverModels({
      reference: ZEN,
      apiKey: "sk-secret",
      headers: { "X-Mine": "private" },
      fetch: send,
    });
    expect(found.error).toBeUndefined();
    expect(count(found.models, (model) => model.api!)).toEqual({
      "openai-completions": 67,
      "openai-responses": 35,
    });
    expect(count(found.unsupported!, (model) => model.protocol)).toEqual({
      "@ai-sdk/anthropic": 25,
      "@ai-sdk/google": 11,
      "@ai-sdk/mistral": 1,
    });
    expect(
      found.unsupported!.every((model) => model.reason === "protocol"),
    ).toBe(true);
    // Nothing goes missing: every listed model is either offered or explained.
    expect(found.models.length + found.unsupported!.length).toBe(
      Object.keys(snapshot.opencode.models).length,
    );
    expect(send).toHaveBeenCalledExactlyOnceWith(MODELS_DEV_URL, {
      headers: { Accept: "application/json" },
      credentials: "omit",
      redirect: "error",
      signal: expect.any(AbortSignal),
    });
  });

  it("sorts the Go models the same way", async () => {
    const found = await discoverModels({
      reference: GO,
      fetch: serving(snapshot),
    });
    expect(count(found.models, (model) => model.api!)).toEqual({
      "openai-completions": 26,
      "openai-responses": 6,
    });
    expect(count(found.unsupported!, (model) => model.protocol)).toEqual({
      "@ai-sdk/anthropic": 6,
      "@ai-sdk/google": 2,
    });
    expect(found.models.filter((model) => !model.deprecated)).toHaveLength(26);
    expect(
      found.models.find((model) => model.id === "deepseek-v4-pro"),
    ).toEqual({
      id: "deepseek-v4-pro",
      name: "DeepSeek V4 Pro",
      contextWindow: 1_000_000,
      maxTokens: 384_000,
      input: ["text"],
      reasoning: true,
      reasoningEfforts: ["high", "max"],
      api: "openai-completions",
    });
  });

  it("does not send the key to an endpoint the gateway's base URL is not", async () => {
    const body = clone();
    body.opencode!.models["gpt-6-astra"]!.provider = {
      npm: "@ai-sdk/openai",
      api: "https://elsewhere.example/v1",
    };
    const found = await discoverModels({
      reference: ZEN,
      fetch: serving(body),
    });
    expect(found.models.some((model) => model.id === "gpt-6-astra")).toBe(
      false,
    );
    expect(
      found.unsupported!.find((model) => model.id === "gpt-6-astra"),
    ).toMatchObject({ reason: "endpoint", protocol: "@ai-sdk/openai" });
  });

  it("lists a malformed model as unusable instead of failing the whole list", async () => {
    const body = clone();
    body.opencode!.models["gpt-6-astra"]!.limit = { context: -1 };
    const found = await discoverModels({
      reference: ZEN,
      fetch: serving(body),
    });
    expect(found.models).toHaveLength(101);
    expect(
      found.unsupported!.find((model) => model.id === "gpt-6-astra"),
    ).toMatchObject({ reason: "invalid" });
  });

  it("reports an unreachable or broken catalog rather than an empty list", async () => {
    expect(
      await discoverModels({
        reference: ZEN,
        fetch: vi
          .fn<typeof fetch>()
          .mockResolvedValue(new Response("", { status: 503 })),
      }),
    ).toMatchObject({ models: [], failure: "http", status: 503 });
    expect(
      await discoverModels({
        reference: ZEN,
        fetch: vi.fn<typeof fetch>().mockRejectedValue(new Error("offline")),
      }),
    ).toMatchObject({ models: [], failure: "network", error: "offline" });
    expect(
      await discoverModels({ reference: ZEN, fetch: serving({}) }),
    ).toMatchObject({ models: [], failure: "response" });
  });

  it("is the same parse the metadata lookup uses", async () => {
    expect(
      await publicModelMetadata(
        { ...GO, modelIds: ["kimi-k3"] },
        serving(snapshot),
      ),
    ).toEqual({
      models: [
        {
          id: "kimi-k3",
          name: "Kimi K3",
          contextWindow: 1_048_576,
          input: ["text", "image"],
        },
      ],
    });
  });
});

describe("running OpenCode models", () => {
  it("dispatches each model over its own protocol, with the gateway's transport settings", async () => {
    const found = await discoverModels({
      reference: GO,
      fetch: serving(snapshot),
    });
    const pick = (id: string) => found.models.find((model) => model.id === id)!;
    const provider = await buildProvider({
      id: "opencode-go",
      ...GO,
      apiKey: "sk-test",
      models: [
        pick("deepseek-v4-pro"),
        pick("gpt-6-luna"),
        pick("kimi-k3.1-pro"),
      ],
    });
    const models = provider.getModels();
    expect(models.map((model) => [model.id, model.api, model.baseUrl])).toEqual(
      [
        ["deepseek-v4-pro", "openai-completions", GO.baseUrl],
        ["gpt-6-luna", "openai-responses", GO.baseUrl],
        ["kimi-k3.1-pro", "openai-completions", GO.baseUrl],
      ],
    );
    // DeepSeek behind the gateway still needs its own thinking format, which pi-ai knows.
    expect(models[0]?.compat).toMatchObject({
      thinkingFormat: "deepseek",
      requiresReasoningContentOnAssistantMessages: true,
      supportsStrictMode: false,
    });
    // A model pi-ai does not know yet gets the gateway's common settings.
    expect(models[2]?.compat).toEqual({
      supportsStore: false,
      supportsDeveloperRole: false,
      maxTokensField: "max_tokens",
      supportsStrictMode: false,
    });
    expect(models[1]?.thinkingLevelMap).toMatchObject({
      off: "none",
      high: "high",
      minimal: null,
    });
  });

  it("keeps a single-protocol provider's models on its kind's protocol", async () => {
    const provider = await buildProvider({
      id: "custom",
      kind: "openai-responses",
      baseUrl: "http://127.0.0.1:1/v1",
      models: [{ id: "m" }],
    });
    expect(provider.getModels()[0]?.api).toBe("openai-responses");
  });
});

describe("openCode's session header", () => {
  // OpenCode answers 400 MissingSessionID to a request without `x-opencode-session` (seen
  // against the real gateway on 2026-11-13), so every request of a session carries its id.
  it("goes out on both protocols for an OpenCode model, and not for anyone else", async () => {
    const seen: {
      path: string;
      session: string | null;
      authorization: string | null;
    }[] = [];
    const endpoint = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        seen.push({
          path: new URL(request.url).pathname,
          session: request.headers.get("x-opencode-session"),
          authorization: request.headers.get("authorization"),
        });
        return Response.json(
          {
            type: "error",
            error: { type: "authentication_error", message: "stop" },
          },
          { status: 401 },
        );
      },
    });
    try {
      const baseUrl = `http://127.0.0.1:${endpoint.port}/v1`;
      const { models } = await buildModels([
        {
          id: "go",
          kind: "opencode-go",
          baseUrl,
          apiKey: "sk-go",
          models: [
            { id: "kimi-k3", api: "openai-completions" },
            { id: "gpt-6-luna", api: "openai-responses" },
          ],
        },
        {
          id: "plain",
          kind: "openai-compatible",
          baseUrl,
          models: [{ id: "m1" }],
        },
      ]);
      const session = withSessionHeader(models!, "session-123");
      const context = {
        messages: [{ role: "user" as const, content: "hello", timestamp: 0 }],
      };
      for (const [provider, id] of [
        ["go", "kimi-k3"],
        ["go", "gpt-6-luna"],
        ["plain", "m1"],
      ] as const)
        await session.completeSimple(session.getModel(provider, id)!, context);
      expect(seen).toEqual([
        {
          path: "/v1/chat/completions",
          session: "session-123",
          authorization: "Bearer sk-go",
        },
        {
          path: "/v1/responses",
          session: "session-123",
          authorization: "Bearer sk-go",
        },
        {
          path: "/v1/chat/completions",
          session: null,
          authorization: expect.any(String),
        },
      ]);
    } finally {
      await endpoint.stop(true);
    }
  });
});

async function plugin(send: typeof fetch) {
  const root = await mkdtemp(join(tmpdir(), "eta-models-dev-"));
  roots.push(root);
  const ctx = new Context();
  const wire = new WireService(ctx);
  wire.attachSink(() => undefined);
  const store = new ProviderConfigStore({ path: join(root, "config.json") });
  await ctx.plugin(
    providersPlugin({ store, fetch: send }) as never,
    undefined as never,
  );
  const call = async <T>(action: string, args?: unknown) =>
    (
      (await wire.dispatch({ op: "call", target: "providers", action, args }, {
        reply: () => undefined,
      } as never)) as { result: T }
    ).result;
  const config = () =>
    (wire.snapshot("providers") as StateSnapshot | undefined)?.sections
      .config as ProvidersView | undefined;
  const checks = () =>
    ((wire.snapshot("providers") as StateSnapshot | undefined)?.sections
      .checks ?? {}) as Record<string, ProviderCheck>;
  const started = Date.now();
  while (config() === undefined) {
    if (Date.now() - started > 2_000) throw new Error("no providers state");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return { store, call, config, checks };
}

describe("an OpenCode provider over the wire", () => {
  it("offers the usable models and explains the rest, then follows models.dev on refresh", async () => {
    let body = clone();
    const send = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => Response.json(body));
    const h = await plugin(send);

    const preview = await h.call<ProviderDiscoverResult>("discover", GO);
    expect(preview.models).toHaveLength(32);
    expect(preview.unsupported).toHaveLength(8);

    // What the editor saves by default: the usable models that are not deprecated.
    const chosen = preview.models.filter((model) => !model.deprecated);
    const mine: EtaModelConfig = {
      ...chosen.find((model) => model.id === "kimi-k3")!,
      defaultThinking: "max",
    };
    await h.call("save", {
      revision: h.config()!.revision,
      provider: {
        id: "opencode-go",
        name: "OpenCode Go",
        ...GO,
        apiKey: "sk-test",
        models: chosen.map((model) => (model.id === "kimi-k3" ? mine : model)),
      },
    });
    expect(h.config()?.providers[0]).toMatchObject({
      kind: "opencode-go",
      hasApiKey: true,
    });
    expect(h.config()?.providers[0]?.models).toHaveLength(26);

    // models.dev adds a model, drops one, deprecates one and renames one.
    body = clone();
    const go = body["opencode-go"]!.models;
    go["kimi-k4"] = { ...go["kimi-k3"], id: "kimi-k4", name: "Kimi K4" };
    go["kimi-k3"] = { ...go["kimi-k3"], name: "Kimi K3 (2026)" };
    delete go["glm-5.2"];
    go.hy3 = { ...go.hy3, status: "deprecated" };
    go["old-free"] = {
      ...go["kimi-k3"],
      id: "old-free",
      status: "deprecated",
    };

    const refreshed = await h.call<ProviderRefreshResult>("refresh", {
      id: "opencode-go",
    });
    // The list comes back whole, to be offered; turning a new model on is the person's.
    expect(refreshed.models.map((model) => model.id)).toContain("kimi-k4");
    expect(refreshed.unsupported).toHaveLength(8);
    expect(refreshed.delisted).toEqual(["glm-5.2"]);
    const models = h.config()!.providers[0]!.models;
    expect(models.map((model) => model.id)).not.toContain("kimi-k4");
    expect(models.map((model) => model.id)).not.toContain("old-free");
    // Gone from models.dev: kept, and marked, so the agent using it can say so.
    expect(models.find((model) => model.id === "glm-5.2")).toMatchObject({
      delisted: true,
    });
    expect(models.find((model) => model.id === "hy3")).toMatchObject({
      deprecated: true,
    });
    // The catalog's facts move, the person's choice stays.
    expect(models.find((model) => model.id === "kimi-k3")).toMatchObject({
      name: "Kimi K3 (2026)",
      defaultThinking: "max",
    });
    // The key was never part of the catalog request; it went to the gateway's own list only.
    for (const [url, init] of send.mock.calls) {
      if (String(url) === MODELS_DEV_URL)
        expect(JSON.stringify(init?.headers)).not.toContain("sk-test");
      else expect(String(url)).toBe(`${GO.baseUrl}/models`);
    }
    expect(h.checks()["opencode-go"]).toMatchObject({ state: "ok" });

    // Listed again: the mark goes away (and the model that only existed in between is the
    // one marked now).
    body = clone();
    const again = await h.call<ProviderRefreshResult>("refresh", {
      id: "opencode-go",
    });
    expect(again.delisted).toBeUndefined();
    expect(
      h.config()!.providers[0]!.models.find((model) => model.id === "glm-5.2")
        ?.delisted,
    ).toBeUndefined();
    expect((await h.store.read()).config.providers?.[0]?.apiKey).toBe(
      "sk-test",
    );
  });
});

describe("an OpenCode key", () => {
  /** models.dev for the catalog; the gateway's own list answers by the key it is handed. */
  function gateway(good: string) {
    return vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
      if (String(url) === MODELS_DEV_URL) return Response.json(clone());
      const auth = new Headers(init?.headers).get("authorization");
      return auth === `Bearer ${good}`
        ? Response.json({ object: "list", data: [] })
        : Response.json(
            { error: { type: "authentication_error" } },
            { status: 401 },
          );
    });
  }

  it("is tried against the gateway when models are listed, so a wrong one is caught before a chat", async () => {
    const h = await plugin(gateway("sk-good"));
    await expect(
      h.call("discover", { ...ZEN, apiKey: "sk-wrong" }),
    ).rejects.toThrow("discovery_http_401");
    const listed = await h.call<ProviderDiscoverResult>("discover", {
      ...ZEN,
      apiKey: "sk-good",
    });
    expect(listed.models).toHaveLength(102);
    // Without a key there is nothing to try: the public list is still offered.
    expect(
      (await h.call<ProviderDiscoverResult>("discover", ZEN)).models,
    ).toHaveLength(102);
  });

  it("is checked on request, and the state says which providers answer", async () => {
    const h = await plugin(gateway("sk-good"));
    await h.call("save", {
      revision: h.config()!.revision,
      provider: {
        id: "zen",
        ...ZEN,
        apiKey: "sk-wrong",
        models: [{ id: "gpt-5.4", api: "openai-responses" }],
      },
    });
    const checked = await h.call<ProviderCheckResult>("check", { id: "zen" });
    expect(checked.checks.zen).toMatchObject({
      state: "invalid_key",
      error: "discovery_http_401",
    });
    expect(h.checks().zen?.state).toBe("invalid_key");
    // A refresh lists with the saved key too, and says the same.
    await expect(h.call("refresh", { id: "zen" })).rejects.toThrow(
      "discovery_http_401",
    );

    // A new key forgets the old verdict; a model toggled off does not.
    await h.call("save", {
      revision: h.config()!.revision,
      provider: {
        id: "zen",
        ...ZEN,
        apiKey: "sk-good",
        models: [{ id: "gpt-5.4", api: "openai-responses" }],
      },
    });
    expect(h.checks().zen).toBeUndefined();
    await h.call("check", {});
    expect(h.checks().zen?.state).toBe("ok");
    await h.call("save", {
      revision: h.config()!.revision,
      provider: {
        id: "zen",
        ...ZEN,
        models: [
          { id: "gpt-5.4", api: "openai-responses" },
          { id: "kimi-k3", api: "openai-completions" },
        ],
      },
    });
    expect(h.checks().zen?.state).toBe("ok");
    await h.call("delete", { revision: h.config()!.revision, id: "zen" });
    expect(h.checks().zen).toBeUndefined();
  });

  it("is not probed when there is none: the config already says it is missing", async () => {
    const send = gateway("sk-good");
    const h = await plugin(send);
    await h.call("save", {
      revision: h.config()!.revision,
      provider: { id: "go", ...GO, models: [{ id: "kimi-k3" }] },
    });
    send.mockClear();
    expect(await h.call<ProviderCheckResult>("check", {})).toEqual({
      checks: {},
    });
    expect(send).not.toHaveBeenCalled();
  });
});
