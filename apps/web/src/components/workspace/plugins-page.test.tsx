import {
  createMemoryHistory,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act } from "react";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { languageStorageKey } from "@/lib/i18n";
import { createQueryClient } from "@/lib/query-client";
import { setWire } from "@/lib/wire";
import { routeTree } from "@/routeTree.gen";
import { closeBrowser, hasBrowser, onPage, PHONE } from "@/test-browser";
import { agentView, buildProductHost } from "@/test-product";
import { cleanup, flush, mount } from "@/test-render";
import { useWorkspaceStore } from "./workspace-store";

const agent = agentView({ id: "a1", name: "Test Agent" });

async function open(...entries: string[]) {
  localStorage.setItem(languageStorageKey, JSON.stringify("zh"));
  const fake = buildProductHost({ agents: [agent] }, ["plugins"]).target(
    "plugins",
    { list: [], audit: [] },
  );
  fake.install();
  fake.hello();
  const queryClient = createQueryClient();
  const router = createRouter({
    routeTree,
    context: { queryClient },
    history: createMemoryHistory({ initialEntries: entries }),
  });
  await router.load();
  const { container } = await mount(
    <RouterProvider router={router} />,
    queryClient,
  );
  await flush();
  return { router, container };
}

const sidebarLink = (path: string) =>
  document.querySelector<HTMLAnchorElement>(
    `ul[aria-label="分区"] a[href="${path}"]`,
  )!;
const bottomLink = (path: string) =>
  document.querySelector<HTMLAnchorElement>(
    `nav[aria-label="分区"] a[href="${path}"]`,
  )!;
const heading = () => document.querySelector("h1")?.textContent;
const dialog = () => document.querySelector('[role="dialog"]');
const clickLink = async (link: HTMLAnchorElement) => {
  await act(async () => link.click());
  await flush();
};

function expectPluginsPage() {
  expect(heading()).toBe("插件");
  expect(document.querySelector("main#main")?.textContent).toContain(
    "还没有插件",
  );
  expect(sidebarLink("/plugins").getAttribute("data-active")).toBe("true");
  expect(bottomLink("/plugins").getAttribute("aria-current")).toBe("page");
  expect(dialog()).toBeNull();
}

afterEach(async () => {
  await cleanup();
  setWire(undefined);
  localStorage.removeItem(languageStorageKey);
  const { setSettings, setAgentEditor } = useWorkspaceStore.getState();
  setSettings({ open: false, section: "agents" });
  setAgentEditor({ open: false, agentId: null });
});
afterAll(closeBrowser);

describe("Plugins as a main section", () => {
  it("opens directly and lands on the same page in a fresh router (reload)", async () => {
    const { router } = await open("/plugins");
    expectPluginsPage();
    const address = router.state.location.href;
    await cleanup();
    await open(address);
    expectPluginsPage();
  });

  it("goes from Mail to Plugins to Routines and keeps selection through back and forward", async () => {
    const { router } = await open("/email");
    expect(sidebarLink("/email").getAttribute("data-active")).toBe("true");
    await clickLink(sidebarLink("/plugins"));
    expect(router.state.location.href).toBe("/plugins");
    expectPluginsPage();
    await clickLink(bottomLink("/routines"));
    expect(router.state.location.href).toBe("/routines");
    expect(heading()).toContain("定时");
    expect(bottomLink("/routines").getAttribute("aria-current")).toBe("page");
    await act(async () => router.history.back());
    await flush();
    expectPluginsPage();
    await act(async () => router.history.back());
    await flush();
    expect(sidebarLink("/email").getAttribute("data-active")).toBe("true");
    await act(async () => router.history.forward());
    await flush();
    expectPluginsPage();
    await clickLink(bottomLink("/email"));
    expect(router.state.location.href).toBe("/email");
    expect(bottomLink("/email").getAttribute("aria-current")).toBe("page");
  });

  it.each([
    "/?group=previous&settings=plugins",
    "/email?settings=plugins",
    "/settings?section=plugins",
    "/settings/?section=plugins",
  ])("replaces the old entry %s without opening settings", async (legacy) => {
    const { router } = await open("/tasks", legacy);
    expect(router.state.location.href).toBe("/plugins");
    expectPluginsPage();
    await act(async () => router.history.back());
    await flush();
    expect(router.state.location.href).toBe("/tasks");
  });

  it.each([
    "/?settings=skills",
    "/email?settings=skills",
    "/settings?section=skills",
    "/settings/?section=skills",
  ])(
    "replaces the old Skill entry %s without opening settings",
    async (legacy) => {
      const { router } = await open("/tasks", legacy);
      expect(router.state.location.href).toBe("/plugins/skills");
      expect(heading()).toBe("插件");
      expect(sidebarLink("/plugins").getAttribute("data-active")).toBe("true");
      expect(bottomLink("/plugins").getAttribute("aria-current")).toBe("page");
      expect(dialog()).toBeNull();
      await act(async () => router.history.back());
      await flush();
      expect(router.state.location.href).toBe("/tasks");
    },
  );

  it("leaves the agent editor and underlying settings when following its empty-state link", async () => {
    const { router } = await open("/email");
    const { setSettings, setAgentEditor } = useWorkspaceStore.getState();
    await act(async () => setSettings({ open: true, section: "agents" }));
    await flush();
    await act(async () => setAgentEditor({ open: true, agentId: agent.id }));
    await flush();
    const tab = [
      ...document.querySelectorAll<HTMLButtonElement>(
        '[role="dialog"] nav button',
      ),
    ].find((button) => button.textContent === "插件")!;
    await act(async () => tab.click());
    await flush();
    const entry = document.querySelector<HTMLAnchorElement>(
      '[role="dialog"] a[href="/plugins"]',
    )!;
    expect(entry.textContent).toBe("去插件页面添加");
    await clickLink(entry);
    expect(router.state.location.href).toBe("/plugins");
    expectPluginsPage();
  });

  it("offers the sidebar on a desktop and the bottom tab on a narrow screen", async ({
    skip,
  }) => {
    if (!(await hasBrowser())) return skip();
    const { container } = await open("/plugins");
    const markup = container.innerHTML;
    await onPage(markup, async (page) => {
      const sidebar = page.locator('ul[aria-label="分区"] a[href="/plugins"]');
      expect(await sidebar.isVisible()).toBe(true);
      expect(
        await page
          .locator('nav[aria-label="分区"] a[href="/plugins"]')
          .isVisible(),
      ).toBe(false);
      expect(await sidebar.getAttribute("data-active")).toBe("true");
    });
    await onPage(
      markup,
      async (page) => {
        expect(
          await page
            .locator('ul[aria-label="分区"] a[href="/plugins"]')
            .isVisible(),
        ).toBe(false);
        const tab = page.locator('nav[aria-label="分区"] a[href="/plugins"]');
        expect(await tab.isVisible()).toBe(true);
        expect(await tab.getAttribute("aria-current")).toBe("page");
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth),
        ).toBe(PHONE.viewport!.width);
      },
      PHONE,
    );
  });
});
