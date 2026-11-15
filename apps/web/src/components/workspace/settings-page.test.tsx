import { afterEach, describe, expect, it } from "@rstest/core";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { NuqsAdapter } from "nuqs/adapters/tanstack-router";
import { act } from "react";
import { setWire } from "@/lib/wire";
import { SettingsPage } from "@/pages/settings";
import { buildProductHost } from "@/test-product";
import { cleanup, flush, mount } from "@/test-render";
import { BottomNav } from "./app-shell";
import { validateSettingsSearch } from "./settings-route";
import { settingsSections } from "./settings-sections";

// Settings as a page: the phone's fourth cell is the way in, the section lives in the address, an
// address opens it directly, and back leaves the way it was entered. The bottom bar is mounted
// with the page, so the fourth cell's own state is read from the same render.

afterEach(async () => {
  await cleanup();
  setWire(undefined);
});

/** The product's plugins, as a host that has them. */
function host() {
  const fake = buildProductHost({}, ["inbox"]).target(
    "inbox",
    { list: [], approvals: { tools: [] } },
    { eager: true },
  );
  fake.install();
  fake.hello();
}

/**
 * The pages the bar links to, plus the one under test: Link resolves `to` against the tree, so
 * all four destinations have to exist even when three of them are empty.
 */
async function open(...history: string[]) {
  const root = createRootRoute({
    component: () => (
      <NuqsAdapter>
        <Outlet />
        <BottomNav />
      </NuqsAdapter>
    ),
  });
  const blank = () => null;
  const router = createRouter({
    routeTree: root.addChildren([
      createRoute({ getParentRoute: () => root, path: "/", component: blank }),
      createRoute({
        getParentRoute: () => root,
        path: "tasks",
        component: blank,
      }),
      createRoute({
        getParentRoute: () => root,
        path: "routines",
        component: blank,
      }),
      createRoute({
        getParentRoute: () => root,
        path: "settings",
        validateSearch: validateSettingsSearch,
        component: SettingsPage,
      }),
    ]),
    history: createMemoryHistory({ initialEntries: history }),
  });
  const { container } = await mount(<RouterProvider router={router} />);
  await act(async () => router.load());
  await flush();
  return { container, router };
}

/** The bar's fourth cell. */
const settingsTab = () =>
  document.querySelector<HTMLAnchorElement>('a[href="/settings"]')!;

/** Settings' own rail: the nav a screen reader calls 设置分类 (the bottom bar is a nav too). */
const railNav = () => document.querySelector('nav[aria-label="设置分类"]');

/** The rail's entries, in the order they are listed. */
const rail = () =>
  [...(railNav()?.querySelectorAll("button") ?? [])].map(
    (entry) => entry.textContent ?? "",
  );

/** The rail's labels the shared list would give, for the sections named here. */
const labelsOf = (...values: string[]) =>
  settingsSections
    .filter((section) => values.includes(section.value))
    .map((section) => section.label);

const click = async (element: HTMLElement) => {
  await act(async () => element.click());
  await flush();
};

const button = (label: string) => {
  const found = [...document.querySelectorAll<HTMLElement>("button")].find(
    (candidate) => candidate.textContent === label,
  );
  expect(found, label).toBeDefined();
  return found!;
};

describe("设置整页", () => {
  it("the fourth cell is the way in, and it is lit while you are there", async () => {
    host();
    const { router } = await open("/");
    expect(settingsTab().getAttribute("aria-current")).toBeNull();
    await click(settingsTab());
    expect(router.state.location.pathname).toBe("/settings");
    await flush();
    expect(settingsTab().getAttribute("aria-current")).toBe("page");
  });

  it("offers the same rail as the wide window's dialog", async () => {
    host();
    await open("/settings?section=appearance");
    expect(rail()).toEqual(
      labelsOf(
        "agents",
        "providers",
        "machines",
        "mcp",
        "plugins",
        "email",
        "archived",
        "appearance",
        "update",
      ),
    );
    // The address says which section, so a reload comes back to it.
    expect(document.body.textContent).toContain("颜色模式");
  });

  it("an address naming a section that does not exist shows the default one", async () => {
    host();
    await open("/settings?section=gone");
    expect(rail()).toContain(labelsOf("agents")[0]);
    expect(document.body.textContent).not.toContain("Something went wrong");
    expect(railNav()?.querySelector("[aria-current='page']")?.textContent).toBe(
      labelsOf("agents")[0],
    );
  });

  it("picking a section puts it in the address", async () => {
    host();
    const { router } = await open("/settings");
    await click(button("外观"));
    expect(router.state.location.href).toContain("section=appearance");
    expect(document.body.textContent).toContain("颜色模式");
  });

  it("back leaves settings the way it was entered", async () => {
    host();
    const { router } = await open("/tasks", "/settings");
    await click(
      document.querySelector<HTMLButtonElement>('button[aria-label="返回"]')!,
    );
    expect(router.state.location.pathname).toBe("/tasks");
  });

  it("opened in a tab of its own, back goes home instead of nowhere", async () => {
    host();
    const { router } = await open("/settings");
    await click(
      document.querySelector<HTMLButtonElement>('button[aria-label="返回"]')!,
    );
    expect(router.state.location.pathname).toBe("/");
  });
});
