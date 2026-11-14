import type {
  EtaModelConfig,
  LlmAccounts,
  LlmConnection,
  LlmModel,
  LlmQuota,
  ProviderCheck,
  ProviderDiscoverResult,
  ProviderInput,
  ProviderRefreshResult,
  ProviderSummary,
  ProvidersView,
} from "@eta/client-contracts";
import { afterEach, describe, expect, it, rstest } from "@rstest/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { toast } from "sonner";
import { setWire } from "@/lib/wire";
import { FakeHost } from "@/test-wire";
import { ProviderSettings } from "./provider-settings";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

rstest.mock("./use-agents", () => ({
  useAgents: () => ({
    agents: [
      { id: "a1", name: "小助手", model: "ds:deepseek-chat" },
      { id: "a2", name: "写手", model: "llm:gpt-5" },
    ],
  }),
}));
rstest.mock("sonner", () => ({
  toast: { success: rstest.fn(), error: rstest.fn(), warning: rstest.fn() },
}));

const provider = (
  extra: Partial<ProviderSummary> & { id: string },
): ProviderSummary => ({
  kind: "openai-compatible",
  baseUrl: "https://models.example/v1",
  hasApiKey: true,
  models: [{ id: "m1" }, { id: "m2" }],
  ...extra,
});

const connectors: LlmAccounts["connectors"] = [
  { id: "codex", name: "Codex", flow: "oauth_device" },
  { id: "xai", name: "Grok", flow: "oauth_device" },
  { id: "gemini", name: "Google AI Studio", flow: "api_key" },
];

interface Setup {
  providers?: ProviderSummary[];
  defaultModel?: string;
  checks?: Record<string, ProviderCheck>;
  connections?: LlmConnection[];
  models?: LlmModel[];
  quota?: LlmQuota[];
  /** No gateway on this host. */
  noGateway?: boolean;
  discover?: (args: unknown) => ProviderDiscoverResult;
  refresh?: (args: unknown) => ProviderRefreshResult;
  logos?: (args: unknown) => { logos: Record<string, string> };
}

const cleanup: (() => void)[] = [];

const settle = () => act(() => new Promise((r) => setTimeout(r, 0)));

/** A host that keeps the config it is told to save, so the page sees its own writes. */
async function render(setup: Setup = {}) {
  let config: ProvidersView = {
    revision: "r1",
    providers: setup.providers ?? [],
    ...(setup.defaultModel === undefined
      ? {}
      : { defaultModel: setup.defaultModel }),
  };
  let revision = 1;
  const fake = new FakeHost().target(
    "providers",
    { config, checks: setup.checks ?? {} },
    { eager: true },
  );
  const plugins = [{ name: "providers", source: "bundled" as const }];
  if (setup.noGateway !== true) {
    fake.target(
      "llm",
      {
        accounts: {
          ready: true,
          connectors,
          connections: setup.connections ?? [],
        } satisfies LlmAccounts,
        models: setup.models ?? [],
        quota: setup.quota ?? [],
      },
      { eager: true },
    );
    plugins.push({ name: "llm", source: "bundled" as const });
  }
  const write = (next: Omit<ProvidersView, "revision">) => {
    revision += 1;
    config = { ...next, revision: `r${revision}` };
    fake.set("providers", { config });
    return { revision: config.revision };
  };
  fake
    .plugins(plugins)
    .handle("providers.reload", () => ({}))
    .handle("providers.save", (args) => {
      const { provider: input } = args as { provider: ProviderInput };
      const saved: ProviderSummary = {
        id: input.id,
        ...(input.name === undefined ? {} : { name: input.name }),
        kind: input.kind ?? "openai-compatible",
        baseUrl: input.baseUrl,
        hasApiKey:
          input.apiKey === null
            ? false
            : input.apiKey !== undefined ||
              (config.providers.find((entry) => entry.id === input.id)
                ?.hasApiKey ??
                false),
        models: input.models,
      };
      const exists = config.providers.some((entry) => entry.id === input.id);
      return write({
        ...config,
        providers: exists
          ? config.providers.map((entry) =>
              entry.id === input.id ? saved : entry,
            )
          : [...config.providers, saved],
      });
    })
    .handle("providers.delete", (args) =>
      write({
        ...config,
        providers: config.providers.filter(
          (entry) => entry.id !== (args as { id: string }).id,
        ),
      }),
    )
    .handle("providers.setDefault", (args) =>
      write({
        ...config,
        defaultModel: (args as { defaultModel: string }).defaultModel,
      }),
    )
    .handle("providers.check", (args) => {
      const id = (args as { id?: string }).id ?? "";
      const check: ProviderCheck = {
        state: "ok",
        checkedAt: "2026-11-13T00:00:00Z",
      };
      fake.set("providers", { checks: { [id]: check } });
      return { checks: { [id]: check } };
    })
    .handle("providers.discover", (args) => {
      if (setup.discover === undefined) throw new Error("no discover");
      return setup.discover(args);
    })
    .handle("providers.logos", (args) => setup.logos?.(args) ?? { logos: {} })
    .handle("providers.refresh", (args) => {
      if (setup.refresh === undefined) throw new Error("no refresh");
      return setup.refresh(args);
    })
    .handle("llm.loginStart", () => ({
      login: {
        id: "login-1",
        connector: "codex",
        flow: "oauth_device",
        status: "pending",
        url: "https://auth.example/device",
        userCode: "FU27-R6WPD",
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
      },
    }))
    .handle("llm.loginPoll", () => ({
      login: {
        id: "login-1",
        connector: "codex",
        flow: "oauth_device",
        status: "pending",
        url: "https://auth.example/device",
        userCode: "FU27-R6WPD",
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
      },
    }))
    .handle("llm.loginCancel", () => ({}))
    .handle("llm.refresh", () => ({}))
    .handle("llm.remove", () => ({}));
  fake.install();
  fake.hello();

  const client = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity, retry: false } },
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <ProviderSettings />
      </QueryClientProvider>,
    ),
  );
  await settle();
  cleanup.push(() => {
    root.unmount();
    container.remove();
  });
  return {
    fake,
    config: () => config,
    calls: (action: string) =>
      fake.calls
        .filter((call) => call.action === action)
        .map((call) => call.args),
  };
}

const text = () => document.body.textContent ?? "";

function find<T extends HTMLElement = HTMLElement>(
  selector: string,
  name: RegExp,
): T {
  const found = [...document.querySelectorAll<T>(selector)].find((element) =>
    name.test(element.getAttribute("aria-label") ?? element.textContent ?? ""),
  );
  expect(found, `${selector} ${String(name)}`).toBeDefined();
  return found!;
}

async function click(name: RegExp, selector = "button") {
  const target = find(selector, name);
  await act(async () => {
    // Radix tabs switch on the press, not the click.
    if (target.getAttribute("role") === "tab")
      target.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true, button: 0 }),
      );
    target.click();
  });
  await settle();
  await settle();
}

/** Open a source's page from the list. */
const open = (name: RegExp) => click(name, '[aria-label="模型来源"] button');

/** Type into a React-controlled input the way the browser does. */
async function type(label: RegExp, value: string) {
  const input = [...document.querySelectorAll<HTMLInputElement>("input")].find(
    (element) => {
      const id = element.id;
      const labelText =
        element.getAttribute("aria-label") ??
        (id
          ? document.querySelector(`label[for="${CSS.escape(id)}"]`)
              ?.textContent
          : undefined) ??
        "";
      return label.test(labelText);
    },
  );
  expect(input, String(label)).toBeDefined();
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!;
    setter.call(input, value);
    input!.dispatchEvent(new Event("input", { bubbles: true }));
  });
  return input!;
}

const rows = () =>
  [
    ...document.querySelectorAll<HTMLElement>('[aria-label="模型来源"] > li'),
  ].map((row) => row.textContent ?? "");

/** Radix Select: open with Enter, pick an option with Enter. */
async function choose(trigger: HTMLElement, option: RegExp) {
  await act(async () =>
    trigger.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    ),
  );
  const item = find('[role="option"]', option);
  await act(async () =>
    item.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    ),
  );
  await settle();
}

afterEach(async () => {
  await act(async () => cleanup.splice(0).forEach((dispose) => dispose()));
  setWire(undefined);
  document.body.innerHTML = "";
  rstest.clearAllMocks();
  rstest.restoreAllMocks();
});

describe("the model sources list", () => {
  it("lists subscriptions and config providers together, each with how it connects, its models and its status", async () => {
    await render({
      providers: [
        provider({ id: "ds", kind: "deepseek", name: "DeepSeek" }),
        provider({ id: "kimi", kind: "kimi-coding", hasApiKey: false }),
        provider({ id: "router", name: "OpenRouter" }),
        provider({
          id: "ollama",
          name: "Ollama",
          baseUrl: "http://127.0.0.1:11434/v1",
          hasApiKey: false,
          models: [{ id: "qwen3:32b" }],
        }),
        provider({ id: "zen", kind: "opencode", name: "OpenCode Zen" }),
      ],
      checks: {
        router: {
          state: "invalid_key",
          checkedAt: "2026-11-13T00:00:00Z",
        },
        zen: {
          state: "unreachable",
          checkedAt: "2026-11-13T00:00:00Z",
          error: "discovery_network",
        },
      },
      connections: [
        {
          id: "c1",
          connector: "codex",
          label: "dev@example.com",
          state: "active",
          createdAt: "2026-10-01T00:00:00Z",
        },
        {
          id: "c2",
          connector: "xai",
          label: "grok@example.com",
          state: "needs_login",
          createdAt: "2026-10-01T00:00:00Z",
        },
      ],
      models: [
        {
          id: "gpt-5",
          connector: "codex",
          name: "GPT-5",
          status: "available",
          available: true,
        },
      ],
      quota: [
        {
          connectionId: "c1",
          windows: [{ kind: "5h", used: 42 }],
        },
      ],
    });
    const listed = rows();
    expect(listed).toHaveLength(7);
    expect(listed[0]).toContain("Codex");
    expect(listed[0]).toContain("订阅登录");
    expect(listed[0]).toContain("dev@example.com");
    expect(listed[0]).toContain("1 个模型");
    expect(listed[0]).toContain("正常");
    expect(listed[1]).toContain("需要重新登录");
    expect(listed[2]).toMatch(/DeepSeek.*API key.*2 个模型.*正常/);
    expect(listed[3]).toContain("需要 key");
    expect(listed[4]).toMatch(
      /OpenRouter.*自定义 · Chat Completions.*key 无效/,
    );
    expect(listed[5]).toMatch(/Ollama.*本机.*1 个模型.*正常/);
    expect(listed[6]).toContain("连不上");
    // The subscription's shortest window, as what is left of it.
    expect(
      document.querySelector('[role="meter"]')?.getAttribute("aria-valuenow"),
    ).toBe("58");
  });

  it("draws models.dev's logo where the host found one, and a letter where it did not", async () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg"><path fill="currentColor" d="M0 0"/></svg>';
    const page = await render({
      providers: [
        provider({
          id: "router",
          name: "OpenRouter",
          baseUrl: "https://openrouter.ai/api/v1",
        }),
        provider({
          id: "ollama",
          name: "Ollama",
          baseUrl: "http://127.0.0.1:11434/v1",
        }),
      ],
      connections: [
        {
          id: "c1",
          connector: "codex",
          label: "dev@example.com",
          state: "active",
          createdAt: "2026-10-01T00:00:00Z",
        },
      ],
      logos: () => ({
        logos: { "connector:codex": svg, "provider:router": svg },
      }),
    });
    await settle();
    // The host is asked once, by connector, preset kind and configured provider's address.
    const [asked] = page.calls("logos") as {
      sources: { key: string; id?: string; baseUrl?: string }[];
    }[];
    expect(asked?.sources).toContainEqual({
      key: "connector:codex",
      id: "openai",
    });
    expect(asked?.sources).toContainEqual({
      key: "kind:deepseek",
      baseUrl: "https://api.deepseek.com",
    });
    expect(asked?.sources).toContainEqual({
      key: "provider:router",
      baseUrl: "https://openrouter.ai/api/v1",
    });
    const tiles = [
      ...document.querySelectorAll('[aria-label="模型来源"] > li'),
    ].map((row) => row.querySelector('[aria-hidden="true"]')!);
    expect(tiles[0]?.querySelector("[data-logo]")).not.toBeNull();
    expect(tiles[1]?.querySelector("[data-logo]")).not.toBeNull();
    // Drawn as a mask, never as markup.
    expect(tiles[1]?.querySelector("svg")).toBeNull();
    expect(tiles[2]?.querySelector("[data-logo]")).toBeNull();
    expect(tiles[2]?.textContent).toBe("O");
  });

  it("says when the host has no providers plugin", async () => {
    const fake = new FakeHost().plugins([]);
    fake.install();
    fake.hello();
    const client = new QueryClient();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <ProviderSettings />
        </QueryClientProvider>,
      ),
    );
    cleanup.push(() => root.unmount());
    expect(text()).toContain("无法加载模型服务");
    expect(text()).toContain("宿主没有启用模型服务");
  });

  it("reads an old config as it is: unknown fields, legacy Codex and a key-less custom endpoint", async () => {
    await render({
      noGateway: true,
      providers: [
        provider({
          id: "old",
          models: [
            {
              id: "hand-typed",
              contextWindow: 64000,
              overrides: { name: "Mine" },
              defaultThinking: "high",
            } as EtaModelConfig,
          ],
          hasApiKey: false,
        }),
        provider({ id: "codex", kind: "openai-codex", hasApiKey: false }),
      ],
    });
    expect(rows()[0]).toMatch(/old.*自定义.*1 个模型.*正常/);
    expect(rows()[1]).toMatch(/Codex.*Codex 旧配置.*正常/);
  });
});

describe("the default model", () => {
  it("offers the models of working sources, gateway ones included, and writes the choice", async () => {
    const page = await render({
      providers: [
        provider({
          id: "ds",
          name: "DeepSeek",
          models: [{ id: "deepseek-chat" }],
        }),
        provider({
          id: "kimi",
          kind: "kimi-coding",
          hasApiKey: false,
          models: [{ id: "kimi-for-coding" }],
        }),
      ],
      defaultModel: "ds:deepseek-chat",
      connections: [
        {
          id: "c1",
          connector: "codex",
          label: "dev@example.com",
          state: "active",
          createdAt: "2026-10-01T00:00:00Z",
        },
      ],
      models: [
        {
          id: "gpt-5",
          connector: "codex",
          name: "GPT-5",
          status: "available",
          available: true,
        },
      ],
    });
    const trigger = find('[role="combobox"]', /默认模型|DeepSeek/);
    expect(trigger.textContent).toContain("DeepSeek · deepseek-chat");
    await act(async () =>
      trigger.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      ),
    );
    const options = [...document.querySelectorAll('[role="option"]')].map(
      (option) => option.textContent,
    );
    // Kimi has no key: its models are not offered.
    expect(options).toEqual(["DeepSeek · deepseek-chat", "Codex · GPT-5"]);
    await act(async () =>
      find('[role="option"]', /GPT-5/).dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      ),
    );
    await settle();
    expect(page.calls("setDefault")).toEqual([
      { defaultModel: "llm:gpt-5", revision: "r1" },
    ]);
    expect(page.config().defaultModel).toBe("llm:gpt-5");
  });
});

describe("adding a source", () => {
  const zen: ProviderDiscoverResult = {
    models: [
      {
        id: "gpt-5.4",
        name: "GPT-5.4",
        api: "openai-responses",
        contextWindow: 1_050_000,
        reasoning: true,
      },
      { id: "kimi-k3", name: "Kimi K3", api: "openai-completions" },
      {
        id: "old",
        name: "Old",
        api: "openai-completions",
        deprecated: true,
      },
    ],
    unsupported: [
      {
        id: "claude-opus-5-5",
        name: "Claude Opus 5.5",
        protocol: "@ai-sdk/anthropic",
        reason: "protocol",
      },
    ],
  };

  it("offers subscriptions, provider keys and custom endpoints in three groups", async () => {
    await render();
    await click(/添加来源/);
    const groups = [...document.querySelectorAll("[role=dialog] section")].map(
      (section) =>
        [...section.querySelectorAll("button")].map(
          (button) => button.textContent,
        ),
    );
    expect(groups).toEqual([
      ["CCodex", "GGrok"],
      [
        "DDeepSeek",
        "KKimi for Coding",
        "GGLM Coding Plan (CN)",
        "GGLM Coding Plan (Global)",
        "GGoogle AI Studio",
        "OOpenCode Zen",
        "OOpenCode Go",
      ],
      ["OOpenAI 兼容接口", "本本机模型Ollama、LM Studio"],
    ]);
  });

  it("leaves out the gateway's cards on a host without it", async () => {
    await render({ noGateway: true });
    await click(/添加来源/);
    expect(text()).not.toContain("Codex");
    expect(text()).not.toContain("Google AI Studio");
    expect(text()).toContain("DeepSeek");
  });

  it("says a refused key is invalid, and stays on the connect step", async () => {
    const page = await render({
      discover: () => {
        throw new Error("discovery_http_401");
      },
    });
    await click(/添加来源/);
    await click(/^DDeepSeek$/);
    await type(/DeepSeek 的 API key/, "sk-fake");
    await click(/^连接$/);
    expect(page.calls("discover")).toEqual([
      {
        kind: "deepseek",
        baseUrl: "https://api.deepseek.com",
        apiKey: "sk-fake",
      },
    ]);
    expect(find('[role="alert"]', /key/).textContent).toContain("key 无效");
    expect(page.calls("save")).toEqual([]);
  });

  it("lists OpenCode's models with the ones eta cannot speak shown but disabled, and saves the ticked ones", async () => {
    const page = await render({ discover: () => zen });
    await click(/添加来源/);
    await click(/^OOpenCode Zen$/);
    await type(/OpenCode Zen 的 API key/, "sk-zen");
    await click(/^连接$/);
    // Current models start ticked; a deprecated one is offered, not chosen.
    expect(text()).toContain("已选 2 个");
    const unsupported = find("li", /Claude Opus 5\.5/);
    expect(unsupported.textContent).toContain("暂不支持（Anthropic 协议）");
    expect(
      unsupported.querySelector("button")?.hasAttribute("disabled") ||
        unsupported.querySelector("[data-disabled]") !== null,
    ).toBe(true);
    expect(find("li", /GPT-5\.4/).textContent).toContain("1.1M");
    // Untick Kimi, then finish.
    await act(async () =>
      find("li", /Kimi K3/)
        .querySelector<HTMLElement>('[role="checkbox"]')!
        .click(),
    );
    expect(text()).toContain("已选 1 个");
    await click(/^完成$/);
    expect(page.calls("save")).toEqual([
      {
        provider: {
          id: "opencode-zen",
          name: "OpenCode Zen",
          kind: "opencode",
          baseUrl: "https://opencode.ai/inference/openai/v1",
          apiKey: "sk-zen",
          models: [zen.models[0]],
        },
        revision: "r1",
      },
    ]);
    // The new provider is checked with its saved key, and the dialog is gone.
    expect(page.calls("check")).toEqual([{ id: "opencode-zen" }]);
    expect(document.querySelector("[role=dialog]")).toBeNull();
    expect(rows()[0]).toContain("OpenCode Zen");
  });

  it("takes an address and a protocol for a custom endpoint, and names it after its host", async () => {
    const page = await render({
      discover: () => ({
        models: Array.from({ length: 20 }, (_, n) => ({ id: `m${n}` })),
      }),
    });
    await click(/添加来源/);
    await click(/^OOpenAI 兼容接口$/);
    await type(/^网址$/, "https://openrouter.ai/api/v1");
    await choose(find('[role="combobox"]', /Chat Completions/), /^Responses$/);
    await click(/^连接$/);
    expect(page.calls("discover")).toEqual([
      { kind: "openai-responses", baseUrl: "https://openrouter.ai/api/v1" },
    ]);
    // A long custom list starts with nothing ticked.
    expect(text()).toContain("已选 0 个");
    expect(find("button", /^完成$/).hasAttribute("disabled")).toBe(true);
    await act(async () =>
      find("li", /^m3/)
        .querySelector<HTMLElement>('[role="checkbox"]')!
        .click(),
    );
    await click(/^完成$/);
    expect(page.calls("save")[0]).toMatchObject({
      provider: {
        id: "openrouter.ai",
        name: "openrouter.ai",
        kind: "openai-responses",
        models: [{ id: "m3" }],
      },
    });
  });

  it("opens a subscription's device-code sign-in", async () => {
    const page = await render();
    await click(/添加来源/);
    await click(/^CCodex$/);
    expect(page.calls("loginStart")).toEqual([{ connector: "codex" }]);
    expect(text()).toContain("FU27-R6WPD");
    expect(find("a", /打开授权页面/).getAttribute("href")).toBe(
      "https://auth.example/device",
    );
    // Leaving while it waits cancels the attempt.
    await click(/^取消$/);
    expect(page.calls("loginCancel")).toEqual([{ id: "login-1" }]);
  });
});

describe("Eta Token Plan", () => {
  const gateway: ProviderDiscoverResult = {
    models: [
      {
        id: "claude-sonnet-5",
        name: "Claude Sonnet 5",
        api: "openai-completions",
        contextWindow: 1_000_000,
        reasoning: true,
      },
      { id: "gpt-5.4", api: "openai-completions" },
    ],
  };
  const etaButton = () => find("[role=dialog] button", /Eta Token Plan/);

  it("sits above every group as the recommended source, with Eta's own mark", async () => {
    await render();
    await click(/添加来源/);
    const card = etaButton();
    expect(card.textContent).toContain("推荐");
    expect(card.textContent).toContain("Eta 自家网关");
    const firstGroup = document.querySelector("[role=dialog] section")!;
    expect(
      card.compareDocumentPosition(firstGroup) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(card.querySelector("[style*=mask], svg, img")).not.toBeNull();
  });

  it("connects with one key, lists the gateway's models and saves the chosen ones", async () => {
    const page = await render({ discover: () => gateway });
    await click(/添加来源/);
    await click(/Eta Token Plan/, "[role=dialog] button");
    expect(find<HTMLAnchorElement>("a", /获取 key/).getAttribute("href")).toBe(
      "https://eta.0xfe.tech/app/dashboard?tab=keys",
    );
    await type(/Eta Token Plan 的 API key/, "sk-eta");
    await click(/^连接$/);
    expect(page.calls("discover")).toEqual([
      { kind: "eta", baseUrl: "https://eta.0xfe.tech/v1", apiKey: "sk-eta" },
    ]);
    expect(text()).toContain("已选 2 个");
    expect(find("li", /Claude Sonnet 5/).textContent).toContain("1M");
    await click(/^完成$/);
    expect(page.calls("save")).toEqual([
      {
        provider: {
          id: "eta-token-plan",
          name: "Eta Token Plan",
          kind: "eta",
          baseUrl: "https://eta.0xfe.tech/v1",
          apiKey: "sk-eta",
          models: gateway.models,
        },
        revision: "r1",
      },
    ]);
    expect(rows()[0]).toMatch(/Eta Token Plan.*API key.*2 个模型.*正常/);
  });

  it("says a key the gateway refuses (401) is invalid", async () => {
    const page = await render({
      discover: () => {
        throw new Error("discovery_http_401");
      },
    });
    await click(/添加来源/);
    await click(/Eta Token Plan/, "[role=dialog] button");
    await type(/Eta Token Plan 的 API key/, "sk-wrong");
    await click(/^连接$/);
    expect(find('[role="alert"]', /key/).textContent).toContain("key 无效");
    expect(page.calls("save")).toEqual([]);
  });

  it("is where the empty list leads, straight to its key", async () => {
    await render();
    expect(text()).toContain("还没有模型来源");
    await click(/^添加 Eta Token Plan$/);
    expect(document.querySelector("[role=dialog] section")).toBeNull();
    await type(/Eta Token Plan 的 API key/, "sk-eta");
  });

  it("is listed like any other source: name, model count and status", async () => {
    await render({
      providers: [
        provider({
          id: "eta",
          kind: "eta",
          name: "Eta Token Plan",
          baseUrl: "https://eta.0xfe.tech/v1",
          models: [{ id: "claude-sonnet-5" }, { id: "gpt-5.4" }, { id: "x" }],
        }),
      ],
      checks: {
        eta: { state: "invalid_key", checkedAt: "2026-11-13T00:00:00Z" },
      },
    });
    expect(rows()[0]).toMatch(/Eta Token Plan.*API key.*3 个模型.*key 无效/);
  });
});

describe("a source's page", () => {
  const deepseek = () =>
    provider({
      id: "ds",
      name: "DeepSeek",
      kind: "deepseek",
      baseUrl: "https://api.deepseek.com",
      models: [
        { id: "deepseek-chat", contextWindow: 128_000 },
        {
          id: "deepseek-reasoner",
          contextWindow: 128_000,
          reasoning: true,
          reasoningEfforts: ["low", "high"],
        },
      ],
    });

  it("turns models off and on at once, and keeps a turned-off one in the table", async () => {
    const page = await render({ providers: [deepseek()] });
    await open(/DeepSeek/);
    expect(text()).toContain("模型服务 / DeepSeek");
    await click(/启用 deepseek-reasoner/, '[role="switch"]');
    expect(page.calls("save")).toEqual([
      {
        provider: {
          id: "ds",
          name: "DeepSeek",
          kind: "deepseek",
          baseUrl: "https://api.deepseek.com",
          models: [{ id: "deepseek-chat", contextWindow: 128_000 }],
        },
        revision: "r1",
      },
    ]);
    // Still there, off; the last one on cannot be turned off.
    expect(
      find('[role="switch"]', /启用 deepseek-reasoner/).getAttribute(
        "aria-checked",
      ),
    ).toBe("false");
    expect(
      find('[role="switch"]', /启用 deepseek-chat/).hasAttribute("disabled"),
    ).toBe(true);
    await click(/启用 deepseek-reasoner/, '[role="switch"]');
    expect(
      (
        page.calls("save")[1] as { provider: ProviderInput }
      ).provider.models.map((model) => model.id),
    ).toEqual(["deepseek-chat", "deepseek-reasoner"]);
  });

  it("asks before turning off a model an agent uses", async () => {
    const page = await render({ providers: [deepseek()] });
    await open(/DeepSeek/);
    await click(/启用 deepseek-chat/, '[role="switch"]');
    expect(text()).toContain("关掉 deepseek-chat？");
    expect(text()).toContain("「小助手」正在用它");
    expect(page.calls("save")).toEqual([]);
    await click(/^关掉$/);
    expect(page.calls("save")).toHaveLength(1);
  });

  it("keeps a name typed by hand as an override, and sets a model's default thinking", async () => {
    const page = await render({ providers: [deepseek()] });
    await open(/DeepSeek/);
    await click(/编辑 deepseek-chat/);
    const input = await type(/^显示名$/, "Chat");
    await act(async () =>
      input.dispatchEvent(new FocusEvent("focusout", { bubbles: true })),
    );
    await settle();
    expect(
      (page.calls("save")[0] as { provider: ProviderInput }).provider.models[0],
    ).toEqual({
      id: "deepseek-chat",
      name: "Chat",
      contextWindow: 128_000,
      overrides: { name: "Chat" },
    });
    await choose(
      find('[role="combobox"]', /deepseek-reasoner 的默认思考等级/),
      /^high$/,
    );
    expect(
      (page.calls("save")[1] as { provider: ProviderInput }).provider.models[1],
    ).toMatchObject({ id: "deepseek-reasoner", defaultThinking: "high" });
  });

  it("refreshes the list into rows that are off, ready to be turned on", async () => {
    await render({
      providers: [deepseek()],
      refresh: () => ({
        revision: "r1",
        models: [
          { id: "deepseek-chat" },
          { id: "deepseek-v4", name: "DeepSeek V4", contextWindow: 1_000_000 },
        ],
      }),
    });
    await open(/DeepSeek/);
    await click(/刷新列表/);
    expect(
      find('[role="switch"]', /启用 DeepSeek V4/).getAttribute("aria-checked"),
    ).toBe("false");
    expect(find("tr", /DeepSeek V4/).textContent).toContain("1M");
  });

  it("saves the connection and checks it, and removes the source after asking", async () => {
    const page = await render({ providers: [deepseek()] });
    await open(/DeepSeek/);
    await click(/^连接$/, '[role="tab"]');
    await type(/^API key$/, "sk-new");
    await click(/保存并检测/);
    expect(page.calls("save")[0]).toMatchObject({
      provider: {
        id: "ds",
        kind: "deepseek",
        baseUrl: "https://api.deepseek.com",
        apiKey: "sk-new",
        headers: {},
      },
    });
    expect(page.calls("check")).toEqual([{ id: "ds" }]);
    expect(toast.success).toHaveBeenCalledWith("DeepSeek 连接正常");
    await click(/移除这个来源/);
    expect(text()).toContain("「小助手」使用的 DeepSeek 模型将不可用");
    await click(/^移除$/);
    expect(page.calls("delete")).toEqual([{ id: "ds", revision: "r2" }]);
    // Back on the list, which no longer has it.
    expect(rows()).toEqual([]);
  });

  it("shows a subscription's models and signs it out", async () => {
    const page = await render({
      connections: [
        {
          id: "c1",
          connector: "codex",
          label: "dev@example.com",
          plan: "plus",
          state: "active",
          createdAt: "2026-10-01T00:00:00Z",
        },
      ],
      models: [
        {
          id: "gpt-5",
          connector: "codex",
          name: "GPT-5",
          contextWindow: 400_000,
          status: "available",
          available: true,
        },
      ],
    });
    await open(/Codex/);
    expect(find("tr", /GPT-5/).textContent).toContain("400K");
    await click(/^检测$/);
    expect(page.calls("refresh")).toEqual([{}]);
    await click(/^连接$/, '[role="tab"]');
    expect(text()).toContain("dev@example.com");
    await click(/^退出$/);
    // Its only account: the agent on its model is named.
    expect(text()).toContain("「写手」使用的 Codex 模型将不可用");
    await click(/^退出$/, "[role=alertdialog] button");
    expect(page.calls("remove")).toEqual([{ id: "c1" }]);
  });
});
