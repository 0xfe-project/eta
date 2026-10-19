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
