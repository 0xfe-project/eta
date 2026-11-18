import type { McpServerView } from "@eta/client-contracts";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setWire } from "@/lib/wire";
import { buildProductHost } from "@/test-product";
import { cleanup, click, flush, mount } from "@/test-render";
import { McpSettings } from "./mcp-settings";

const toasts = vi.hoisted(() => ({
  message: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}));
vi.mock("sonner", () => ({
  toast: Object.assign(toasts.message, {
    success: toasts.success,
    error: toasts.error,
  }),
}));

afterEach(async () => {
  await cleanup();
  setWire(undefined);
  vi.restoreAllMocks();
  toasts.message.mockClear();
  toasts.success.mockClear();
  toasts.error.mockClear();
});

const text = () => document.body.textContent ?? "";

async function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(input),
    "value",
  )?.set;
  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const submit = async (form: Element) => {
  await act(async () => {
    form.dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    );
  });
  await flush();
};

const server = (
  fields: Partial<McpServerView> & { server: string },
): McpServerView => ({
  agentId: "a1",
  agentName: "Ada",
  source: "~/.eta/mcp.json",
  transport: "stdio",
  lifecycle: "lazy",
  state: "not-connected",
  toolCount: 0,
  error: null,
  auth: "none",
  overriddenBy: null,
  overrides: null,
  ...fields,
});

function host(list: McpServerView[]) {
  const fake = buildProductHost({}, ["mcp"]).target("mcp", { list });
  fake.install();
  fake.hello();
  return fake;
}

/** `window.open`, recorded: the tab a sign-in opens. */
function stubTab() {
  const tab = {
    opener: "set" as unknown,
    location: { href: "" },
    close: vi.fn(),
  };
  const open = vi.spyOn(window, "open").mockReturnValue(tab as never);
  return { tab, open };
}

const label = (name: string) =>
  document.querySelector<HTMLElement>(`button[aria-label="${name}"]`);

describe("MCP 服务器设置", () => {
  it("groups servers by agent and by where they are declared, with state, tools and the last error", async () => {
    host([
      server({
        server: "github",
        state: "connected",
        toolCount: 12,
        lifecycle: "keep-alive",
      }),
      server({
        server: "files",
        source: "~/.eta/mcp.json",
        state: "failed",
        error: "spawn ENOENT",
      }),
      server({
        agentId: "a2",
        agentName: "Bob",
        server: "docs",
        source: ".mcp.json",
        transport: "http",
        state: "not-connected",
        toolCount: 1,
      }),
    ]);
    await mount(<McpSettings />);
    await flush();
    expect(
      [...document.querySelectorAll("section[aria-label]")].map((section) =>
        section.getAttribute("aria-label"),
      ),
    ).toEqual(["Ada", "Bob"]);
    expect(text()).toContain("~/.eta/mcp.json");
    expect(text()).toContain(".mcp.json");
    expect(text()).toContain("已连接");
    expect(text()).toContain("12 个工具");
    expect(text()).toContain("stdio · keep-alive");
    expect(text()).toContain("HTTP · lazy");
    expect(text()).toContain("失败");
    expect(text()).toContain("spawn ENOENT");
    expect(text()).toContain("空闲");
    // A server with no sign-in has no sign-in controls.
    expect(label("登录 github")).toBeNull();
    expect(label("退出登录 github")).toBeNull();
  });

  it("keeps an overridden plugin server under its plugin, says what replaced it, and offers nothing on it", async () => {
    host([
      server({
        server: "notion-mcp",
        source: "plugin:notion",
        transport: "http",
        overriddenBy: { source: "~/.eta/mcp.json", name: "notion-mcp" },
      }),
      server({
        server: "notion-mcp",
        source: "~/.eta/mcp.json",
        state: "connected",
        toolCount: 12,
        overrides: "plugin:notion",
      }),
    ]);
    await mount(<McpSettings />);
    await flush();
    const plugin = document.querySelector(
      'ul[aria-label="Ada plugin:notion"]',
    )!;
    expect(plugin.textContent).toContain("被 ~/.eta/mcp.json 覆盖");
    expect(plugin.textContent).toContain(
      "这个插件服务器不会启动，用的是 ~/.eta/mcp.json 里的同名服务器。",
    );
    expect(plugin.querySelectorAll("button")).toHaveLength(0);
    const user = document.querySelector(
      'ul[aria-label="Ada ~/.eta/mcp.json"]',
    )!;
    expect(user.textContent).toContain("12 个工具 · 覆盖了 plugin:notion");
    // Only the server that is used can be connected.
    expect(
      document.querySelectorAll('button[aria-label="重新连接 notion-mcp"]'),
    ).toHaveLength(1);
  });

  it("shows a server that failed with a 401 and has no sign-in as failed, with no sign-in button", async () => {
    host([
      server({
        server: "linear-api",
        source: "plugin:linear",
        transport: "http",
        state: "failed",
        error:
          "HTTP 401: the server rejected the request; it is declared auth: false, so eta does not try to sign in",
      }),
    ]);
    await mount(<McpSettings />);
    await flush();
    expect(text()).toContain("失败");
    expect(text()).toContain("HTTP 401");
    expect(text()).not.toContain("未登录");
    expect(label("登录 linear-api")).toBeNull();
    expect(label("连接 linear-api")).not.toBeNull();
  });

  it("says when there are no servers", async () => {
    host([]);
    await mount(<McpSettings />);
    await flush();
    expect(text()).toContain("没有 MCP 服务器");
  });

  it("connects a server, and reconnects one that is up, reporting the outcome", async () => {
    const fake = host([
      server({ server: "idle" }),
      server({ server: "up", state: "connected", toolCount: 2 }),
    ]);
    fake.handle("mcp.connect", () => ({ ok: true, message: null }));
    fake.handle("mcp.reconnect", () => ({ ok: false, message: "boom" }));
    await mount(<McpSettings />);
    await flush();

    await click(label("连接 idle"));
    expect(fake.calls.at(-1)).toMatchObject({
      target: "mcp",
      action: "connect",
      args: { agentId: "a1", server: "idle" },
    });
    expect(toasts.success).toHaveBeenCalledWith("idle 已连接");

    await click(label("重新连接 up"));
    expect(fake.calls.at(-1)).toMatchObject({
      action: "reconnect",
      args: { agentId: "a1", server: "up" },
    });
    expect(toasts.error).toHaveBeenCalledWith("up：boom");
  });

  it("signs in: opens the provider in a new tab, and finishes from a pasted redirect URL", async () => {
    const { tab, open } = stubTab();
    const fake = host([
      server({ server: "remote", transport: "http", auth: "needs_login" }),
    ]);
    fake.handle("mcp.login", () => ({
      pendingId: "p1",
      authorizationUrl: "https://auth.example/authorize?state=p1",
    }));
    fake.handle("mcp.completeLogin", () => ({ ok: true }));
    await mount(<McpSettings />);
    await flush();
    expect(text()).toContain("未登录");

    await click(label("登录 remote"));
    expect(open).toHaveBeenCalledWith("about:blank", "_blank");
    // The tab is cut loose from this page, then pointed at the provider.
    expect(tab.opener).toBeNull();
    expect(tab.location.href).toBe("https://auth.example/authorize?state=p1");
    expect(fake.calls.at(-1)).toMatchObject({
      action: "login",
      args: {
        agentId: "a1",
        server: "remote",
        redirectOrigin: window.location.origin,
      },
    });

    const redirect = document.querySelector<HTMLInputElement>(
      '[role=dialog] input[aria-label="重定向地址"]',
    )!;
    await type(
      redirect,
      " https://eta.example/mcp/oauth/callback?code=c&state=p1 ",
    );
    await submit(document.querySelector("[role=dialog] form")!);
    expect(fake.calls.at(-1)).toMatchObject({
      action: "completeLogin",
      args: {
        pendingId: "p1",
        callbackUrl: "https://eta.example/mcp/oauth/callback?code=c&state=p1",
      },
    });
    expect(toasts.success).toHaveBeenCalledWith("已登录 remote");
  });

  it("closes the sign-in dialog by itself when the callback signs the server in", async () => {
    stubTab();
    const fake = host([
      server({ server: "remote", transport: "http", auth: "needs_login" }),
    ]);
    fake.handle("mcp.login", () => ({
      pendingId: "p1",
      authorizationUrl: "https://auth.example/authorize",
    }));
    await mount(<McpSettings />);
    await flush();
    await click(label("登录 remote"));
    expect(document.querySelector("[role=dialog]")).not.toBeNull();

    await act(async () => {
      fake.set("mcp", {
        list: [
          server({ server: "remote", transport: "http", auth: "signed_in" }),
        ],
      });
    });
    await flush();
    expect(document.querySelector("[role=dialog]")).toBeNull();
    expect(text()).toContain("已登录");
  });

  it("shows the host's refusal to start a sign-in, and closes the tab it opened", async () => {
    const { tab } = stubTab();
    const fake = host([
      server({ server: "remote", transport: "http", auth: "needs_login" }),
    ]);
    fake.handle("mcp.login", () => {
      throw new Error("start the host with --public-url");
    });
    await mount(<McpSettings />);
    await flush();
    await click(label("登录 remote"));
    expect(toasts.error).toHaveBeenCalledWith(
      "start the host with --public-url",
    );
    expect(tab.close).toHaveBeenCalled();
    expect(document.querySelector("[role=dialog]")).toBeNull();
  });

  it("signs out after asking", async () => {
    const fake = host([
      server({ server: "remote", transport: "http", auth: "signed_in" }),
    ]);
    fake.handle("mcp.logout", () => ({}));
    await mount(<McpSettings />);
    await flush();
    expect(text()).toContain("已登录");
    await click(label("退出登录 remote"));
    expect(fake.calls.filter((call) => call.action === "logout")).toEqual([]);
    await click(
      [...document.querySelectorAll("[role=alertdialog] button")].find(
        (b) => b.textContent === "退出登录",
      ),
    );
    expect(fake.calls.at(-1)).toMatchObject({
      target: "mcp",
      action: "logout",
      args: { agentId: "a1", server: "remote" },
    });
  });
});
