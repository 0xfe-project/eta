import type { ProviderSummary, ProvidersView } from "@eta/client-contracts";
import { describe, expect, it } from "@rstest/core";
import { WireError } from "@/lib/wire";
import {
  keyMissing,
  modelAvailability,
  modelGroups,
  modelsOf,
  providerErrorMessage,
  providerLabel,
} from "./providers";

const provider = (
  extra: Partial<ProviderSummary> & { id: string },
): ProviderSummary => ({
  kind: "openai-compatible",
  baseUrl: "https://example.com/v1",
  hasApiKey: true,
  models: [{ id: "m1", name: "One" }, { id: "m2" }],
  ...extra,
});

const view = (
  providers: ProviderSummary[],
  extra: object = {},
): ProvidersView => ({
  revision: "r1",
  providers,
  ...extra,
});

describe("what a provider is called", () => {
  it("prefers its own name, then its kind's, then its id", () => {
    expect(providerLabel({ id: "a", kind: "deepseek", name: "公司" })).toBe(
      "公司",
    );
    expect(providerLabel({ id: "a", kind: "deepseek" })).toBe("DeepSeek");
    expect(providerLabel({ id: "mine", kind: "openai-compatible" })).toBe(
      "mine",
    );
  });
});

describe("a missing key", () => {
  it("matters for the kinds that cannot run without one", () => {
    expect(keyMissing({ kind: "deepseek", hasApiKey: false })).toBe(true);
    expect(keyMissing({ kind: "deepseek", hasApiKey: true })).toBe(false);
  });

  it("claims nothing for custom endpoints, which may be open, or for Codex, which signs in", () => {
    expect(keyMissing({ kind: "openai-compatible", hasApiKey: false })).toBe(
      false,
    );
    expect(keyMissing({ kind: "openai-responses", hasApiKey: false })).toBe(
      false,
    );
    expect(keyMissing({ kind: "openai-codex", hasApiKey: false })).toBe(false);
  });
});

describe("the models a picker lists", () => {
  it("name each model by its provider, as an agent does", () => {
    const models = modelsOf(view([provider({ id: "local", name: "Local" })]));
    expect(
      models.map((m) => [m.id, m.provider, m.providerName, m.name]),
    ).toEqual([
      ["local:m1", "local", "Local", "One"],
      ["local:m2", "local", "Local", "m2"],
    ]);
  });

  it("start new chats on the configured default, else the first model", () => {
    const providers = [provider({ id: "a" }), provider({ id: "b" })];
    expect(
      modelsOf(view(providers, { defaultModel: "b:m2" }))
        .filter((m) => m.default)
        .map((m) => m.id),
    ).toEqual(["b:m2"]);
    expect(
      modelsOf(view(providers))
        .filter((m) => m.default)
        .map((m) => m.id),
    ).toEqual(["a:m1"]);
    // A default that no longer exists is not one.
    expect(
      modelsOf(view(providers, { defaultModel: "gone:x" }))
        .filter((m) => m.default)
        .map((m) => m.id),
    ).toEqual(["a:m1"]);
  });

  it("are not available while their provider lacks a key it needs", () => {
    const models = modelsOf(
      view([
        provider({ id: "ds", kind: "deepseek", hasApiKey: false }),
        provider({ id: "open", hasApiKey: false }),
      ]),
    );
    expect(models.map((m) => [m.id, m.available])).toEqual([
      ["ds:m1", false],
      ["ds:m2", false],
      ["open:m1", true],
      ["open:m2", true],
    ]);
  });

  it("are grouped by provider, in the config's order", () => {
    const groups = modelGroups(
      modelsOf(view([provider({ id: "a", name: "A" }), provider({ id: "b" })])),
    );
    expect(groups.map((g) => [g.provider, g.label, g.models.length])).toEqual([
      ["a", "A", 2],
      ["b", "b", 2],
    ]);
  });
});

describe("whether an agent can chat with its model", () => {
  const models = modelsOf(
    view([provider({ id: "ds", kind: "deepseek", hasApiKey: false })]),
  );
  const open = modelsOf(view([provider({ id: "local" })]));

  it("blocks a model whose provider needs a key, saying why", () => {
    expect(modelAvailability({ model: "ds:m1" }, models)).toMatchObject({
      state: "unavailable",
      message: "One 暂不可用：DeepSeek 还没有 API key",
    });
  });

  it("lets a usable model through", () => {
    expect(modelAvailability({ model: "local:m1" }, open).state).toBe("ok");
  });

  it("says when the model is gone or was never chosen", () => {
    expect(modelAvailability({ model: "local:old" }, open)).toMatchObject({
      state: "unavailable",
      message: "local:old 已不存在，请更换模型。",
    });
    expect(modelAvailability({ model: null }, open).state).toBe("not_set");
  });

  it("does not block on a config it could not read", () => {
    expect(modelAvailability({ model: "ds:m1" }, models, true).state).toBe(
      "ok",
    );
    expect(modelAvailability({ model: "ds:m1" }, undefined).state).toBe("ok");
    expect(modelAvailability({ model: "ds:m1" }, []).state).toBe("unavailable");
  });
});

describe("what a failed write says", () => {
  it("tells the host's refusals in words, and passes the rest on", () => {
    expect(
      providerErrorMessage(new WireError("server", "config_changed")),
    ).toContain("已重新读取");
    expect(
      providerErrorMessage(new WireError("server", "no such provider: x")),
    ).toBe("no such provider: x");
  });

  it("tells a lost connection and a silent host apart", () => {
    expect(providerErrorMessage(new WireError("disconnected", "x"))).toBe(
      "与宿主的连接已断开。",
    );
    expect(providerErrorMessage(new WireError("timeout", "x"))).toBe(
      "宿主没有及时回应。",
    );
  });
});
