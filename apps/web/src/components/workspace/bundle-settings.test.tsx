import type { BundleView } from "@eta/client-contracts";
import { afterEach, describe, expect, it, rstest } from "@rstest/core";
import { act } from "react";
import { setWire } from "@/lib/wire";
import { buildProductHost } from "@/test-product";
import { button, cleanup, click, flush, mount } from "@/test-render";
import { BundleSettings } from "./bundle-settings";

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

const bundle = (
  fields: Partial<BundleView> & { name: string },
): BundleView => ({
  description: "",
  source: { kind: "builtin" },
  sha: null,
  requires: [],
  skills: [],
  mcpServers: [],
  hooks: false,
  fields: [],
  configured: true,
  service: null,
  machines: [],
  problem: null,
  ...fields,
});

const token = {
  name: "TOKEN",
  title: "访问令牌",
  description: "在 [控制台](https://example.com) 生成",
  secret: true,
  required: true,
  maxLength: 100,
  set: false,
  value: null,
};
const region = {
  name: "REGION",
  title: "区域",
  description: "",
  secret: false,
  required: false,
  maxLength: 20,
  set: true,
  value: "eu",
};

function host(list: BundleView[]) {
  const fake = buildProductHost({}, ["bundles"]).target("bundles", { list });
  fake.install();
  fake.hello();
  return fake;
}

describe("环境包设置", () => {
  it("shows where each bundle came from, whether it is set up and what its machines lack", async () => {
    host([
      bundle({
        name: "github",
        description: "GitHub 的 gh 和 MCP",
        requires: ["gh", "github-mcp-server"],
        skills: ["github"],
        mcpServers: ["github"],
        fields: [token],
        configured: false,
        machines: [
          {
            machineId: "m1",
            name: "主机",
            ready: false,
            missing: ["github-mcp-server"],
            checked: true,
          },
          {
            machineId: "m2",
            name: "笔记本",
            ready: false,
            missing: [],
            checked: false,
          },
        ],
      }),
      bundle({
        name: "mine",
        source: {
          kind: "git",
          repo: "https://example.com/r.git",
          rev: "main",
          path: "b",
        },
        sha: "0123456789abcdef0123456789abcdef01234567",
        hooks: true,
        service: { state: "error", message: "boom" },
      }),
      bundle({ name: "broken", problem: "plugin.json is missing" }),
    ]);
    await mount(<BundleSettings />);
    await flush();
    expect(text()).toContain("内置");
    expect(text()).toContain("未配置");
    expect(text()).toContain("需要命令：gh, github-mcp-server");
    expect(text()).toContain("主机 缺少 github-mcp-server");
    // A machine that could not be asked is the machines section's to show, not every bundle's.
    expect(text()).not.toContain("笔记本");
    expect(text()).toContain("git · 0123456");
    expect(text()).toContain("服务出错: boom");
    expect(text()).toContain("plugin.json is missing");
    expect(text()).toContain("无法使用");
  });

  it("offers an update and a removal for git sources only", async () => {
    host([
      bundle({ name: "github" }),
      bundle({
        name: "mine",
        source: { kind: "git", repo: "r", rev: "main", path: "" },
        sha: "a".repeat(40),
      }),
    ]);
    await mount(<BundleSettings />);
    await flush();
    const label = (name: string) =>
      document.querySelector(`button[aria-label="${name}"]`);
    expect(label("更新 mine")).not.toBeNull();
    expect(label("移除 mine")).not.toBeNull();
    expect(label("更新 github")).toBeNull();
    expect(label("移除 github")).toBeNull();
    // And no form for a bundle with nothing to set.
    expect(label("设置 github")).toBeNull();
  });

  it("sends only what was typed, and never shows a secret that is set", async () => {
    const fake = host([
      bundle({
        name: "github",
        fields: [{ ...token, set: true }, region],
        configured: true,
      }),
    ]);
    fake.handle("bundles.configure", () => ({ name: "github" }));
    await mount(<BundleSettings />);
    await flush();
    await click(document.querySelector('button[aria-label="设置 github"]'));
    const secret = document.querySelector<HTMLInputElement>(
      '[role=dialog] input[type="password"]',
    )!;
    expect(secret.type).toBe("password");
    expect(secret.value).toBe("");
    expect(secret.placeholder).toBe("已设置；留空则保持不变");
    const plain = document.querySelector<HTMLInputElement>(
      '[role=dialog] input[type="text"]',
    )!;
    expect(plain.value).toBe("eu");

    // Nothing typed: nothing sent but what changed.
    await type(plain, "us");
    await submit(document.querySelector("[role=dialog] form")!);
    expect(fake.calls.at(-1)).toMatchObject({
      target: "bundles",
      action: "configure",
      args: { name: "github", values: { REGION: "us" } },
    });
    expect(toasts.success).toHaveBeenCalledWith("已保存");
  });

  it("writes a typed secret, says so when a required value is still missing, and clears a value emptied", async () => {
    const fake = host([
      bundle({ name: "github", fields: [token, region], configured: false }),
    ]);
    fake.handle("bundles.configure", () => ({ name: "github" }));
    await mount(<BundleSettings />);
    await flush();
    await click(document.querySelector('button[aria-label="设置 github"]'));
    await submit(document.querySelector("[role=dialog] form")!);
    expect(toasts.success).toHaveBeenCalledWith("已保存，还有必填项没填");

    await click(document.querySelector('button[aria-label="设置 github"]'));
    await type(
      document.querySelector<HTMLInputElement>(
        '[role=dialog] input[type="password"]',
      )!,
      " tok-1 ",
    );
    await type(
      document.querySelector<HTMLInputElement>(
        '[role=dialog] input[type="text"]',
      )!,
      "",
    );
    await submit(document.querySelector("[role=dialog] form")!);
    expect(fake.calls.at(-1)).toMatchObject({
      args: { name: "github", values: { TOKEN: "tok-1", REGION: null } },
    });
    // The page never held the secret it was given.
    expect(text()).not.toContain("tok-1");
  });

  it("clears all of a bundle's values after asking", async () => {
    const fake = host([
      bundle({
        name: "github",
        fields: [{ ...token, set: true }, region],
      }),
    ]);
    fake.handle("bundles.configure", () => ({ name: "github" }));
    await mount(<BundleSettings />);
    await flush();
    await click(document.querySelector('button[aria-label="设置 github"]'));
    await click(button(document.body, "清除全部"));
    expect(fake.calls.filter((call) => call.action === "configure")).toEqual(
      [],
    );
    await click(
      [...document.querySelectorAll("[role=alertdialog] button")].find(
        (b) => b.textContent === "清除",
      ),
    );
    expect(fake.calls.at(-1)).toMatchObject({
      args: { name: "github", values: { TOKEN: null, REGION: null } },
    });
  });

  it("adds a bundle from git, leaving out what was not filled in", async () => {
    const fake = host([]);
    fake.handle("bundles.add", () => ({ name: "extra" }));
    await mount(<BundleSettings />);
    await flush();
    expect(text()).toContain("没有环境包");
    await click(button(document.body, "从 git 添加"));
    const fields = [
      ...document.querySelectorAll<HTMLInputElement>("[role=dialog] input"),
    ];
    await type(fields[0]!, " https://example.com/r.git ");
    await type(fields[1]!, "v1");
    await submit(document.querySelector("[role=dialog] form")!);
    expect(fake.calls.at(-1)).toMatchObject({
      target: "bundles",
      action: "add",
      args: { repo: "https://example.com/r.git", rev: "v1" },
    });
    expect(
      (fake.calls.at(-1)!.args as Record<string, unknown>).path,
    ).toBeUndefined();
    expect(toasts.success).toHaveBeenCalledWith("已添加 extra");
  });

  it("shows the host's refusal as it is", async () => {
    const fake = host([]);
    fake.handle("bundles.add", () => {
      throw new Error("there is already a bundle called github");
    });
    await mount(<BundleSettings />);
    await flush();
    await click(button(document.body, "从 git 添加"));
    await type(
      document.querySelector<HTMLInputElement>("[role=dialog] input")!,
      "r",
    );
    await submit(document.querySelector("[role=dialog] form")!);
    expect(toasts.error).toHaveBeenCalledWith(
      "there is already a bundle called github",
    );
  });

  it("updates one git bundle, or all of them", async () => {
    const fake = host([
      bundle({
        name: "mine",
        source: { kind: "git", repo: "r", rev: "main", path: "" },
        sha: "a".repeat(40),
      }),
    ]);
    fake.handle("bundles.refresh", () => ({ names: ["mine"] }));
    await mount(<BundleSettings />);
    await flush();
    await click(document.querySelector('button[aria-label="更新 mine"]'));
    expect(fake.calls.at(-1)).toMatchObject({
      action: "refresh",
      args: { name: "mine" },
    });
    await click(button(document.body, "更新全部 git 来源"));
    expect(fake.calls.at(-1)).toMatchObject({ action: "refresh", args: {} });
    expect(toasts.message).toHaveBeenCalledWith("已更新 mine");
  });

  it("asks the host to look at the machines again", async () => {
    const fake = host([bundle({ name: "github" })]);
    fake.handle("bundles.recheck", () => ({}));
    await mount(<BundleSettings />);
    await flush();
    await click(document.querySelector('button[aria-label="重新检查机器"]'));
    expect(fake.calls.at(-1)).toMatchObject({
      target: "bundles",
      action: "recheck",
    });
  });
});
