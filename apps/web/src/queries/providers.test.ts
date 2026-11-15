import type { ProviderSummary, ProvidersView } from "@eta/client-contracts";
import { describe, expect, it } from "@rstest/core";
import { WireError } from "@/lib/wire";
import {
  discoveryErrorMessage,
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
    expect(keyMissing({ kind: "opencode", hasApiKey: false })).toBe(true);
    expect(keyMissing({ kind: "opencode-go", hasApiKey: false })).toBe(true);
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

  it("mark none of them as a default, even with a defaultModel left in the config", () => {
    const providers = [provider({ id: "a" }), provider({ id: "b" })];
    const models = modelsOf(view(providers, { defaultModel: "b:m2" }));
    expect(models.map((m) => m.id)).toEqual(["a:m1", "a:m2", "b:m1", "b:m2"]);
    expect(models.some((m) => "default" in m)).toBe(false);
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
      message: "local:old 已不可用，请重新选择模型。",
    });
    expect(modelAvailability({ model: null }, open).state).toBe("not_set");
  });

  it("warns, without blocking, about a model its provider no longer lists", () => {
    const listed = modelsOf(
      view([
        provider({
          id: "go",
          kind: "opencode-go",
          models: [{ id: "glm-5.2", name: "GLM-5.2", delisted: true }],
        }),
      ]),
    );
    expect(listed[0]).toMatchObject({ available: true, delisted: true });
    expect(modelAvailability({ model: "go:glm-5.2" }, listed)).toMatchObject({
      state: "delisted",
      message: "OpenCode Go 已不再提供 GLM-5.2，随时可能用不了，请换一个模型。",
    });
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

describe("safe discovery failures", () => {
  it.each([
    ["discovery_invalid_connection", "接口地址不对"],
    ["discovery_unsupported", "不提供模型列表"],
    ["discovery_network", "连不上模型接口"],
    ["discovery_network: ECONNREFUSED", "ECONNREFUSED"],
    ["discovery_response", "格式不正确"],
    ["discovery_timeout", "超时"],
    ["config_changed", "重新打开"],
    ["discovery_http_500", "HTTP 500"],
    // A refused key is told as such, not as a status code.
    ["discovery_http_401", "key 无效"],
    ["discovery_http_403", "key 无效"],
  ])("localizes %s without showing connection data", (code, text) => {
    expect(discoveryErrorMessage(new WireError("server", code))).toContain(
      text,
    );
  });
  it("passes unexpected errors through the existing error chain instead of hiding them", () => {
    const message = "unknown op: providers.discover";
    expect(discoveryErrorMessage(new WireError("server", message))).toBe(
      message,
    );
    expect(discoveryErrorMessage(new Error(message))).toBe(message);
  });
});
