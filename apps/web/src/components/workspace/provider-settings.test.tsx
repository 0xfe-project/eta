import type { ProviderSummary, ProvidersView } from "@eta/client-contracts";
import { afterEach, describe, expect, it, rstest } from "@rstest/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { setWire } from "@/lib/wire";
import { FakeHost, providersHost } from "@/test-wire";
import { ProviderSettings } from "./provider-settings";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

rstest.mock("./use-agents", () => ({
  useAgents: () => ({
    agents: [{ id: "a1", name: "小助手", model: "local:m1" }],
  }),
}));
rstest.mock("sonner", () => ({
  toast: { success: rstest.fn(), error: rstest.fn(), warning: rstest.fn() },
}));

const provider = (extra: Partial<ProviderSummary> & { id: string }) =>
  ({
    kind: "openai-compatible",
    baseUrl: "http://127.0.0.1:1/v1",
    hasApiKey: true,
    models: [{ id: "m1" }, { id: "m2" }],
    ...extra,
  }) satisfies ProviderSummary;

const config = (providers: ProviderSummary[]): ProvidersView => ({
  revision: "r1",
  providers,
});

const cleanup: (() => void)[] = [];

async function render(fake: FakeHost) {
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
  cleanup.push(() => {
    root.unmount();
    container.remove();
  });
  return fake;
}

const settle = () => act(() => new Promise((r) => setTimeout(r, 0)));
const text = () => document.body.textContent ?? "";
/** Radix opens a menu on pointer down. */
const openMenu = async (row = 0) => {
  const item = document.querySelectorAll("li")[row]!;
  const trigger = item.querySelector<HTMLElement>('[aria-haspopup="menu"]')!;
  await act(async () => {
    trigger.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, button: 0 }),
    );
    await new Promise((r) => setTimeout(r, 0));
  });
};
const choose = async (name: RegExp) => {
  const item = [
    ...document.querySelectorAll<HTMLElement>('[role="menuitem"]'),
  ].find((candidate) => name.test(candidate.textContent ?? ""));
  expect(item, String(name)).toBeDefined();
  await act(async () => item!.click());
};

afterEach(async () => {
  await act(async () => cleanup.splice(0).forEach((dispose) => dispose()));
  setWire(undefined);
  document.body.innerHTML = "";
  rstest.useRealTimers();
  rstest.clearAllMocks();
  rstest.restoreAllMocks();
});

describe("the providers page", () => {
  it("lists what the config holds, and what each row can tell", async () => {
    await render(
      providersHost(
        config([
          provider({ id: "local", name: "Local" }),
          provider({ id: "ds", kind: "deepseek", hasApiKey: false }),
          provider({ id: "open", hasApiKey: false }),
          provider({ id: "codex", kind: "openai-codex", hasApiKey: false }),
        ]),
      ),
    );
    const rows = [...document.querySelectorAll("li")].map(
      (row) => row.textContent ?? "",
    );
    expect(rows[0]).toContain("local");
    expect(rows[0]).toContain("2 个模型");
    expect(rows[0]).not.toContain("还没配");
    // A key a provider cannot run without is a warning; an open endpoint just has none.
    expect(rows[1]).toContain("还没配");
    expect(
      document.querySelectorAll("li")[1]?.querySelector(".text-destructive"),
    ).not.toBeNull();
    expect(rows[2]).toContain("还没配");
    expect(
      document.querySelectorAll("li")[2]?.querySelector(".text-destructive"),
    ).toBeNull();
    // Codex holds no key; the page does not claim anything about its sign-in.
    expect(rows[3]).not.toContain("还没配");
    expect(rows[3]).toContain("旧 Codex 配置（未迁移）");
    expect(
      document.querySelectorAll("li")[3]?.querySelector("button"),
    ).toBeNull();
    expect(text()).not.toContain("绑定账号");
  });

  it("waits for the config, and says so when the host has no providers plugin", async () => {
    const fake = new FakeHost().plugins([]);
    fake.install();
    fake.hello();
    await render(fake);
    expect(text()).toContain("无法加载模型服务");
    expect(text()).toContain("宿主没有启用模型服务");
  });

  it("follows the config when it changes under it", async () => {
    const fake = await render(providersHost(config([provider({ id: "a" })])));
    expect(document.querySelectorAll("li")).toHaveLength(1);
    await act(async () => {
      fake.set("providers", {
        config: {
          revision: "r2",
          providers: [provider({ id: "a" }), provider({ id: "b" })],
        },
      });
    });
    expect(document.querySelectorAll("li")).toHaveLength(2);
  });
});

describe("removing a provider", () => {
  it("names the agents that lose their model, then removes it at the revision it read", async () => {
    const fake = await render(
      providersHost(config([provider({ id: "local" })])).handle(
        "providers.delete",
        () => ({ revision: "r2" }),
      ),
    );
    // Removing lives in the editor now: the row opens it, the save row asks.
    await act(async () =>
      [...document.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent === "编辑")!
        .click(),
    );
    await settle();
    await act(async () =>
      [...document.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent === "删除")!
        .click(),
    );
    await settle();
    expect(
      document.querySelector('[role="alertdialog"]')?.textContent,
    ).toContain("「小助手」");
    await act(async () => {
      document
        .querySelector<HTMLButtonElement>(
          '[role="alertdialog"] button:last-child',
        )!
        .click();
    });
    await settle();
    expect(fake.calls.find((call) => call.action === "delete")?.args).toEqual({
      id: "local",
      revision: "r1",
    });
  });
});

describe("refreshing a provider's models", () => {
  it("asks the provider's endpoint and says what it found", async () => {
    const { toast } = await import("sonner");
    const fake = await render(
      providersHost(config([provider({ id: "local" })])).handle(
        "providers.refresh",
        () => ({ revision: "r2", models: 5 }),
      ),
    );
    await openMenu();
    await choose(/刷新模型/);
    await settle();
    expect(fake.calls.find((call) => call.action === "refresh")?.args).toEqual({
      id: "local",
    });
    expect(toast.success).toHaveBeenCalledWith("local：读到 5 个模型");
  });

  it("for a models.dev provider, counts what is new and names what is gone and who uses it", async () => {
    const { toast } = await import("sonner");
    const zen = provider({
      id: "local",
      kind: "opencode",
      baseUrl: "https://opencode.ai/inference/openai/v1",
      models: [
        { id: "m1", name: "GLM-5.2", delisted: true },
        { id: "m2", name: "Hy3" },
      ],
    });
    await render(
      providersHost(config([zen])).handle("providers.refresh", () => ({
        revision: "r2",
        models: 30,
        added: ["k4"],
        delisted: ["m1"],
      })),
    );
    await openMenu();
    await choose(/刷新模型/);
    await settle();
    expect(toast.warning).toHaveBeenCalledWith(
      "OpenCode Zen 已不再提供 GLM-5.2，在你删除前会一直保留。",
      { description: "「小助手」 正在用，请换一个模型。" },
    );
  });

  it("for a models.dev provider with nothing gone, says how many are new", async () => {
    const { toast } = await import("sonner");
    await render(
      providersHost(
        config([provider({ id: "go", kind: "opencode-go" })]),
      ).handle("providers.refresh", () => ({
        revision: "r2",
        models: 30,
        added: ["a", "b"],
        delisted: [],
      })),
    );
    await openMenu();
    await choose(/刷新模型/);
    await settle();
    expect(toast.success).toHaveBeenCalledWith("OpenCode Go：新增 2 个模型");
  });

  it("tells why when the provider would not answer", async () => {
    const { toast } = await import("sonner");
    await render(
      providersHost(config([provider({ id: "local" })])).handle(
        "providers.refresh",
        () => {
          throw new Error("the model list came back 401");
        },
      ),
    );
    await openMenu();
    await choose(/刷新模型/);
    await settle();
    expect(toast.error).toHaveBeenCalledWith("the model list came back 401");
  });
});
