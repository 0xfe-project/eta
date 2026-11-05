/* eslint-disable no-template-curly-in-string -- `${PLUGIN_ROOT}` and `${PLUGIN_DATA}` are the spec's literal placeholders */
import type {
  PluginAuditView,
  PluginFieldView,
  PluginView,
} from "@eta/client-contracts";
import { afterEach, describe, expect, it, rstest } from "@rstest/core";
import { act } from "react";
import { setWire } from "@/lib/wire";
import { buildProductHost } from "@/test-product";
import { cleanup, click, flush, mount } from "@/test-render";
import { PluginSettings } from "./plugin-settings";

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
  toasts.success.mockClear();
  toasts.error.mockClear();
});

const text = () => document.body.textContent ?? "";

const secret: PluginFieldView = {
  name: "api_key",
  title: "API key",
  description: "",
  required: true,
  secret: true,
  agent: "value",
  type: "string",
  pattern: "^sk-[a-z]+$",
  set: false,
  value: null,
  level: "value",
  levels: ["none", "file", "value"],
  issue: { field: "api_key", code: "required" },
};
const team: PluginFieldView = {
  name: "team",
  title: "Team",
  description: "",
  required: false,
  secret: false,
  agent: "read",
  type: "string",
  set: true,
  value: "ops",
  level: "read",
  levels: ["none", "read"],
  issue: null,
};

const plugin = (fields: Partial<PluginView> = {}): PluginView => ({
  name: "hello",
  version: "1.0.0",
  description: "Says hello.",
  source: { kind: "local", path: "/h/.eta/plugins/hello" },
  state: "needs_config",
  problem: null,
  reports: [],
  skills: [{ name: "greet", description: "Greets." }],
  servers: [
    {
      name: "hello",
      transport: "stdio",
      command: ["node", "${PLUGIN_ROOT}/server.mjs"],
      env: ["HELLO_KEY"],
      headers: [],
      problem: null,
    },
  ],
  requires: ["node"],
  machines: [],
  fields: [secret, team],
  agents: [],
  ...fields,
});

function host(plugins: PluginView[], audit: PluginAuditView[] = []) {
  const fake = buildProductHost({}, ["plugins"]).target("plugins", {
    list: plugins,
    audit,
  });
  fake.install();
  fake.hello();
  return fake;
}

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

const open = async (container: HTMLElement) => {
  await flush();
  await click(container.querySelector('[aria-label="配置 hello"]'));
  await flush();
};

const save = () =>
  [...document.querySelectorAll("button")].find(
    (element) => element.textContent === "保存",
  )!;

const passwordInput = () =>
  document.querySelector<HTMLInputElement>('input[type="password"]')!;

describe("the plugin list", () => {
  it("shows where a plugin came from, how it stands and what it lacks", async () => {
    host([
      plugin({
        machines: [
          { machineId: "m", name: "gpu-box", missing: ["node"], checked: true },
        ],
        reports: ["plugin.json: unknown field hooks was ignored"],
      }),
      plugin({
        name: "from-git",
        state: "ready",
        fields: [],
        source: {
          kind: "git",
          repo: "https://example.com/x.git",
          rev: "main",
          path: "",
          sha: "abcdef1234567890abcdef1234567890abcdef12",
        },
      }),
    ]);
    await mount(<PluginSettings />);
    await flush();
    expect(text()).toContain("待配置");
    expect(text()).toContain("可启用");
    expect(text()).toContain("本地目录");
    expect(text()).toContain("https://example.com/x.git @ abcdef123456");
    expect(text()).toContain("gpu-box 上缺少 node");
    expect(text()).toContain("unknown field hooks");
  });

  it("says which agents skip a plugin that fell back", async () => {
    host([plugin({ agents: [{ id: "a", name: "Ada" }] })]);
    await mount(<PluginSettings />);
    await flush();
    expect(text()).toContain("Ada 启用了它，但配置不再合法");
  });

  it("shows why a plugin was rejected, and no form", async () => {
    host([plugin({ problem: "plugin.json: unsupported $schema", fields: [] })]);
    const { container } = await mount(<PluginSettings />);
    await flush();
    expect(text()).toContain("unsupported $schema");
    expect(container.querySelector('[aria-label="配置 hello"]')).toBeNull();
  });

  it("shows who read what, and when", async () => {
    host(
      [plugin()],
      [
        {
          id: 1,
          at: 1_700_000_000_000,
          sessionId: "s-1",
          agentId: "a",
          agentName: "Ada",
          plugin: "hello",
          field: "api_key",
          level: "file",
        },
      ],
    );
    await mount(<PluginSettings />);
    await flush();
    expect(text()).toContain("智能体读取记录");
    expect(text()).toContain("hello.api_key");
    expect(text()).toContain("s-1");
  });

  it("explains what to do when there are none", async () => {
    host([]);
    await mount(<PluginSettings />);
    await flush();
    expect(text()).toContain("~/.eta/plugins/");
  });
});

describe("the form", () => {
  it("draws a password box for a secret, and shows what will run", async () => {
    host([plugin()]);
    const { container } = await mount(<PluginSettings />);
    await open(container);
    expect(passwordInput()).not.toBeNull();
    expect(text()).toContain("node ${PLUGIN_ROOT}/server.mjs");
    expect(text()).toContain("HELLO_KEY");
    expect(text()).toContain("自带内核暂不支持 MCP");
    expect(text()).toContain("智能体访问");
  });

  it("will not save what does not fit", async () => {
    const built = host([plugin()]);
    const { container } = await mount(<PluginSettings />);
    await open(container);
    await type(passwordInput(), "wrong");
    await flush();
    expect(text()).toContain("不符合要求的格式");
    expect(save().hasAttribute("disabled")).toBe(true);
    expect(built.calls).toEqual([]);
  });

  it("saves what changed, and a blank secret is left out", async () => {
    const built = host([plugin({ fields: [{ ...secret, set: true }, team] })]);
    built.handle("plugins.configure", () => ({
      name: "hello",
      state: "ready",
      issues: [],
    }));
    const { container } = await mount(<PluginSettings />);
    await open(container);
    const inputs = [...document.querySelectorAll<HTMLInputElement>("input")];
    await type(inputs.find((input) => input.value === "ops")!, "dev");
    await flush();
    await click(save());
    await flush();
    expect(built.calls.at(-1)).toMatchObject({
      target: "plugins",
      action: "configure",
      args: { name: "hello", values: { team: "dev" } },
    });
    expect(toasts.success).toHaveBeenCalledWith("已保存，插件可启用");
  });

  it("saves while something required is missing, and says it still is", async () => {
    const built = host([plugin()]);
    built.handle("plugins.configure", () => ({
      name: "hello",
      state: "needs_config",
      issues: [{ field: "api_key", code: "required" }],
    }));
    const { container } = await mount(<PluginSettings />);
    await open(container);
    expect(text()).toContain("还有必填项");
    await click(save());
    await flush();
    expect(toasts.success).toHaveBeenCalledWith("已保存，仍是待配置");
  });

  it("never puts a saved secret's value in a control", async () => {
    host([plugin({ fields: [{ ...secret, set: true }] })]);
    const { container } = await mount(<PluginSettings />);
    await open(container);
    expect(passwordInput().value).toBe("");
    expect(passwordInput().placeholder).toContain("留空表示不改");
    expect(text()).toContain("已设置");
  });

  it("offers a secret's levels, up to what the manifest declares", async () => {
    host([plugin()]);
    const { container } = await mount(<PluginSettings />);
    await open(container);
    const trigger = document.querySelector('[role="combobox"]');
    expect(trigger?.textContent).toContain("明文");
  });
});
