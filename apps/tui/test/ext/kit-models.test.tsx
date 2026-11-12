/**
 * The model list a picker shows: the configured providers' models and the gateway's, which of
 * them can be used, and which one is the default. The rules are the web page's
 * (`apps/web/src/queries/providers.ts`); `useModels` is checked against a real host.
 */
import type {
  LlmAccounts,
  LlmModel,
  ProviderSummary,
  ProvidersView,
} from "@eta/client-contracts";
import type { Model } from "../../src/ext/kit/models";
import { describe, expect, it } from "vitest";
import { buildModels, keyMissing } from "../../src/ext/kit/models";

function provider(
  fields: Partial<ProviderSummary> & Pick<ProviderSummary, "id" | "kind">,
): ProviderSummary {
  return {
    baseUrl: "https://example.test",
    hasApiKey: false,
    models: [{ id: "m1" }],
    ...fields,
  };
}

function view(
  providers: ProviderSummary[],
  defaultModel?: string,
): ProvidersView {
  return {
    providers,
    revision: "r1",
    ...(defaultModel === undefined ? {} : { defaultModel }),
  };
}

function gatewayModel(
  fields: Partial<LlmModel> & Pick<LlmModel, "id">,
): LlmModel {
  return {
    connector: "codex",
    name: fields.id,
    status: "available",
    available: true,
    ...fields,
  };
}

const ACCOUNTS: LlmAccounts = {
  ready: true,
  connectors: [
    { id: "codex", name: "Codex", flow: "oauth_device" },
    { id: "xai", name: "Grok", flow: "oauth_device" },
  ],
  connections: [],
};

const ids = (models: Model[] | undefined) => models?.map((m) => m.id);
const defaults = (models: Model[] | undefined) =>
  models?.filter((m) => m.default).map((m) => m.id);

describe("providerLabel and keyMissing", () => {
  it.each([
    ["deepseek", false, true],
    ["deepseek", true, false],
    ["kimi-coding", false, true],
    ["zai", false, true],
    ["zai-coding-cn", false, true],
    ["openai-codex", false, false],
    ["openai-compatible", false, false],
    ["openai-responses", false, false],
  ] as const)("%s with key %s: missing %s", (kind, hasApiKey, missing) => {
    expect(keyMissing({ kind, hasApiKey })).toBe(missing);
  });
});

describe("buildModels", () => {
  it("is undefined until the providers' config has come", () => {
    expect(
      buildModels({ providers: undefined, llm: undefined, locale: "en" }),
    ).toBeUndefined();
    expect(
      buildModels({
        providers: undefined,
        llm: { accounts: ACCOUNTS, models: [gatewayModel({ id: "g" })] },
        locale: "en",
      }),
    ).toBeUndefined();
  });

  it.each([
    ["the configured default", "b:m1", "b:m1"],
    ["the first when the default is gone", "zz:gone", "a:m1"],
    ["the first when none is set", undefined, "a:m1"],
  ] as const)("the default is %s", (_what, defaultModel, expected) => {
    const models = buildModels({
      providers: view(
        [
          provider({ id: "a", kind: "openai-compatible" }),
          provider({ id: "b", kind: "openai-compatible" }),
        ],
        defaultModel,
      ),
      llm: undefined,
      locale: "en",
    });
    expect(defaults(models)).toEqual([expected]);
  });

  it("appends the gateway's models as llm:<id> under their connector's name", () => {
    const models = buildModels({
      providers: view([provider({ id: "a", kind: "openai-compatible" })]),
      llm: {
        accounts: ACCOUNTS,
        models: [
          gatewayModel({ id: "gpt-5", name: "GPT-5", contextWindow: 400_000 }),
          gatewayModel({ id: "grok-4", connector: "xai" }),
          gatewayModel({ id: "odd", connector: "unknown-connector" }),
        ],
      },
      locale: "en",
    });
    expect(ids(models)).toEqual(["a:m1", "llm:gpt-5", "llm:grok-4", "llm:odd"]);
    expect(models?.[1]).toMatchObject({
      provider: "llm",
      providerName: "Codex",
      name: "GPT-5",
      contextWindow: 400_000,
      available: true,
    });
    expect(models?.[2]?.providerName).toBe("Grok");
    expect(models?.[3]?.providerName).toBe("unknown-connector");
  });

  it("takes a gateway model's availability and reason from the gateway, in the user's language", () => {
    const llm = {
      accounts: ACCOUNTS,
      models: [
        gatewayModel({ id: "degraded", status: "degraded", available: true }),
        gatewayModel({
          id: "down",
          status: "unavailable",
          available: false,
          reason: { code: "quota_exhausted", message: "diag" },
        }),
      ],
    };
    const en = buildModels({ providers: view([]), llm, locale: "en" });
    expect(en?.map((m) => [m.id, m.available])).toEqual([
      ["llm:degraded", true],
      ["llm:down", false],
    ]);
    expect(en?.[0]?.unavailableReason).toBeUndefined();
    expect(en?.[1]?.unavailableReason).toBe(
      "The quota is used up. The account resumes automatically once it recovers.",
    );
    const zh = buildModels({ providers: view([]), llm, locale: "zh" });
    expect(zh?.[1]?.unavailableReason).toBe(
      "额度已用尽，恢复后会自动继续使用。",
    );
  });

  it("makes a gateway model the default when the config names it, else keeps the first", () => {
    const llm = { accounts: ACCOUNTS, models: [gatewayModel({ id: "gpt-5" })] };
    const named = buildModels({
      providers: view(
        [provider({ id: "a", kind: "openai-compatible" })],
        "llm:gpt-5",
      ),
      llm,
      locale: "en",
    });
    expect(defaults(named)).toEqual(["llm:gpt-5"]);
    const onlyGateway = buildModels({
      providers: view([]),
      llm,
      locale: "en",
    });
    expect(defaults(onlyGateway)).toEqual(["llm:gpt-5"]);
  });
});
