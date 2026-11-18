import type {
  MachineView,
  SkillFileContent,
  SkillTarget,
} from "@eta/client-contracts";
import {
  createMemoryHistory,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act, StrictMode } from "react";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { languageStorageKey } from "@/lib/i18n";
import { createQueryClient } from "@/lib/query-client";
import { setWire } from "@/lib/wire";
import { routeTree } from "@/routeTree.gen";
import { closeBrowser, hasBrowser, onPage, PHONE } from "@/test-browser";
import {
  agentView,
  buildProductHost,
  machineView,
  projectView,
} from "@/test-product";
import { cleanup, click, flush, mount } from "@/test-render";

const PRIMARY = machineView({ id: "primary", name: "Studio" });
const BOX = machineView({
  id: "box",
  kind: "daemon",
  name: "Box",
  home: "/remote/me",
});
const ORIGINAL =
  "---\nname: demo\ndescription: demo skill\nunknown: preserve me\n---\n\n# Demo\nhello";
const content = (text = ORIGINAL): SkillFileContent => ({
  kind: "text",
  text,
  ...(text === ORIGINAL
    ? {
        preview: {
          body: "# Demo\nhello",
          metadata: "name: demo\ndescription: demo skill\nunknown: preserve me",
        },
      }
    : {}),
  version: "v1",
  size: text.length,
  diagnostics: [],
});
const text = () => document.body.textContent ?? "";
const byText = (name: string) =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (node) => (node.getAttribute("aria-label") ?? node.textContent) === name,
  );
const calls = (fake: ReturnType<typeof host>, action: string) =>
  fake.calls.filter(
    (call) => call.target === "skills" && call.action === action,
  );
function host(machines: MachineView[] = [PRIMARY, BOX], deferMachines = false) {
  const fake = buildProductHost(
    {
      machines,
      agents: [agentView({ id: "fixture-agent" })],
      projects: [
        projectView({
          id: "p1",
          machineId: "box",
          path: "/remote/project",
          name: "Explicit project",
        }),
      ],
    },
    ["skills"],
  );
  const reply = (args: unknown, result: unknown) => ({
    target: { ...(args as { target: SkillTarget }).target, epoch: 7 },
    result,
  });
  fake.handle("skills.list", (args) => {
    const { target } = args as { target: SkillTarget };
    const root = `${
      target.scope === "personal" ? target.home : "/remote/project"
    }/.agents/skills`;
    return reply(args, {
      root,
      exists: true,
      next: null,
      entries: [
        {
          path: "demo",
          kind: "directory",
          size: 0,
          name: `Demo ${target.machineId}`,
          description: "demo skill",
          writable: true,
          diagnostics: [],
        },
      ],
    });
  });
  let detail = 0;
  fake.handle("skills.open", (args) =>
    reply(args, {
      detail: `detail-${++detail}`,
      path: "/remote/me/.agents/skills/demo",
      writable: true,
      diagnostics: [],
    }),
  );
  fake.handle("skills.read", (args) => reply(args, content()));
  fake.handle("skills.directory", (args) =>
    reply(args, {
      entries: [
        { path: "SKILL.md", kind: "file", size: 20 },
        { path: "assets", kind: "directory", size: 0 },
      ],
      next: null,
    }),
  );
  fake.handle("skills.close", (args) => reply(args, {}));
  if (deferMachines) fake.target("machines", {});
  fake.install();
  fake.hello();
  return fake;
}
async function tab(name: string) {
  const target = byText(name)!;
  await act(async () => {
    target.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, button: 0 }),
    );
    target.click();
  });
  await flush();
}
async function choose(name: string, index = 0) {
  const trigger = document.querySelectorAll(
    "main [role=combobox], [data-skill-toolbar] [role=combobox]",
  )[index]!;
  await act(async () =>
    trigger.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    ),
  );
  await click(
    [...document.querySelectorAll("[role=option]")].find((node) =>
      node.textContent?.startsWith(name),
    ),
  );
  await flush(10);
}
async function fill(
  element: HTMLInputElement | HTMLTextAreaElement | null,
  value: string,
) {
  if (!element) throw new Error("missing input");
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(element),
      "value",
    )!.set!.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function open(entry = "/plugins/skills", strict = false) {
  localStorage.setItem(languageStorageKey, JSON.stringify("zh"));
  const queryClient = createQueryClient();
  const router = createRouter({
    routeTree,
    context: { queryClient },
    history: createMemoryHistory({ initialEntries: [entry] }),
  });
  await router.load();
  const node = <RouterProvider router={router} />;
  await mount(strict ? <StrictMode>{node}</StrictMode> : node, queryClient);
  await flush(20);
  if (!document.querySelector("main#main"))
    throw new Error(
      `Route ${router.state.location.href}: ${document.body.textContent}`,
    );
  return router;
}
const detail =
  "/plugins/skills/detail?device=box&home=%2Fremote%2Fme&skill=demo";
async function openDetail() {
  await choose("Box");
  await click(document.querySelector("[data-skill-list] li a"));
  await flush(30);
}
async function submit() {
  await act(async () =>
    document
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
  await flush(20);
}
afterEach(async () => {
  await cleanup();
  setWire(undefined);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.removeItem(languageStorageKey);
});

const browserAvailable = await hasBrowser();
afterAll(closeBrowser);
describe("device-scoped Skill settings", () => {
  it("removes device help from the DOM and keeps a compact explicit target with plugin-style actions", async () => {
    host();
    await open();
    expect(document.querySelector("details")).toBeNull();
    expect(text()).not.toContain("设备详情与使用说明");
    expect(text()).not.toContain("管理所选设备上的技能文件");
    await choose("Box");
    expect(document.querySelector("details")).toBeNull();
    expect(text()).not.toContain("/remote/me/.agents/skills");
    const refresh = document.querySelector('button[aria-label="刷新"]');
    expect(refresh?.getAttribute("title")).toBe("刷新");
    expect(refresh?.querySelector("svg")).not.toBeNull();
    expect(byText("新建技能")).toBeUndefined();
    expect(
      document.querySelector('[role="tab"][aria-selected="true"]')?.textContent,
    ).toBe("个人");
    expect(refresh?.parentElement?.hasAttribute("data-skill-toolbar")).toBe(
      true,
    );
    expect(document.querySelector("[data-skill-grid] a[href]")).not.toBeNull();
    expect(document.querySelector("h1")?.textContent).toBe("插件");
  });
  it("submits the search accessibly and carries it through a detail round trip", async () => {
    host();
    const router = await open();
    await choose("Box");
    const input = document.querySelector<HTMLInputElement>(
      'input[aria-label="搜索已加载技能"]',
    );
    await fill(input, "demo skill");
    const submitButton = document.querySelector(
      'form button[aria-label="搜索已加载技能"]',
    );
    expect(submitButton?.getAttribute("type")).toBe("submit");
    expect(submitButton?.querySelector("svg")).not.toBeNull();
    await submit();
    expect(router.state.location.search).toMatchObject({
      q: "demo skill",
      device: "box",
    });
    await click(document.querySelector("[data-skill-grid] a"));
    await flush(20);
    await click(byText("返回列表"));
    await flush(20);
    expect(
      document.querySelector<HTMLInputElement>(
        'input[aria-label="搜索已加载技能"]',
      )?.value,
    ).toBe("demo skill");
  });
  it("survives StrictMode resource effect replay", async () => {
    const fake = host();
    await open(undefined, true);
    await openDetail();
    await flush(100);
    expect(document.querySelector(".markdown")?.textContent).toContain("hello");
    const active = calls(fake, "read")[0]?.args as {
      input: { detail: string };
    };
    expect(
      calls(fake, "close").some(
        (call) =>
          (call.args as { input: { detail: string } }).input.detail ===
          active.input.detail,
      ),
    ).toBe(false);
    await click(byText("返回列表"));
    await flush(20);
    expect(
      calls(fake, "close").some(
        (call) =>
          (call.args as { input: { detail: string } }).input.detail ===
          active.input.detail,
      ),
    ).toBe(true);
  });
  it("uses the directory empty state for ordinary guidance, not loading, errors or offline devices", async () => {
    const fake = host([{ ...PRIMARY, status: "offline" }, BOX]);
    const empty = () =>
      document.querySelector('[data-skill-empty][role="status"]');
    let resolveList!: (value: unknown) => void;
    fake.handle(
      "skills.list",
      () =>
        new Promise((resolve) => {
          resolveList = resolve;
        }),
    );
    await open("/plugins/skills?scope=project");
    expect(empty()?.textContent).toContain("在右上角选择设备");
    expect(empty()?.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
    await choose("Box");
    expect(empty()?.textContent).toContain("在上方选择项目");
    expect(calls(fake, "list")).toHaveLength(0);
    await choose("Explicit project", 1);
    expect(empty()).toBeNull();
    expect(document.querySelector('main [role="status"]')).not.toBeNull();
    const target = (calls(fake, "list")[0]!.args as { target: SkillTarget })
      .target;
    await act(async () =>
      resolveList({
        target: { ...target, epoch: 7 },
        result: {
          root: "/remote/project/.agents/skills",
          exists: true,
          entries: [],
          next: null,
        },
      }),
    );
    await flush(20);
    expect(empty()?.textContent).toContain("暂无技能");
    fake.handle("skills.list", () => {
      throw new Error("fixture list error");
    });
    await click(
      document.querySelector('[data-skill-toolbar] button[aria-label="刷新"]'),
    );
    await flush(20);
    expect(empty()).toBeNull();
    expect(document.querySelector('main [role="alert"]')).not.toBeNull();
    await act(async () =>
      fake.set("machines", { list: [PRIMARY, { ...BOX, status: "offline" }] }),
    );
    await flush();
    expect(empty()).toBeNull();
    expect(
      document.querySelector('main [role="status"]')?.textContent,
    ).toContain("设备不可用");
  });
  it("waits for the machines snapshot then replaces the URL with the online primary", async () => {
    const fake = host([], true);
    const router = await open("/plugins/skills?q=demo");
    expect(router.state.location.search.device).toBeUndefined();
    expect(calls(fake, "list")).toHaveLength(0);
    const index = router.history.location.state.__TSR_index;
    await act(async () => fake.set("machines", { list: [BOX, PRIMARY] }));
    await flush(20);
    expect(router.state.location.search).toMatchObject({
      device: PRIMARY.id,
      q: "demo",
    });
    expect(router.history.location.state.__TSR_index).toBe(index);
    expect(text()).toContain("Demo primary");
    expect(calls(fake, "list")).toHaveLength(1);
  });
  it.each(["box", "missing", "123", ""])(
    "keeps explicit device %j through the first list snapshot",
    async (device) => {
      const fake = host([], true);
      const router = await open(`/plugins/skills?device=${device}`);
      await act(async () =>
        fake.set("machines", {
          list: [PRIMARY, { ...BOX, status: "offline" }],
        }),
      );
      await flush(20);
      expect(router.state.location.search.device).toBe(device);
      expect(calls(fake, "list")).toHaveLength(0);
      if (device === "box") expect(text()).toContain("设备不可用");
      if (device === "missing")
        expect(text()).toContain("所选设备已移除：missing");
    },
  );
  it("leaves manual selection when no primary is online and keeps a manual choice as it comes online", async () => {
    const fake = host([BOX, { ...PRIMARY, status: "offline" }]);
    const router = await open();
    expect(router.state.location.href).toBe("/plugins/skills");
    expect(calls(fake, "list")).toHaveLength(0);
    await choose("Box");
    await act(async () => fake.set("machines", { list: [BOX, PRIMARY] }));
    await flush(20);
    expect(router.state.location.search.device).toBe(BOX.id);
    expect(text()).toContain("Demo box");
    expect(calls(fake, "list")).toHaveLength(1);
  });
  it.each([undefined, "p1"])(
    "keeps project scope and filters without choosing a project (%j)",
    async (project) => {
      const fake = host();
      const params = new URLSearchParams({
        scope: "project",
        q: "demo",
        ...(project ? { project } : {}),
      });
      const router = await open(`/plugins/skills?${params}`);
      expect(router.state.location.search).toMatchObject({
        device: PRIMARY.id,
        scope: "project",
        q: "demo",
      });
      expect(router.state.location.search.project).toBe(project);
      expect(calls(fake, "list")).toHaveLength(0);
    },
  );
  it("does not complete a detail link missing device", async () => {
    const fake = host();
    const href = "/plugins/skills/detail?home=%2Fhome%2Fme&skill=demo";
    const router = await open(href);
    expect(router.state.location.href).toBe(href);
    expect(text()).toContain("此技能链接不完整或无效");
    expect(fake.calls.filter((call) => call.target === "skills")).toHaveLength(
      0,
    );
  });
  it("keeps a manually selected remote and requires an explicit project", async () => {
    const fake = host();
    await open("/plugins/skills?device=box");
    await choose("Box");
    expect(text()).toContain("Demo box");
    expect(text()).not.toContain("Demo primary");
    await tab("项目");
    await flush();
    expect(text()).toContain("请选择此设备上的项目");
    expect(calls(fake, "list")).toHaveLength(1);
    await choose("Explicit project", 1);
    expect(text()).toContain("Demo box");
    expect(calls(fake, "list").at(-1)?.args).toMatchObject({
      target: {
        machineId: "box",
        home: "/remote/me",
        scope: "project",
        projectId: "p1",
        projectPath: "/remote/project",
      },
    });
  });
  it("keeps the selected target and reports offline or removed without retargeting", async () => {
    const fake = host();
    await open();
    await openDetail();
    await act(async () =>
      fake.set("machines", { list: [PRIMARY, { ...BOX, status: "offline" }] }),
    );
    await flush();
    expect(text()).toContain("设备不可用");
    await act(async () => fake.set("machines", { list: [PRIMARY] }));
    await flush();
    expect(text()).toContain("所选设备已移除：box");
    expect(calls(fake, "open")).toHaveLength(1);
  });
  it("late list response from A never replaces device B", async () => {
    const fake = host();
    let resolveA!: (value: unknown) => void;
    fake.handle("skills.list", (args) => {
      const { target } = args as { target: SkillTarget };
      return target.machineId === "primary"
        ? new Promise((resolve) => {
            resolveA = resolve;
          })
        : {
            target: { ...target, epoch: 8 },
            result: {
              root: "/B/.agents/skills",
              exists: true,
              next: null,
              entries: [
                {
                  path: "b",
                  name: "List B",
                  kind: "directory",
                  size: 0,
                  description: "",
                  writable: true,
                  diagnostics: [],
                },
              ],
            },
          };
    });
    await open();
    await choose("Box");
    await act(async () =>
      resolveA({
        target: {
          machineId: "primary",
          home: "/home/me",
          scope: "personal",
          epoch: 0,
        },
        result: {
          root: "/A/.agents/skills",
          exists: true,
          next: null,
          entries: [],
        },
      }),
    );
    await flush();
    expect(text()).toContain("List B");
    expect(document.querySelector("[data-skill-list] li a")?.textContent).toBe(
      "List B",
    );
  });
  it("distinguishes no devices, unknown home, missing root, empty and search-empty, permissions", async () => {
    const fake = host([]);
    await open();
    expect(text()).toContain("暂无可用设备");
    await act(async () =>
      fake.set("machines", { list: [{ ...BOX, home: null }] }),
    );
    await choose("Box");
    expect(text()).toContain("运行用户 home 未知");
    expect(calls(fake, "list")).toHaveLength(0);
    await act(async () => fake.set("machines", { list: [BOX] }));
    await flush(20);
    await fill(
      document.querySelector('input[aria-label="搜索已加载技能"]'),
      "nomatch",
    );
    expect(text()).toContain("已加载条目中无搜索结果");
    fake.handle("skills.list", (args) => ({
      target: { ...(args as { target: SkillTarget }).target, epoch: 7 },
      result: {
        root: "/missing/.agents/skills",
        exists: false,
        entries: [],
        next: null,
      },
    }));
    await click(document.querySelector('button[aria-label="刷新"]'));
    await flush(20);
    expect(text()).toContain("技能目录不存在");
    expect(text()).not.toContain("暂无技能");
    fake.handle("skills.list", () => {
      throw new Error("EACCES /remote/me/.agents/skills");
    });
    await click(document.querySelector('button[aria-label="刷新"]'));
    await flush(20);
    expect(text()).toContain("EACCES");
  });
  it("deduplicates reader diagnostics above the panel, keeps metadata closed, and preserves other file errors", async () => {
    const fake = host();
    fake.handle("skills.open", (args) => ({
      target: (args as { target: SkillTarget }).target,
      result: {
        detail: "reader",
        path: "/remote/me/.agents/skills/demo",
        writable: true,
        diagnostics: ["shared diagnostic", "open diagnostic"],
      },
    }));
    fake.handle("skills.directory", (args) => ({
      target: (args as { target: SkillTarget }).target,
      result: {
        entries: [{ path: "notes.txt", kind: "file", size: 10 }],
        next: null,
      },
    }));
    fake.handle("skills.read", (args) => {
      const { target, input } = args as {
        target: SkillTarget;
        input: { path: string };
      };
      if (input.path === "notes.txt") throw new Error("fixture read failure");
      return {
        target,
        result: {
          ...content(),
          diagnostics: ["shared diagnostic", "file diagnostic"],
        },
      };
    });
    await open(detail);
    await flush(100);
    const reader = document.querySelector("[data-skill-content]")!;
    expect(reader.querySelector("details")?.open).toBe(false);
    expect(text()).not.toContain("/remote/me/.agents/skills/demo");
    expect(text()).not.toContain("SKILL.md · 只读");
    expect(
      [...document.querySelectorAll('ul[aria-label="诊断"] li')].map(
        (node) => node.textContent,
      ),
    ).toEqual(["shared diagnostic", "open diagnostic", "file diagnostic"]);
    expect(reader.textContent).not.toContain("shared diagnostic");
    expect(reader.previousElementSibling?.tagName).toBe("NAV");
    await click(byText("notes.txt"));
    await flush(30);
    expect(
      document.querySelector('[data-skill-content] [role="alert"]')
        ?.textContent,
    ).toContain("fixture read failure");
    expect(text()).toContain("open diagnostic");
    expect(text()).not.toContain("file diagnostic");
    expect(byText("编辑 SKILL.md")).toBeUndefined();
  });
  it("defaults to SKILL.md, navigates files lazily, restores search and closes details", async () => {
    const fake = host();
    await open();
    await choose("Box");
    await fill(
      document.querySelector('input[aria-label="搜索已加载技能"]'),
      "demo",
    );
    await flush();
    await click(document.querySelector("[data-skill-list] li a"));
    await flush(20);
    await flush(100);
    expect(document.querySelector(".markdown")?.textContent).toContain("hello");
    expect(calls(fake, "read")[0]?.args).toMatchObject({
      input: { path: "SKILL.md" },
    });
    expect(calls(fake, "directory")).toHaveLength(1);
    await click(byText("▸ assets"));
    await flush();
    expect(calls(fake, "directory").at(-1)?.args).toMatchObject({
      input: { path: "assets" },
    });
    await click(byText("返回列表"));
    await flush();
    expect(
      (
        document.querySelector(
          'input[aria-label="搜索已加载技能"]',
        ) as HTMLInputElement
      ).value,
    ).toBe("demo");
    expect(calls(fake, "close")).toHaveLength(1);
  });
  it("has no page creation entry and never calls create", async () => {
    const fake = host();
    await open();
    await choose("Box");
    expect(byText("新建技能")).toBeUndefined();
    expect(calls(fake, "create")).toHaveLength(0);
  });
  it("keeps the Plugins title and presents the detail breadcrumb, and refresh without write entry points", async () => {
    const fake = host();
    await open(
      `${detail}&scope=project&project=p1&projectPath=%2Fremote%2Fproject&edit=true&mode=edit&draft=fixture#edit`,
    );
    await flush(50);
    const breadcrumb = document.querySelector('nav[aria-label="技能位置"]')!;
    const current = breadcrumb.querySelector('[aria-current="page"]');
    expect(document.querySelector("h1")?.textContent).toBe("插件");
    expect(breadcrumb.textContent).toContain("Box/项目/Explicit project/demo");
    expect(current?.classList.contains("font-semibold")).toBe(true);
    expect(breadcrumb.nextElementSibling?.getAttribute("aria-label")).toBe(
      "刷新",
    );
    expect(breadcrumb.nextElementSibling?.querySelector("svg")).not.toBeNull();
    expect(breadcrumb.previousElementSibling).toBeNull();
    expect(breadcrumb.parentElement?.previousElementSibling).toBe(
      byText("返回列表"),
    );
    expect(byText("删除技能目录")).toBeUndefined();
    await click(breadcrumb.nextElementSibling);
    await flush(30);
    expect(calls(fake, "open")).toHaveLength(2);
    const panel = document.querySelector("[data-skill-detail]")!;
    for (const key of ["e", "Enter", "s", "F2"]) {
      panel.querySelector("[data-skill-content]")!.dispatchEvent(
        new KeyboardEvent("keydown", {
          key,
          ctrlKey: key === "s",
          bubbles: true,
        }),
      );
    }
    expect(
      panel.querySelector('textarea, form, [contenteditable="true"]'),
    ).toBeNull();
    expect(panel.textContent).toContain("hello");
    for (const action of [
      "保存",
      "编辑",
      "编辑 SKILL.md",
      "删除技能目录",
      "新建技能",
    ])
      expect(byText(action)).toBeUndefined();
    expect(
      new Set(
        fake.calls
          .filter((call) => call.target === "skills")
          .map((call) => call.action),
      ),
    ).toEqual(new Set(["list", "open", "read", "directory", "close"]));
  });
  it("file disappearance and parser diagnostics are not empty successful reads", async () => {
    const fake = host();
    fake.handle("skills.read", () => {
      throw new Error("ENOENT SKILL.md");
    });
    await open();
    await openDetail();
    await flush(100);
    expect(text()).toContain("ENOENT SKILL.md");
    expect(document.querySelector("textarea")).toBeNull();
    fake.handle("skills.read", (args) => ({
      target: (args as { target: SkillTarget }).target,
      result: {
        ...content("broken frontmatter"),
        diagnostics: ["invalid_metadata YAML error"],
      },
    }));
    await click(byText("重试"));
    await flush(20);
    expect(text()).toContain("invalid_metadata YAML error");
    expect(
      document.querySelector("[data-skill-content]")?.textContent,
    ).toContain("broken frontmatter");
  });
  it.skipIf(!browserAvailable)(
    "actual skill detail markup: finite independent scrollers, narrow-screen tree hidden",
    async () => {
      const fake = host();
      fake.handle("skills.read", (args) => ({
        target: (args as { target: SkillTarget }).target,
        result: content(`${ORIGINAL}\n\n${"paragraph\n\n".repeat(400)}`),
      }));
      await open(detail);
      await flush(150);
      const markup = `<div class="flex h-[36rem] flex-col">${document.querySelector("main#main")!.outerHTML}</div>`;
      await onPage(markup, async (page) => {
        const outside = await page.locator("main#main").evaluate((element) => ({
          height: element.clientHeight,
          scroll: element.scrollHeight,
        }));
        expect(outside.scroll).toBeLessThanOrEqual(outside.height + 1);
        const scroll = await page
          .locator("[data-skill-content]")
          .evaluate((element) => ({
            height: element.clientHeight,
            scroll: element.scrollHeight,
            overflow: getComputedStyle(element).overflowY,
          }));
        expect(scroll.overflow).toBe("auto");
        expect(scroll.scroll).toBeGreaterThan(scroll.height);
        expect(
          await page
            .getByRole("navigation", { name: "技能目录", includeHidden: true })
            .isVisible(),
        ).toBe(true);
      });
      await onPage(
        markup,
        async (page) => {
          expect(
            await page
              .getByRole("navigation", {
                name: "技能目录",
                includeHidden: true,
              })
              .isVisible(),
          ).toBe(false);
          expect(
            await page
              .getByRole("button", { name: "文件", exact: true })
              .isVisible(),
          ).toBe(true);
        },
        PHONE,
      );
    },
  );
});
