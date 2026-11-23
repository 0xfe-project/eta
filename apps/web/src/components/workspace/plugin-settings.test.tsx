/* eslint-disable no-template-curly-in-string -- `${PLUGIN_ROOT}` and `${PLUGIN_DATA}` are the spec's literal placeholders */
import type {
  PluginAuditView,
  PluginFieldView,
  PluginView,
} from "@eta/client-contracts";
import { act } from "react";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { setWire } from "@/lib/wire";
import { closeBrowser, hasBrowser, onPage } from "@/test-browser";
import { buildProductHost } from "@/test-product";
import { cleanup, click, flush, mount } from "@/test-render";
import { PluginSettings } from "./plugin-settings";

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
  toasts.message.mockClear();
  toasts.success.mockClear();
  toasts.error.mockClear();
});

afterAll(closeBrowser);

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

const displayPlugin = (overrides: Partial<PluginView> = {}): PluginView => ({
  name: "hello",
  version: "1.0.0",
  description: "Says hello.",
  source: { kind: "local", path: "/h/.eta/plugins/hello" },
  enabled: true,
  state: "ready",
  problem: null,
  reports: [],
  skills: [],
  servers: [],
  requires: [],
  machines: [],
  fields: [],
  headers: [],
  agents: [],
  ...overrides,
});

const configuration = {
  ...displayPlugin(),
  skills: [{ name: "greet", description: "Greets." }],
  servers: [
    {
      name: "hello",
      transport: "stdio",
      command: ["node", "${PLUGIN_ROOT}/server.mjs"],
      env: ["HELLO_KEY"],
      headers: [],
      plainHttp: false,
      problem: null,
    },
  ],
  requires: ["node"],
} satisfies PluginView;
const needsConfig: PluginView = {
  ...configuration,
  state: "needs_config",
  fields: [secret, team],
};
const savedSecret = { ...secret, set: true, issue: null };
const configured: PluginView = {
  ...configuration,
  fields: [savedSecret, team],
};

function host(plugins: PluginView[], audit: PluginAuditView[] = []) {
  const fake = buildProductHost({}, ["plugins"]).target("plugins", {
    list: plugins,
    audit,
  });
  fake.install();
  fake.hello();
  return fake;
}

async function renderCards(plugins: PluginView[]) {
  host(plugins);
  const { container } = await mount(<PluginSettings />);
  await flush();
  const markup = container.innerHTML;
  await cleanup();
  return markup;
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

describe("the plugin cards", () => {
  it("shows where a plugin came from, how it stands and what it lacks", async () => {
    host([
      {
        ...needsConfig,
        machines: [
          { machineId: "m", name: "gpu-box", missing: ["node"], checked: true },
        ],
        reports: ["plugin.json: unknown field hooks was ignored"],
      },
      displayPlugin({
        name: "from-git",
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
    await click(document.querySelector('[aria-label="hello 的警告"]'));
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
      "gpu-box 上缺少 node",
    );
    expect(text()).toContain("unknown field hooks");
  });

  const repo = `https://example.com/${"x".repeat(240)}.git`;
  const sha = "abcdef1234567890abcdef1234567890abcdef12";
  const git = displayPlugin({
    name: "from-git",
    source: { kind: "git", repo, rev: "main", path: "", sha },
  });

  it("shows four columns until space runs out, without widening two cards", async ({
    skip,
  }) => {
    if (!(await hasBrowser())) return skip();
    const pair = [displayPlugin(), git];
    const four = await renderCards([
      ...pair,
      displayPlugin({ name: "third" }),
      displayPlugin({ name: "fourth" }),
    ]);
    const two = await renderCards(pair);
    const frame = (markup: string) =>
      `<div style="max-width:var(--available, 940px)">${markup}</div>`;

    const wideWidths = await onPage(frame(four), async (page) => {
      const cards = page
        .getByRole("list", { name: "插件" })
        .getByRole("listitem");
      const source = page.getByText(`${repo} @ ${sha.slice(0, 12)}`, {
        exact: true,
      });
      expect(
        await source.evaluate((el) => el.scrollWidth > el.clientWidth),
      ).toBe(true);
      expect(await cards.locator("img").count()).toBe(0);
      let widths: number[] = [];
      for (const [width, columns] of [
        [940, 4],
        [750, 3],
        [540, 2],
        [320, 1],
      ] as const) {
        await page.evaluate((width) => {
          document.body.style.setProperty("--available", `${width}px`);
        }, width);
        const layout = await cards.evaluateAll((items) =>
          items.map((card) => {
            const { x, y, width } = card.getBoundingClientRect();
            return { x, y, width, fits: card.scrollWidth === card.clientWidth };
          }),
        );
        expect(new Set(layout.map(({ x }) => x)).size).toBe(columns);
        expect(layout.filter(({ y }) => y === layout[0]!.y)).toHaveLength(
          columns,
        );
        expect(layout.every(({ fits }) => fits)).toBe(true);
        if (columns === 4) widths = layout.map(({ width }) => width);
      }
      return widths;
    });

    await onPage(frame(two), async (page) => {
      const cards = page
        .getByRole("list", { name: "插件" })
        .getByRole("listitem");
      expect(
        await cards.evaluateAll((items) =>
          items.map((card) => card.getBoundingClientRect().width),
        ),
      ).toEqual(wideWidths.slice(0, 2));
    });
  });

  it("keeps descriptions to two lines and actions aligned, even with warnings or no actions", async ({
    skip,
  }) => {
    if (!(await hasBrowser())) return skip();
    const markup = await renderCards([
      displayPlugin({ description: "" }),
      displayPlugin({
        name: "short",
        description: "One line.",
        fields: [team],
      }),
      displayPlugin({
        name: "two",
        description: "This local plugin has a description that wraps.",
        fields: [team],
      }),
      {
        ...git,
        description: "A deliberately long description. ".repeat(12),
        reports: ["A warning that should not change card height.".repeat(12)],
        fields: [team],
      },
    ]);
    await onPage(
      `<div style="max-width:1100px">${markup}</div>`,
      async (page) => {
        const cards = page
          .getByRole("list", { name: "插件" })
          .getByRole("listitem");
        const read = () =>
          cards.evaluateAll((items) =>
            items.map((card) => {
              const slot = (name: string) =>
                card.querySelector<HTMLElement>(
                  `[data-slot="plugin-${name}"]`,
                )!;
              const box = card.getBoundingClientRect();
              const description = slot("description");
              const desc = description.getBoundingClientRect();
              const actions = slot("actions");
              const range = document.createRange();
              range.selectNodeContents(description);
              const visibleLines = [...range.getClientRects()].filter(
                (line) => line.top < desc.bottom && line.bottom > desc.top,
              );
              return {
                row: box.top,
                height: box.height,
                rows: [
                  description,
                  slot("source"),
                  slot("counts"),
                  actions,
                ].map((el) => el.getBoundingClientRect().top - box.top),
                lines: new Set(visibleLines.map((line) => line.top)).size,
                descriptionHeight: desc.height,
                lineHeight: Number.parseFloat(
                  getComputedStyle(description).lineHeight,
                ),
                clipped: description.scrollHeight > description.clientHeight,
                buttons: [...actions.querySelectorAll("button")].map(
                  (button) => {
                    const rect = button.getBoundingClientRect();
                    return {
                      bottom: rect.bottom - box.top,
                      fits:
                        rect.width > 0 &&
                        rect.left >= box.left &&
                        rect.right <= box.right &&
                        rect.bottom <= box.bottom,
                    };
                  },
                ),
              };
            }),
          );
        for (const viewport of [1280, 320]) {
          await page.setViewportSize({ width: viewport, height: 820 });
          const layout = await read();
          const first = layout[0]!;
          expect(new Set(layout.map(({ row }) => row)).size).toBe(
            viewport === 320 ? 4 : 1,
          );
          if (viewport === 1280)
            expect(layout.map(({ lines }) => lines)).toEqual([0, 1, 2, 2]);
          expect(layout[3]).toMatchObject({ lines: 2, clipped: true });
          for (const card of layout) {
            expect(card).toMatchObject({
              height: first.height,
              rows: first.rows,
            });
            expect(card.descriptionHeight).toBeCloseTo(card.lineHeight * 2, 1);
            expect(card.lines).toBeLessThanOrEqual(2);
          }
          expect(first.buttons).toHaveLength(0);
          expect(layout[3]!.buttons).toHaveLength(3);
          const buttons = layout.flatMap((card) => card.buttons);
          expect(new Set(buttons.map(({ bottom }) => bottom)).size).toBe(1);
          expect(buttons.every(({ fits }) => fits)).toBe(true);
        }
      },
    );
  });

  it("opens the full Git source without a host call and copies it unshortened", async () => {
    const built = host([displayPlugin(), git]);
    const { container } = await mount(<PluginSettings />);
    const writeText = vi.fn().mockResolvedValue(undefined);
    const previous = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    try {
      await click(container.querySelector('[aria-label="from-git 的来源"]'));
      const dialog = document.querySelector('[role="dialog"]');
      expect(dialog?.textContent).toContain(`${repo} @ ${sha}`);
      await click(
        [...dialog!.querySelectorAll("button")].find(
          (button) => button.textContent === "复制",
        ),
      );
      expect(writeText).toHaveBeenCalledWith(`${repo} @ ${sha}`);
      expect(toasts.message).toHaveBeenCalledWith("已复制");
      writeText.mockRejectedValueOnce(new Error("blocked"));
      await click(
        [...dialog!.querySelectorAll("button")].find(
          (button) => button.textContent === "复制",
        ),
      );
      expect(toasts.error).toHaveBeenCalled();
      expect(dialog?.textContent).toContain(`${repo} @ ${sha}`);
      expect(built.calls).toEqual([]);
    } finally {
      if (previous) Object.defineProperty(navigator, "clipboard", previous);
      else Reflect.deleteProperty(navigator, "clipboard");
    }
  });

  it("says which agents skip a plugin that fell back", async () => {
    host([{ ...needsConfig, agents: [{ id: "a", name: "Ada" }] }]);
    await mount(<PluginSettings />);
    await flush();
    await click(document.querySelector('[aria-label="hello 的警告"]'));
    expect(text()).toContain("Ada 启用了它，但配置不再合法");
  });

  it("shows why a plugin was rejected, and no form", async () => {
    host([
      displayPlugin({
        state: "needs_config",
        problem: "plugin.json: unsupported $schema",
      }),
    ]);
    const { container } = await mount(<PluginSettings />);
    await flush();
    await click(container.querySelector('[aria-label="hello 的警告"]'));
    expect(text()).toContain("unsupported $schema");
    expect(container.querySelector('[aria-label="配置 hello"]')).toBeNull();
  });

  it("shows who read what, and when", async () => {
    host(
      [needsConfig],
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

describe("plugin page actions", () => {
  it("keeps configuration, Git update and confirmed removal on their own card", async () => {
    const local = displayPlugin({ name: "local", fields: [team] });
    const git = displayPlugin({
      name: "from-git",
      source: {
        kind: "git",
        repo: "file:///tmp/fixture.git",
        rev: "main",
        path: "",
        sha: "abc123",
      },
      fields: [team],
    });
    const built = host([local, git]);
    built.handle("plugins.configure", () => ({
      name: "local",
      state: "ready",
      issues: [],
    }));
    built.handle("plugins.update", () => ({ name: "from-git" }));
    built.handle("plugins.remove", () => {
      built.set("plugins", { list: [local], audit: [] });
      return {};
    });
    const { container } = await mount(<PluginSettings />);
    await flush();
    const card = (name: string) =>
      [...container.querySelectorAll("main li")].find(
        (item) => item.querySelector("h2")?.textContent === name,
      )!;
    const dialog = () =>
      document.querySelector('[role="dialog"], [role="alertdialog"]');
    expect(card("local").querySelectorAll("button")).toHaveLength(1);
    await click(card("local").querySelector('[aria-label="配置 local"]'));
    expect(dialog()?.textContent).toContain("配置 local");
    await type(dialog()!.querySelector("input")!, "local-only");
    await click(save());
    await flush();
    expect(dialog()).toBeNull();

    await click(card("from-git").querySelector('[aria-label="更新 from-git"]'));
    await flush();
    const remove = card("from-git").querySelector(
      '[aria-label="移除 from-git"]',
    );
    await click(remove);
    expect(dialog()?.textContent).toContain("移除 from-git？");
    await click(dialog()?.querySelector('[data-slot="alert-dialog-cancel"]'));
    expect(dialog()).toBeNull();
    expect(built.calls.map(({ action }) => action)).toEqual([
      "configure",
      "update",
    ]);
    await click(remove);
    await click(dialog()?.querySelector('[data-slot="alert-dialog-action"]'));
    await flush();

    expect(built.calls.map(({ action, args }) => ({ action, args }))).toEqual([
      {
        action: "configure",
        args: { name: "local", values: { team: "local-only" } },
      },
      { action: "update", args: { name: "from-git" } },
      { action: "remove", args: { name: "from-git" } },
    ]);
    expect(card("from-git")).toBeUndefined();
    expect(card("local")).toBeDefined();
  });

  it("rechecks on the host without leaving the page", async () => {
    const built = host([]);
    built.handle("plugins.recheck", () => {
      built.set("plugins", { list: [displayPlugin()], audit: [] });
      return {};
    });
    const { container } = await mount(<PluginSettings />);
    await click(container.querySelector('button[aria-label="重新检查"]'));
    await flush();
    expect(built.calls.at(-1)).toMatchObject({
      target: "plugins",
      action: "recheck",
      args: {},
    });
    expect(container.querySelector("main")?.textContent).toContain("hello");
  });

  it("adds from git and closes only its own dialog", async () => {
    const built = host([]);
    const repo = "file:///tmp/fixture.git";
    built.handle("plugins.add", () => {
      built.set("plugins", {
        list: [
          displayPlugin({
            source: {
              kind: "git",
              repo,
              rev: "main",
              path: "",
              sha: "abcdef1234567890abcdef1234567890abcdef12",
            },
          }),
        ],
        audit: [],
      });
      return { name: "hello" };
    });
    const { container } = await mount(<PluginSettings />);
    const header = container.querySelector("h1")!.parentElement!;
    await click(
      [...header.querySelectorAll("button")].find(
        (item) => item.textContent === "从 git 添加",
      ),
    );
    const add = document.querySelector('[role="dialog"]')!;
    expect(add.textContent).toContain("从 git 添加插件");
    await type(add.querySelector('input[aria-label="仓库地址"]')!, repo);
    await click(add.querySelector('button[type="submit"]'));
    await flush();
    expect(built.calls.at(-1)).toMatchObject({
      target: "plugins",
      action: "add",
      args: { repo, rev: "", path: "" },
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(container.querySelector("main")?.textContent).toContain(
      `${repo} @ abcdef123456`,
    );
  });
});

describe("the form", () => {
  it("draws a password box for a secret, and shows what will run", async () => {
    host([needsConfig]);
    const { container } = await mount(<PluginSettings />);
    await open(container);
    expect(passwordInput()).not.toBeNull();
    expect(text()).toContain("node ${PLUGIN_ROOT}/server.mjs");
    expect(text()).toContain("HELLO_KEY");
    expect(text()).toContain("智能体访问");
  });

  it("will not save what does not fit", async () => {
    const built = host([needsConfig]);
    const { container } = await mount(<PluginSettings />);
    await open(container);
    await type(passwordInput(), "wrong");
    await flush();
    expect(text()).toContain("不符合要求的格式");
    expect(save().hasAttribute("disabled")).toBe(true);
    expect(built.calls).toEqual([]);
  });

  it("saves what changed, and a blank secret is left out", async () => {
    const built = host([configured]);
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
    const built = host([needsConfig]);
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
    host([{ ...configured, fields: [savedSecret] }]);
    const { container } = await mount(<PluginSettings />);
    await open(container);
    expect(passwordInput().value).toBe("");
    expect(passwordInput().placeholder).toContain("留空表示不改");
    expect(text()).toContain("已设置");
  });

  it("offers a secret's levels, up to what the manifest declares", async () => {
    host([needsConfig]);
    const { container } = await mount(<PluginSettings />);
    await open(container);
    const trigger = document.querySelector('[role="combobox"]')!;
    expect(trigger.textContent).toBe("明文（会进上下文）");
    await click(trigger);
    await flush();
    expect(
      [...document.querySelectorAll('[role="option"]')].map(
        (option) => option.textContent,
      ),
    ).toEqual([
      "不可读（只给插件进程）",
      "临时文件（内容不进上下文）",
      "明文（会进上下文）",
    ]);
  });
});
