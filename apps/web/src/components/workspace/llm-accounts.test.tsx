import type {
  LlmAccounts as Accounts,
  LlmConnection,
  LlmConnector,
  LlmLogin,
  LlmModel,
  LlmQuota,
  ProvidersView,
} from "@eta/client-contracts";
import { afterEach, describe, expect, it, rstest } from "@rstest/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { toast } from "sonner";
import { setWire } from "@/lib/wire";
import { gatewayModels } from "@/queries/providers";
import { FakeHost } from "@/test-wire";
import { ProviderSettings } from "./provider-settings";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

rstest.mock("./use-agents", () => ({
  useAgents: () => ({
    agents: [{ id: "a1", name: "小助手", model: "llm:gpt-5" }],
  }),
}));
rstest.mock("sonner", () => ({
  toast: { success: rstest.fn(), error: rstest.fn() },
}));

const connectors: LlmConnector[] = [
  { id: "codex", name: "Codex", flow: "oauth_device" },
  { id: "xai", name: "Grok", flow: "oauth_device" },
  { id: "gemini", name: "Google AI Studio", flow: "api_key" },
];

const connection = (
  extra: Partial<LlmConnection> & { id: string; connector: string },
): LlmConnection => ({
  label: "dev@example.com",
  state: "active",
  createdAt: "2026-10-01T00:00:00Z",
  ...extra,
});

const config: ProvidersView = { revision: "r1", providers: [] };

const cleanup: (() => void)[] = [];

interface Setup {
  connections?: LlmConnection[];
  quota?: LlmQuota[];
  models?: LlmModel[];
  /** Leave the llm plugin out, as a host without the gateway library does. */
  without?: boolean;
}

async function render(setup: Setup = {}) {
  const host = new FakeHost().target("providers", { config }, { eager: true });
  const plugins = [{ name: "providers", source: "bundled" as const }];
  if (setup.without !== true) {
    host.target(
      "llm",
      {
        accounts: {
          ready: true,
          connectors,
          connections: setup.connections ?? [],
        } satisfies Accounts,
        models: setup.models ?? [],
        quota: setup.quota ?? [],
      },
      { eager: true },
    );
    plugins.push({ name: "llm", source: "bundled" as const });
  }
  host.plugins(plugins).handle("providers.reload", () => ({}));
  host.install();
  host.hello();
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
  return host;
}

const settle = () => act(() => new Promise((r) => setTimeout(r, 0)));
const text = () => document.body.textContent ?? "";
const button = (label: RegExp, within: ParentNode = document) =>
  [...within.querySelectorAll("button")].find((b) =>
    label.test(`${b.textContent ?? ""}${b.getAttribute("aria-label") ?? ""}`),
  );
const press = async (label: RegExp, within: ParentNode = document) => {
  const target = button(label, within);
  expect(target, String(label)).toBeDefined();
  await act(async () => target!.click());
};
const section = (name: string) =>
  document.querySelector<HTMLElement>(
    `section[aria-labelledby="connector-${name}"]`,
  )!;

afterEach(async () => {
  await act(async () => cleanup.splice(0).forEach((dispose) => dispose()));
  setWire(undefined);
  document.body.innerHTML = "";
  rstest.useRealTimers();
  rstest.clearAllMocks();
  rstest.restoreAllMocks();
});

describe("the gateway's accounts on the model services page", () => {
  it("lists accounts per connector with their state, plan and quota windows", async () => {
    const soon = new Date(Date.now() + 90 * 60_000).toISOString();
    await render({
      connections: [
        connection({ id: "c1", connector: "codex", plan: "plus" }),
        connection({
          id: "x1",
          connector: "xai",
          label: "grok@example.com",
          state: "needs_login",
          error: { code: "AUTH_EXPIRED", message: "登录已失效，请重新登录。" },
        }),
      ],
      quota: [
        {
          connectionId: "c1",
          plan: "Plus",
          windows: [
            { kind: "5h", used: 25, resetsAt: soon },
            { kind: "weekly", used: 93 },
          ],
        },
      ],
    });
    const codex = section("codex");
    expect(codex.textContent).toContain("dev@example.com");
    expect(codex.textContent).toContain("正常");
    expect(codex.textContent).toContain("Plus");
    const meters = [...codex.querySelectorAll('[role="meter"]')];
    expect(meters.map((m) => m.getAttribute("aria-valuenow"))).toEqual([
      "75",
      "7",
    ]);
    // The nearly used-up window is marked, and the reset time is spoken.
    expect(meters[1]!.firstElementChild!.className).toContain("bg-destructive");
    expect(codex.textContent).toContain("剩余 75%");
    expect(codex.textContent).toContain("约 2 小时后重置");

    const grok = section("xai");
    expect(grok.textContent).toContain("需要重新登录");
    expect(grok.textContent).toContain("登录已失效，请重新登录。");
    expect(button(/重新登录/, grok)).toBeDefined();
    expect(section("gemini").textContent).toContain("尚未绑定账号");
    expect(button(/添加 API key/, section("gemini"))).toBeDefined();
  });

  it("shows nothing about subscriptions on a host without the gateway", async () => {
    await render({ without: true });
    expect(text()).not.toContain("订阅与密钥");
    expect(
      document.querySelector("section[aria-labelledby^=connector-]"),
    ).toBeNull();
  });

  it("links a subscription with a device code and closes when it is done", async () => {
    const login: LlmLogin = {
      id: "codex-1",
      connector: "codex",
      flow: "oauth_device",
      status: "pending",
      url: "https://auth.openai.com/codex/device",
      userCode: "ABCD-1234",
      expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    };
    let status: LlmLogin["status"] = "pending";
    rstest.useFakeTimers();
    const host = (await render())
      .handle("llm.loginStart", () => ({ login }))
      .handle("llm.loginPoll", () => ({ login: { ...login, status } }))
      .handle("llm.loginCancel", () => ({}));
    await press(/绑定账号/, section("codex"));
    await act(async () => {
      await rstest.advanceTimersByTimeAsync(0);
    });
    expect(host.calls.find((c) => c.action === "loginStart")?.args).toEqual({
      connector: "codex",
    });
    expect(text()).toContain("ABCD-1234");
    expect(
      document.querySelector("a[href^='https://auth.openai.com']"),
    ).not.toBeNull();

    // Still pending after a poll; then it succeeds.
    await act(async () => {
      await rstest.advanceTimersByTimeAsync(1500);
    });
    status = "succeeded";
    await act(async () => {
      await rstest.advanceTimersByTimeAsync(1500);
    });
    await act(async () => {
      await rstest.advanceTimersByTimeAsync(10);
    });
    expect(toast.success).toHaveBeenCalledWith("已绑定 Codex 账号");
    expect(document.querySelector("[role=dialog]")).toBeNull();
  });

  it("cancels a pending login when the dialog is dismissed", async () => {
    const login: LlmLogin = {
      id: "xai-1",
      connector: "xai",
      flow: "oauth_device",
      status: "pending",
      url: "https://x.ai/device",
      userCode: "ZZZZ",
      expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    };
    const host = (await render())
      .handle("llm.loginStart", () => ({ login }))
      .handle("llm.loginPoll", () => ({ login }))
      .handle("llm.loginCancel", () => ({}));
    await press(/绑定账号/, section("xai"));
    await settle();
    await act(async () => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    await settle();
    expect(
      host.calls.some(
        (c) =>
          c.action === "loginCancel" &&
          (c.args as { id: string }).id === "xai-1",
      ),
    ).toBe(true);
  });

  it("takes a Google AI Studio key, checked by the gateway, and says why it is refused", async () => {
    const login: LlmLogin = {
      id: "gemini-1",
      connector: "gemini",
      flow: "api_key",
      status: "pending",
      expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    };
    let accept = false;
    const host = (await render())
      .handle("llm.loginStart", () => ({ login }))
      .handle("llm.loginSubmit", () => {
        if (!accept) throw new Error("API key 无效，请检查后重新填写。");
        return { login: { ...login, status: "succeeded" } };
      });
    await press(/添加 API key/, section("gemini"));
    await settle();
    const input = document.querySelector<HTMLInputElement>(
      "input[type=password]",
    )!;
    const type = async (value: string) => {
      const set = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!;
      await act(async () => {
        set.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
    };
    await type("AIza-wrong");
    await press(/校验并保存/);
    await settle();
    expect(text()).toContain("API key 无效，请检查后重新填写。");
    expect(document.querySelector("[role=dialog]")).not.toBeNull();

    accept = true;
    await type("AIza-right");
    await press(/校验并保存/);
    await settle();
    const submits = host.calls.filter((c) => c.action === "loginSubmit");
    expect(submits.at(-1)?.args).toEqual({
      id: "gemini-1",
      apiKey: "AIza-right",
    });
    expect(toast.success).toHaveBeenCalled();
    expect(document.querySelector("[role=dialog]")).toBeNull();
  });

  it("disables and removes an account, warning which agents lose their model", async () => {
    const host = await render({
      connections: [connection({ id: "c1", connector: "codex" })],
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
    host.handle("llm.setEnabled", () => ({})).handle("llm.remove", () => ({}));
    const open = async () => {
      const trigger = section("codex").querySelector<HTMLElement>(
        '[aria-haspopup="menu"]',
      )!;
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
      ].find((i) => name.test(i.textContent ?? ""))!;
      await act(async () => item.click());
    };
    await open();
    await choose(/停用/);
    await settle();
    expect(host.calls.find((c) => c.action === "setEnabled")?.args).toEqual({
      id: "c1",
      enabled: false,
    });
    await open();
    await choose(/移除/);
    await settle();
    // The agent on llm:gpt-5 loses its model with the last usable account.
    expect(text()).toContain("「小助手」");
    await press(/^移除$/, document.querySelector("[role=alertdialog]")!);
    await settle();
    expect(host.calls.find((c) => c.action === "remove")?.args).toEqual({
      id: "c1",
    });
  });

  it("offers the gateway's models by connector, naming why one cannot be used", () => {
    const names = new Map(connectors.map((c) => [c.id, c.name]));
    const models = gatewayModels(
      [
        {
          id: "gpt-5",
          connector: "codex",
          name: "GPT-5",
          status: "available",
          available: true,
        },
        {
          id: "grok-4",
          connector: "xai",
          name: "Grok 4",
          status: "unavailable",
          available: false,
          reason: {
            code: "AUTH_EXPIRED",
            message: "Grok 账号登录已失效，请重新登录。",
          },
        },
      ],
      names,
    );
    expect(models.map((m) => [m.id, m.providerName, m.available])).toEqual([
      ["llm:gpt-5", "Codex", true],
      ["llm:grok-4", "Grok", false],
    ]);
    expect(models[1]!.unavailableReason).toBe(
      "Grok 账号登录已失效，请重新登录。",
    );
  });
});
