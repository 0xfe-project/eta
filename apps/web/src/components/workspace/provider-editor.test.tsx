import type { ProviderSummary, ProvidersView } from "@eta/client-contracts";
import type { FakeHost } from "@/test-wire";
import { afterEach, describe, expect, it, rstest } from "@rstest/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { setWire } from "@/lib/wire";
import { providersHost } from "@/test-wire";
import { ProviderEditor } from "./provider-editor";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const cleanup: (() => void)[] = [];

async function render(node: React.ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity, retry: false } },
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>{node}</QueryClientProvider>,
    ),
  );
  cleanup.push(() => {
    root.unmount();
    container.remove();
  });
  return container;
}

afterEach(async () => {
  await act(async () => cleanup.splice(0).forEach((dispose) => dispose()));
  setWire(undefined);
  rstest.restoreAllMocks();
});

const provider: ProviderSummary = {
  id: "local",
  name: "Local",
  kind: "openai-compatible",
  baseUrl: "http://127.0.0.1:1/v1",
  hasApiKey: true,
  headers: { "x-test": "1" },
  models: [
    {
      id: "m1",
      name: "One",
      contextWindow: 8000,
      input: ["text"],
      reasoning: true,
      thinkingMode: "both",
      reasoningEfforts: ["low", "high"],
      defaultThinking: "low",
    },
  ],
};
const config: ProvidersView = { revision: "r1", providers: [provider] };

/** The host, answering `providers.save` with the revision it would write. */
function host(): FakeHost {
  return providersHost(config).handle("providers.save", () => ({
    revision: "r2",
  }));
}

const saves = (fake: FakeHost) =>
  fake.calls.filter((call) => call.action === "save");

async function save() {
  const button = [...document.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === "保存",
  )!;
  await act(async () => button.click());
}

function type(element: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  setter?.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("provider 编辑表单", () => {
  it("提交时不带 key，等于「别动它」，并带上读到的 revision", async () => {
    const fake = host();
    await render(<ProviderEditor provider={provider} onClose={() => {}} />);
    await save();
    const [call] = saves(fake);
    expect(call?.args).toMatchObject({
      revision: "r1",
      provider: {
        id: "local",
        name: "Local",
        kind: "openai-compatible",
        baseUrl: "http://127.0.0.1:1/v1",
        headers: { "x-test": "1" },
      },
    });
    expect("apiKey" in (call!.args as { provider: object }).provider).toBe(
      false,
    );
    // The host reads config.json per turn: saving says so, and nothing claims a restart.
    expect(document.body.textContent).toContain("已保存");
    expect(document.body.textContent).not.toContain("重启");
  });

  it("清除 key 时提交 null", async () => {
    const fake = host();
    await render(<ProviderEditor provider={provider} onClose={() => {}} />);
    const clear = [...document.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("清除 key"),
    )!;
    await act(async () => clear.click());
    await save();
    expect(
      (saves(fake)[0]!.args as { provider: { apiKey?: unknown } }).provider
        .apiKey,
    ).toBeNull();
  });

  it("没动的模型原样存回，改了的写进 overrides", async () => {
    const fake = host();
    await render(<ProviderEditor provider={provider} onClose={() => {}} />);
    await save();
    // Reasoning, thinking levels and the rest of what the form does not show are kept.
    expect(
      (saves(fake)[0]!.args as { provider: { models: unknown[] } }).provider
        .models,
    ).toEqual(provider.models);

    const window = document.querySelector<HTMLInputElement>(
      'input[aria-label="上下文窗口"]',
    )!;
    await act(async () => type(window, "32000"));
    await save();
    expect(
      (saves(fake)[1]!.args as { provider: { models: unknown[] } }).provider
        .models,
    ).toEqual([{ ...provider.models[0], overrides: { contextWindow: 32000 } }]);
  });

  it("新建的 provider 用名字当 id，重名时加个数", async () => {
    const fake = host();
    await render(<ProviderEditor provider={undefined} onClose={() => {}} />);
    const base = document.querySelector<HTMLInputElement>("#provider-base")!;
    const name = document.querySelector<HTMLInputElement>("#provider-name")!;
    await act(async () => type(base, "https://example.com/v1"));
    // No name, no id: there is nothing to save as.
    const button = () =>
      [...document.querySelectorAll("button")].find(
        (candidate) => candidate.textContent === "保存",
      )!;
    expect(button().disabled).toBe(true);
    await act(async () => type(name, "Local"));
    expect(button().disabled).toBe(false);
    await save();
    expect(
      (saves(fake)[0]!.args as { provider: { id: string } }).provider.id,
    ).toBe("local-2");
  });

  it("配置在别处被改过：重新读取，告诉用户，再存一次就用新的 revision", async () => {
    const fake = host();
    let refused = true;
    fake.handle("providers.save", () => {
      if (refused) {
        refused = false;
        // Another editor wrote the file; the host re-reads it on reload.
        fake.set("providers", { config: { ...config, revision: "r9" } });
        throw new Error("config_changed");
      }
      return { revision: "r10" };
    });
    await render(<ProviderEditor provider={provider} onClose={() => {}} />);
    await save();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "已重新读取",
    );
    expect(fake.calls.some((call) => call.action === "reload")).toBe(true);

    await save();
    expect(
      saves(fake).map((call) => (call.args as { revision: string }).revision),
    ).toEqual(["r1", "r9"]);
  });
});

describe("改了一半就走", () => {
  it("先问，不直接丢掉", async () => {
    providersHost(config);
    const closed: boolean[] = [];
    await render(
      <ProviderEditor provider={provider} onClose={() => closed.push(false)} />,
    );
    const name = document.querySelector<HTMLInputElement>("#provider-name")!;
    await act(async () => type(name, "改了个名字"));
    // The form's own way out: 返回, above the fields.
    const back = [...document.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("返回"),
    )!;
    await act(async () => back.click());
    const alert = document.querySelector('[role="alertdialog"]');
    expect(alert?.textContent).toContain("还没保存");
    expect(closed).toEqual([]);

    const discard = [...alert!.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("放弃"),
    )!;
    await act(async () => discard.click());
    expect(closed).toEqual([false]);
  });
});

function button(text: string) {
  return [...document.querySelectorAll("button")].find(
    (item) => item.textContent === text,
  )!;
}
async function fill(selector: string, value: string) {
  await act(async () =>
    type(document.querySelector<HTMLInputElement>(selector)!, value),
  );
}
async function fetchList() {
  await act(async () => button("获取模型列表").click());
}
const discoveries = (fake: FakeHost) =>
  fake.calls.filter((call) => call.action === "discover");
function choice(id: string) {
  return [...document.querySelectorAll("label")]
    .find((label) => label.textContent?.includes(id))
    ?.querySelector<HTMLInputElement>('input[type="checkbox"]');
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe("表单内模型预览", () => {
  it("空白添加：使用未保存的连接值，无占位模型即可获取、搜索、勾选、手加并保存", async () => {
    const fake = host().handle("providers.discover", () => ({
      models: [
        { id: "alpha", contextWindow: 12000 },
        { id: "beta" },
        { id: "alpha" },
      ],
    }));
    await render(<ProviderEditor provider={undefined} onClose={() => {}} />);
    expect(button("获取模型列表").disabled).toBe(true);
    await fill("#provider-name", "New");
    await fill("#provider-base", "https://new.test/v1");
    await fill("#provider-key", "new-secret");
    await act(async () =>
      [...document.querySelectorAll("button")]
        .find((item) => item.textContent?.includes("加一行"))!
        .click(),
    );
    await fill('input[aria-label="名字"]', "User-Agent");
    await fill('input[aria-label="值"]', "eta-test");
    await fetchList();
    expect(discoveries(fake)[0]?.args).toEqual({
      kind: "openai-compatible",
      baseUrl: "https://new.test/v1",
      apiKey: "new-secret",
      headers: { "User-Agent": "eta-test" },
    });
    expect(saves(fake)).toHaveLength(0);
    expect(document.querySelectorAll('input[type="checkbox"]')).toHaveLength(2);
    await fill('input[aria-label="搜索模型"]', "alpha");
    expect(choice("beta")).toBeUndefined();
    await act(async () => choice("alpha")!.click());
    await fill('input[aria-label="搜索模型"]', "missing");
    expect(document.body.textContent).toContain("没有匹配");
    await act(async () =>
      [...document.querySelectorAll("button")]
        .find((item) => item.textContent?.includes("加一个模型"))!
        .click(),
    );
    await fill("#model-id-0", "manual");
    expect(saves(fake)).toHaveLength(0);
    await save();
    expect(
      (saves(fake)[0]?.args as { provider: { models: unknown[] } }).provider
        .models,
    ).toEqual([{ id: "manual" }, { id: "alpha" }]);
    expect(document.body.textContent).toContain("已保存");
    // Saving a new provider must not create a second provider on the next save/fetch.
    await fetchList();
    expect(discoveries(fake)[1]?.args).toMatchObject({
      id: "new",
      revision: "r2",
    });
  });

  it("获取/勾选后放弃：不保存也不刷新实际配置，返回后未完成请求不可写回", async () => {
    const waiting = deferred<{ models: { id: string }[] }>();
    const fake = host().handle("providers.discover", () => ({
      models: [{ id: "new-model" }],
    }));
    const close = rstest.fn();
    await render(<ProviderEditor provider={undefined} onClose={close} />);
    await fill("#provider-base", "https://new.test/v1");
    await fetchList();
    await act(async () => choice("new-model")!.click());
    fake.handle("providers.discover", () => waiting.promise);
    await fetchList();
    await act(async () =>
      [...document.querySelectorAll("button")]
        .find((item) => item.textContent?.includes("返回"))!
        .click(),
    );
    await act(async () => button("放弃改动").click());
    expect(close).toHaveBeenCalledTimes(1);
    await act(async () => waiting.resolve({ models: [{ id: "late" }] }));
    expect(
      fake.calls.filter((call) =>
        ["save", "refresh", "delete"].includes(call.action),
      ),
    ).toEqual([]);
  });

  it("编辑：保留已修改名称、窗口、思考配置及未被发现的模型；只补选新模型", async () => {
    const existing = {
      ...provider,
      models: [
        ...provider.models,
        { id: "not-discovered", overrides: { maxTokens: 50 } },
      ],
    };
    const fake = host().handle("providers.discover", () => ({
      models: [
        { id: "m1", name: "remote", contextWindow: 1 },
        { id: "new-model", contextWindow: 16000 },
      ],
    }));
    await render(<ProviderEditor provider={existing} onClose={() => {}} />);
    await fill("#model-name-0", "My name");
    await fill("#model-window-0", "32000");
    await act(async () =>
      document
        .querySelector<HTMLButtonElement>("#model-thinking-0")!
        .dispatchEvent(
          new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
        ),
    );
    const high = [
      ...document.querySelectorAll<HTMLElement>('[role="option"]'),
    ].find((option) => option.textContent === "high")!;
    await act(async () => {
      high.focus();
      high.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    });
    await fetchList();
    expect(discoveries(fake)[0]?.args).toMatchObject({
      id: "local",
      revision: "r1",
    });
    expect(discoveries(fake)[0]?.args as object).not.toHaveProperty("apiKey");
    expect(choice("m1")?.disabled).toBe(true);
    await act(async () => choice("new-model")!.click());
    await save();
    expect(
      (saves(fake)[0]?.args as { provider: { models: unknown[] } }).provider
        .models,
    ).toEqual([
      {
        ...provider.models[0],
        overrides: { name: "My name", contextWindow: 32000 },
        defaultThinking: "high",
      },
      existing.models[1],
      { id: "new-model", contextWindow: 16000 },
    ]);
  });

  it("加载防重入、失败保留输入可重试、空结果，以及错误不回显敏感内容", async () => {
    const waiting = deferred<{ models: { id: string }[] }>();
    const fake = host().handle("providers.discover", () => waiting.promise);
    await render(<ProviderEditor provider={provider} onClose={() => {}} />);
    await fill("#provider-key", "secret-value");
    await act(async () => {
      button("获取模型列表").click();
      button("获取模型列表").click();
    });
    expect(discoveries(fake)).toHaveLength(1);
    expect(button("正在获取模型列表…").disabled).toBe(true);
    await act(async () =>
      waiting.reject(new Error("discovery_network: ECONNREFUSED [redacted]")),
    );
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "ECONNREFUSED",
    );
    expect(document.body.textContent).not.toContain("secret-value");
    expect(
      document.querySelector<HTMLInputElement>("#provider-key")?.value,
    ).toBe("secret-value");
    fake.handle("providers.discover", () => {
      throw new Error("discovery_http_401");
    });
    await fetchList();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "HTTP 401",
    );
    fake.handle("providers.discover", () => ({ models: [] }));
    await fetchList();
    expect(document.body.textContent).toContain("没有可用模型");
    expect(saves(fake)).toHaveLength(0);
  });

  it.each(["#provider-base", "#provider-key", 'input[aria-label="值"]'])(
    "修改连接字段 %s 后清除预览勾选，保留手动/已有模型且不使用旧列表",
    async (selector) => {
      const fake = host().handle("providers.discover", () => ({
        models: [{ id: "new-model" }],
      }));
      await render(<ProviderEditor provider={provider} onClose={() => {}} />);
      await fetchList();
      await act(async () => choice("new-model")!.click());
      await fill(
        selector,
        selector === "#provider-base" ? "https://other.test/v1" : "changed",
      );
      expect(document.body.textContent).toContain("请重新获取模型列表");
      expect(choice("new-model")).toBeUndefined();
      await save();
      expect(
        (saves(fake)[0]?.args as { provider: { models: unknown[] } }).provider
          .models,
      ).toEqual(provider.models);
    },
  );

  it("旧请求的成功/失败不可覆盖新请求，改后再改回也必须重取", async () => {
    const first = deferred<{ models: { id: string }[] }>();
    const second = deferred<{ models: { id: string }[] }>();
    const fake = host().handle("providers.discover", () => first.promise);
    await render(<ProviderEditor provider={provider} onClose={() => {}} />);
    await fetchList();
    await fill("#provider-base", "https://other.test/v1");
    fake.handle("providers.discover", () => second.promise);
    await fetchList();
    await act(async () => second.resolve({ models: [{ id: "fresh-model" }] }));
    await act(async () => first.resolve({ models: [{ id: "stale-model" }] }));
    expect(choice("fresh-model")).toBeDefined();
    expect(choice("stale-model")).toBeUndefined();
    await fill("#provider-base", provider.baseUrl);
    await fill("#provider-base", "https://other.test/v1");
    expect(choice("fresh-model")).toBeUndefined();
    const oldFailure = deferred<{ models: { id: string }[] }>();
    fake.handle("providers.discover", () => oldFailure.promise);
    await fetchList();
    await fill("#provider-key", "replacement");
    fake.handle("providers.discover", () => ({
      models: [{ id: "latest-model" }],
    }));
    await fetchList();
    await act(async () => oldFailure.reject(new Error("discovery_http_500")));
    expect(choice("latest-model")).toBeDefined();
    expect(document.querySelector('[role="alert"]')).toBeNull();
  });
});

describe("预览连接边界", () => {
  it.each(["清除 key", "delete-header", "rename-header", "change-kind"])(
    "%s 后旧预览不可继续选择",
    async (action) => {
      host().handle("providers.discover", () => ({
        models: [{ id: "preview-model" }],
      }));
      await render(<ProviderEditor provider={provider} onClose={() => {}} />);
      await fetchList();
      if (action === "清除 key") await act(async () => button(action).click());
      if (action === "delete-header")
        await act(async () =>
          document
            .querySelector<HTMLButtonElement>(".settings-header-row button")!
            .click(),
        );
      if (action === "rename-header")
        await fill('input[aria-label="名字"]', "X-New");
      if (action === "change-kind") {
        await act(async () =>
          document
            .querySelector<HTMLButtonElement>("#provider-kind")!
            .dispatchEvent(
              new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
            ),
        );
        const option = [
          ...document.querySelectorAll<HTMLElement>('[role="option"]'),
        ].find((item) => item.textContent === "openai-responses")!;
        await act(async () => {
          option.focus();
          option.dispatchEvent(
            new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
          );
        });
      }
      expect(document.body.textContent).toContain("请重新获取模型列表");
      expect(choice("preview-model")).toBeUndefined();
    },
  );

  it("同一连接重复获取或失败不覆盖已经勾选并编辑的模型", async () => {
    const fake = host().handle("providers.discover", () => ({
      models: [{ id: "preview-model", name: "Remote" }],
    }));
    await render(<ProviderEditor provider={provider} onClose={() => {}} />);
    await fetchList();
    await act(async () => choice("preview-model")!.click());
    await fill("#model-name-1", "Mine");
    await fetchList();
    expect(
      document.querySelector<HTMLInputElement>("#model-name-1")?.value,
    ).toBe("Mine");
    fake.handle("providers.discover", () => {
      throw new Error("discovery_http_500");
    });
    await fetchList();
    await save();
    expect(
      (saves(fake)[0]?.args as { provider: { models: unknown[] } }).provider
        .models,
    ).toEqual([
      ...provider.models,
      { id: "preview-model", name: "Remote", overrides: { name: "Mine" } },
    ]);
  });
});

describe("重新获取中的表单改动", () => {
  it("请求未完成时继续编辑已选模型，返回结果不能覆盖编辑", async () => {
    const fake = host().handle("providers.discover", () => ({
      models: [{ id: "preview-model" }],
    }));
    await render(<ProviderEditor provider={provider} onClose={() => {}} />);
    await fetchList();
    await act(async () => choice("preview-model")!.click());
    const waiting = deferred<{ models: { id: string }[] }>();
    fake.handle("providers.discover", () => waiting.promise);
    await fetchList();
    await fill("#model-name-1", "Edited while loading");
    await act(async () =>
      waiting.resolve({ models: [{ id: "preview-model" }] }),
    );
    await save();
    expect(
      (saves(fake)[0]?.args as { provider: { models: unknown[] } }).provider
        .models,
    ).toEqual([
      ...provider.models,
      { id: "preview-model", overrides: { name: "Edited while loading" } },
    ]);
  });
});
