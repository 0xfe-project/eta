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
  toast: { success: rstest.fn(), error: rstest.fn() },
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
const button = (label: RegExp) =>
  [...document.querySelectorAll("button")].find((b) =>
    label.test(`${b.textContent ?? ""}${b.getAttribute("aria-label") ?? ""}`),
  );
const press = async (label: RegExp) => {
  const target = button(label);
  expect(target, String(label)).toBeDefined();
  await act(async () => target!.click());
};
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
    expect(rows[3]).toContain("绑定账号");
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

describe("linking a Codex account", () => {
  it("shows the code, follows the sign-in, and says when it is done", async () => {
    rstest.useFakeTimers();
    const { toast } = await import("sonner");
    let status = "pending";
    const fake = await render(
      providersHost(
        config([
          provider({ id: "codex", kind: "openai-codex", hasApiKey: false }),
        ]),
      )
        .handle("providers.codexLogin", () => ({
          login: {
            id: "l1",
            status: "pending",
            method: "device_code",
            userCode: "ABCD-1234",
            url: "https://auth.example.com/device",
          },
        }))
        .handle("providers.codexStatus", () => ({
          login: {
            id: "l1",
            status,
            userCode: "ABCD-1234",
            url: "https://auth.example.com/device",
          },
        })),
    );
    await press(/绑定账号/);
    await act(async () => {
      await rstest.advanceTimersByTimeAsync(0);
    });
    expect(
      fake.calls.find((call) => call.action === "codexLogin")?.args,
    ).toEqual({ method: "device_code" });
    expect(text()).toContain("ABCD-1234");
    expect(
      document.querySelector<HTMLAnchorElement>('a[href^="https://auth"]'),
    ).not.toBeNull();

    // Still pending after a poll; then it completes.
    await act(async () => {
      await rstest.advanceTimersByTimeAsync(1500);
    });
    status = "complete";
    await act(async () => {
      await rstest.advanceTimersByTimeAsync(1500);
    });
    // The reply to that poll is still on its way through the microtasks.
    await act(async () => {
      await rstest.advanceTimersByTimeAsync(10);
    });
    expect(toast.success).toHaveBeenCalledWith("已绑定 Codex 账号");
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    // No longer pending, so it stops asking.
    const polls = () =>
      fake.calls.filter((call) => call.action === "codexStatus").length;
    const seen = polls();
    await act(async () => {
      await rstest.advanceTimersByTimeAsync(10_000);
    });
    expect(polls()).toBe(seen);
  });

  it("cancels a sign-in that is closed while it waits", async () => {
    const fake = await render(
      providersHost(
        config([
          provider({ id: "codex", kind: "openai-codex", hasApiKey: false }),
        ]),
      )
        .handle("providers.codexLogin", () => ({
          login: {
            id: "l1",
            status: "pending",
            userCode: "X",
            url: "https://a",
          },
        }))
        .handle("providers.codexStatus", () => ({
          login: {
            id: "l1",
            status: "pending",
            userCode: "X",
            url: "https://a",
          },
        }))
        .handle("providers.codexCancel", () => ({ cancelled: true })),
    );
    await press(/绑定账号/);
    await settle();
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    await act(async () => {
      dialog.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    await settle();
    expect(
      fake.calls.find((call) => call.action === "codexCancel")?.args,
    ).toEqual({
      id: "l1",
    });
  });

  it("passes on the code the authorization page asked to have typed back", async () => {
    const fake = await render(
      providersHost(
        config([
          provider({ id: "codex", kind: "openai-codex", hasApiKey: false }),
        ]),
      )
        .handle("providers.codexLogin", () => ({
          login: {
            id: "l1",
            status: "pending",
            manualPromptId: "p1",
            url: "https://a",
          },
        }))
        .handle("providers.codexStatus", () => ({
          login: {
            id: "l1",
            status: "pending",
            manualPromptId: "p1",
            url: "https://a",
          },
        }))
        .handle("providers.codexAnswer", () => ({ accepted: true })),
    );
    await press(/绑定账号/);
    await settle();
    const input = document.querySelector<HTMLInputElement>(
      'input[aria-label="授权页给出的代码或地址"]',
    )!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!.call(input, " http://localhost:1455/cb?code=1 ");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await press(/^继续$/);
    expect(
      fake.calls.find((call) => call.action === "codexAnswer")?.args,
    ).toEqual({
      id: "l1",
      promptId: "p1",
      value: "http://localhost:1455/cb?code=1",
    });
  });
});
