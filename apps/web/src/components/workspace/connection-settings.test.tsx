import type {
  GitHubInstallationView,
  GitHubStatus,
} from "@eta/client-contracts";
import { afterEach, describe, expect, it, rstest } from "@rstest/core";
import { act } from "react";
import { setWire } from "@/lib/wire";
import { buildProductHost } from "@/test-product";
import { button, cleanup, click, flush, mount } from "@/test-render";
import { ConnectionSettings } from "./connection-settings";

// Settings → 连接 and the GitHub wizard: where the connection stands decides the step; the page
// reads and writes only the wire; GitHub's returns are in the address.

const toasts = rstest.hoisted(() => ({
  message: rstest.fn(),
  success: rstest.fn(),
  error: rstest.fn(),
}));
rstest.mock("sonner", () => ({
  toast: Object.assign(toasts.message, {
    success: toasts.success,
    error: toasts.error,
  }),
}));

afterEach(async () => {
  await cleanup();
  setWire(undefined);
  rstest.restoreAllMocks();
  toasts.message.mockClear();
  toasts.success.mockClear();
  toasts.error.mockClear();
  window.history.replaceState(null, "", "/");
});

const app = {
  name: "eta-test",
  slug: "eta-test",
  owner: "akarachen",
  ownerType: "User",
  htmlUrl: "https://github.com/apps/eta-test",
  settingsUrl: "https://github.com/settings/apps/eta-test",
  installUrl: "https://github.com/apps/eta-test/installations/new",
};

const installation = (
  fields: Partial<GitHubInstallationView> = {},
): GitHubInstallationView => ({
  id: 100,
  account: "akarachen",
  accountType: "User",
  repositorySelection: "selected",
  repositories: ["akarachen/axp", "akarachen/notes"],
  totalRepositories: 2,
  manageUrl: "https://github.com/settings/installations/100",
  ...fields,
});

const status = (fields: Partial<GitHubStatus> = {}): GitHubStatus => ({
  state: "not_connected",
  app: null,
  installations: [],
  error: null,
  user: null,
  oauth: false,
  checked: true,
  ...fields,
});

function host(
  state: GitHubStatus,
  handlers: Record<string, (args: unknown) => unknown> = {},
) {
  const fake = buildProductHost({}, ["github"]).target("github", {
    state,
    pulls: [],
  });
  fake.handle("github.refresh", () => state);
  for (const [op, handler] of Object.entries(handlers))
    fake.handle(op, handler);
  fake.install();
  fake.hello();
  return fake;
}

const text = () => document.body.textContent ?? "";
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')!;
const label = (name: string) =>
  document.querySelector<HTMLElement>(`[aria-label="${name}"]`);

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
  await flush(20);
};

/** The form the page posts to GitHub, captured instead of submitted. */
function captureForm() {
  const posted: { action: string; manifest: string }[] = [];
  rstest
    .spyOn(HTMLFormElement.prototype, "submit")
    .mockImplementation(function (this: HTMLFormElement) {
      posted.push({
        action: this.action,
        manifest: this.querySelector("input")!.value,
      });
    });
  return posted;
}

describe("Settings → 连接", () => {
  it("shows the GitHub connection and what is left to do", async () => {
    host(status());
    const { container } = await mount(<ConnectionSettings />);
    await flush();
    expect(container.textContent).toContain("连接");
    expect(container.textContent).toContain("GitHub");
    expect(container.textContent).toContain("未连接");
    expect(label("开始连接 GitHub")).not.toBeNull();
  });

  it("says who agents act as once it is connected", async () => {
    host(
      status({
        state: "ready",
        app,
        installations: [installation()],
      }),
    );
    const { container } = await mount(<ConnectionSettings />);
    await flush();
    expect(container.textContent).toContain("eta-test[bot]");
    expect(label("管理 GitHub")).not.toBeNull();
  });

  it("names the user when they authorized the App", async () => {
    host(
      status({
        state: "ready",
        app,
        installations: [installation()],
        user: { login: "akarachen", htmlUrl: "https://github.com/akarachen" },
        oauth: true,
      }),
    );
    const { container } = await mount(<ConnectionSettings />);
    await flush();
    expect(container.textContent).toContain("akarachen");
  });

  it("asks for an installation while the App has none", async () => {
    host(status({ state: "not_installed", app }));
    const { container } = await mount(<ConnectionSettings />);
    await flush();
    expect(container.textContent).toContain("待安装");
  });

  it("shows what GitHub refused", async () => {
    host(
      status({
        state: "error",
        app,
        error: { code: "GITHUB_APP_GONE", message: "GitHub 不认这个 App 了" },
      }),
    );
    const { container } = await mount(<ConnectionSettings />);
    await flush();
    expect(container.textContent).toContain("GitHub 不认这个 App 了");
  });
});

describe("the wizard", () => {
  it("walks from the overview to creating the App, and posts GitHub the manifest", async () => {
    const posted = captureForm();
    const fake = host(status(), {
      "github.createApp": () => ({
        action: "https://github.com/settings/apps/new?state=s1",
        manifest: '{"name":"eta 1234"}',
      }),
    });
    await mount(<ConnectionSettings />);
    await flush();
    await click(label("开始连接 GitHub"));
    await flush();
    expect(text()).toContain("clone");
    expect(text()).toContain("了解");
    await click(button(dialog(), "开始连接"));
    await flush();
    // The second step: whose account, and the App's name.
    expect(text()).toContain("我的个人账号");
    await submit(document.querySelector("#github-create")!);
    const create = fake.calls.find((call) => call.action === "createApp")!;
    expect(create.args).toMatchObject({ origin: window.location.origin });
    expect((create.args as { name: string }).name).toMatch(/^eta [0-9a-f]{4}$/);
    expect(
      (create.args as { organization?: string }).organization,
    ).toBeUndefined();
    expect(posted).toEqual([
      {
        action: "https://github.com/settings/apps/new?state=s1",
        manifest: '{"name":"eta 1234"}',
      },
    ]);
  });

  it("creates the App under an organization, with the name the user gave", async () => {
    captureForm();
    const fake = host(status(), {
      "github.createApp": () => ({
        action: "https://github.com/x",
        manifest: "{}",
      }),
    });
    await mount(<ConnectionSettings />);
    await flush();
    await click(label("开始连接 GitHub"));
    await click(button(dialog(), "开始连接"));
    await flush();
    await click(
      [...document.querySelectorAll("label")].find((l) =>
        l.textContent?.includes("一个组织"),
      ),
    );
    await flush();
    await type(
      document.querySelector<HTMLInputElement>(
        'input[placeholder="例如 acme"]',
      )!,
      "acme",
    );
    await type(
      document.querySelector<HTMLInputElement>('input[maxlength="34"]')!,
      "My App",
    );
    await submit(document.querySelector("#github-create")!);
    expect(
      fake.calls.find((call) => call.action === "createApp")!.args,
    ).toMatchObject({ name: "My App", organization: "acme" });
  });

  it("tells the user to install the App, and asks GitHub again until they have", async () => {
    const fake = host(status({ state: "not_installed", app }));
    await mount(<ConnectionSettings />);
    await flush();
    await click(label("开始连接 GitHub") ?? label("管理 GitHub"));
    await flush();
    expect(text()).toContain("eta-test");
    const install = [...document.querySelectorAll("a")].find(
      (a) => a.getAttribute("href") === app.installUrl,
    );
    expect(install).not.toBeUndefined();
    // The status is read from GitHub when the page opens.
    expect(
      fake.calls.filter((call) => call.action === "refresh").length,
    ).toBeGreaterThan(0);
    await click(button(dialog(), "我已安装"));
    await flush();
    expect(
      fake.calls.filter(
        (call) =>
          call.action === "refresh" &&
          (call.args as { fresh?: boolean }).fresh === true,
      ).length,
    ).toBeGreaterThan(1);
  });

  it("lists where the App is installed and lets the user authorize it", async () => {
    const assign = rstest.fn();
    rstest.spyOn(window.location, "assign").mockImplementation(assign);
    const fake = host(
      status({
        state: "ready",
        app,
        installations: [
          installation(),
          installation({
            id: 101,
            account: "acme",
            accountType: "Organization",
            repositorySelection: "all",
            repositories: [],
            totalRepositories: 0,
          }),
        ],
        oauth: true,
      }),
      {
        "github.authorize": () => ({
          url: "https://github.com/login/oauth/authorize?x=1",
        }),
      },
    );
    await mount(<ConnectionSettings />);
    await flush();
    await click(label("管理 GitHub"));
    await flush();
    expect(text()).toContain("已连接");
    expect(text()).toContain("akarachen");
    expect(text()).toContain("acme");
    expect(text()).toContain("全部仓库");
    await click(button(dialog(), "前往 GitHub 授权"));
    await flush();
    expect(
      fake.calls.find((call) => call.action === "authorize")!.args,
    ).toEqual({ origin: window.location.origin });
    expect(assign).toHaveBeenCalledWith(
      "https://github.com/login/oauth/authorize?x=1",
    );
  });

  it("revokes the user's authorization", async () => {
    const fake = host(
      status({
        state: "ready",
        app,
        installations: [installation()],
        user: { login: "akarachen", htmlUrl: "https://github.com/akarachen" },
        oauth: true,
      }),
      { "github.unauthorize": () => ({}) },
    );
    await mount(<ConnectionSettings />);
    await flush();
    await click(label("管理 GitHub"));
    await flush();
    expect(text()).toContain("智能体的身份：akarachen");
    await click(button(dialog(), "取消授权"));
    await flush();
    expect(fake.calls.some((call) => call.action === "unauthorize")).toBe(true);
  });

  it("takes the client secret of an App created before the host kept it", async () => {
    const fake = host(
      status({
        state: "ready",
        app,
        installations: [installation()],
        oauth: false,
      }),
      { "github.setOAuthClient": () => ({}) },
    );
    await mount(<ConnectionSettings />);
    await flush();
    await click(label("管理 GitHub"));
    await flush();
    // The callback the user adds on the App's settings page is the host's.
    expect(text()).toContain(
      `${window.location.origin}/github/authorization/callback`,
    );
    const inputs = [
      ...document.querySelectorAll<HTMLInputElement>("form input[required]"),
    ];
    await type(inputs[0]!, " Iv1.abc ");
    await type(inputs[1]!, " secret ");
    await submit(inputs[0]!.closest("form")!);
    expect(
      fake.calls.find((call) => call.action === "setOAuthClient")!.args,
    ).toEqual({ clientId: "Iv1.abc", clientSecret: "secret" });
  });

  it("disconnects after asking, and offers to delete the App on GitHub", async () => {
    const fake = host(
      status({ state: "ready", app, installations: [installation()] }),
      { "github.disconnect": () => ({}) },
    );
    await mount(<ConnectionSettings />);
    await flush();
    await click(label("管理 GitHub"));
    await flush();
    await click(button(dialog(), "断开连接"));
    await flush();
    expect(text()).toContain("断开 GitHub？");
    expect(fake.calls.some((call) => call.action === "disconnect")).toBe(false);
    const confirm = button(
      document.querySelector<HTMLElement>('[role="alertdialog"]')!,
      "断开",
    );
    await click(confirm);
    await flush(20);
    expect(fake.calls.some((call) => call.action === "disconnect")).toBe(true);
    expect(toasts.success).toHaveBeenCalled();
  });
});

describe("coming back from GitHub", () => {
  it("reopens the wizard after the App was created, says so, and drops the parameters", async () => {
    window.history.replaceState(null, "", "/?github=created");
    host(status({ state: "not_installed", app }));
    await mount(<ConnectionSettings />);
    await flush();
    expect(toasts.success).toHaveBeenCalledWith("GitHub App 已创建");
    expect(window.location.search).toBe("");
    expect(text()).toContain("eta-test");
  });

  it("says the user's authorization was saved", async () => {
    window.history.replaceState(null, "", "/?github=authorized");
    host(status({ state: "ready", app, installations: [installation()] }));
    await mount(<ConnectionSettings />);
    await flush();
    expect(toasts.success).toHaveBeenCalledWith(
      "已授权，智能体将以你的名义使用 GitHub",
    );
  });

  it("says the App was installed", async () => {
    window.history.replaceState(null, "", "/?setup_action=install");
    host(status({ state: "ready", app, installations: [installation()] }));
    await mount(<ConnectionSettings />);
    await flush();
    expect(toasts.success).toHaveBeenCalledWith("已在 GitHub 上安装 App");
    expect(window.location.search).toBe("");
  });

  it("shows what went wrong and starts the wizard over at the form", async () => {
    window.history.replaceState(
      null,
      "",
      `/?github_error=${encodeURIComponent("这次创建已失效，请回到 eta 重新开始。")}`,
    );
    host(status());
    await mount(<ConnectionSettings />);
    await flush();
    expect(toasts.success).not.toHaveBeenCalled();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "这次创建已失效",
    );
    expect(document.querySelector("#github-create")).not.toBeNull();
    expect(window.location.search).toBe("");
  });
});
