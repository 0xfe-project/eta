/**
 * A new kind of model source is one entry in `MODEL_SOURCES` and nothing else.
 *
 * The entry below is the only thing this file adds; it goes in before any server module is
 * loaded, the way a checked-in entry would. Every step a real source goes through (listing its
 * models with a key, models.dev's facts for its official endpoint, the listed models' tested
 * capabilities, building it with its transport settings, the check, what a client calls it) has
 * to work from that entry alone. If one of them needs a table of its own again, this fails.
 */
import type { ModelSource, ProviderKind } from "@eta/client-contracts";
import {
  keyMissing,
  MODEL_SOURCES,
  providerLabel,
} from "@eta/client-contracts";
import { afterAll, describe, expect, it, vi } from "vitest";

const ACME: ModelSource = {
  name: "Acme Models",
  baseUrl: "https://api.acme.test/v1",
  keysUrl: "https://acme.test/keys",
  auth: "key",
  models: "endpoint",
  modelsDev: "acme",
  compat: { supportsStore: false, maxTokensField: "max_tokens" },
  noThinkingOff: true,
  listed: [
    {
      id: "acme-1",
      name: "Acme One",
      contextWindow: 400_000,
      reasoning: true,
      thinkingMode: "both",
      reasoningEfforts: ["low", "high"],
    },
  ],
};
const sources = MODEL_SOURCES as Record<string, ModelSource>;
sources.acme = ACME;
afterAll(() => {
  delete sources.acme;
});

const kind = "acme" as ProviderKind;
const reference = { kind, baseUrl: ACME.baseUrl! };

const { listProviderModels, checkConnection } = await import(
  "../src/providers/discovery"
);
const { buildProvider } = await import("../src/providers/runtime");

/** Its own `/models` behind the key, and a models.dev that lists it. */
const send = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
  if (String(url) === "https://models.dev/api.json")
    return Response.json({
      acme: {
        id: "acme",
        models: {
          "acme-2": {
            id: "acme-2",
            name: "Acme Two",
            limit: { context: 128_000, output: 8_000 },
          },
        },
      },
    });
  expect(String(url)).toBe(`${ACME.baseUrl}/models`);
  if (new Headers(init?.headers).get("authorization") !== "Bearer sk-acme")
    return Response.json({ error: "unauthorized" }, { status: 401 });
  return Response.json({ data: [{ id: "acme-1" }, { id: "acme-2" }] });
});

describe("a kind of source that is only an entry in MODEL_SOURCES", () => {
  it("lists its models with the key, with its listed facts and models.dev's", async () => {
    const found = await listProviderModels({
      reference,
      apiKey: "sk-acme",
      fetch: send,
    });
    expect(found.failure).toBeUndefined();
    expect(found.models).toEqual([
      expect.objectContaining({
        id: "acme-1",
        name: "Acme One",
        contextWindow: 400_000,
      }),
      expect.objectContaining({
        id: "acme-2",
        name: "Acme Two",
        contextWindow: 128_000,
      }),
    ]);
  });

  it("is checked against its own endpoint, and a refused key says so", async () => {
    expect(
      await checkConnection({ reference, apiKey: "wrong", fetch: send }),
    ).toEqual({ state: "invalid_key", error: "discovery_http_401" });
    expect(
      await checkConnection({ reference, apiKey: "sk-acme", fetch: send }),
    ).toEqual({ state: "ok" });
  });

  it("builds with its own transport settings and thinking levels", async () => {
    const provider = await buildProvider({
      id: "acme",
      kind,
      baseUrl: ACME.baseUrl!,
      apiKey: "sk-acme",
      models: [ACME.listed![0]!],
    });
    const [model] = provider.getModels();
    expect(model).toMatchObject({
      id: "acme-1",
      api: "openai-completions",
      baseUrl: ACME.baseUrl,
      compat: {
        supportsStore: false,
        maxTokensField: "max_tokens",
        supportsStrictMode: false,
      },
      // No off switch: the definition says its models have none.
      thinkingLevelMap: expect.objectContaining({ off: null, low: "low" }),
    });
  });

  it("is named and asked for a key by every client", () => {
    expect(providerLabel({ id: "acme-work", kind })).toBe("Acme Models");
    expect(keyMissing({ kind, hasApiKey: false })).toBe(true);
  });
});
