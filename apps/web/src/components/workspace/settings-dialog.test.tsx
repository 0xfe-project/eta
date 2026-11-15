import type { FakeHost } from "@/test-wire";
import { afterEach, describe, expect, it } from "@rstest/core";
import { NuqsTestingAdapter } from "nuqs/adapters/testing";
import { setWire } from "@/lib/wire";
import { buildProductHost } from "@/test-product";
import { cleanup, flush, mount } from "@/test-render";
import { SettingsDialog } from "./settings-dialog";
import { settingsSections } from "./settings-sections";
import { useWorkspaceStore } from "./workspace-store";

// Settings' rail. An entry can be hidden without its section going away: what is hidden stays
// reachable through `?settings=<section>`, the section still renders, and the saved data behind
// it still applies.

/** The product's plugins and the inbox (the approval list's own target), mounted. */
function host(approvals: string[] = ["bash"]): FakeHost {
  const fake = buildProductHost({}, ["inbox"]).target(
    "inbox",
    { list: [], approvals: { tools: approvals } },
    { eager: true },
  );
  fake.install();
  fake.hello();
  return fake;
}

const Dialog = () => (
  <NuqsTestingAdapter>
    <SettingsDialog />
  </NuqsTestingAdapter>
);

/** The rail's entries, in the order they are listed. */
const rail = () =>
  [...document.querySelectorAll("nav button")].map(
    (entry) => entry.textContent ?? "",
  );

/** The rail's labels the list would give, for the sections named here, in the list's order. */
const labelsOf = (...values: string[]) =>
  settingsSections
    .filter((section) => values.includes(section.value))
    .map((section) => section.label);

/** What is drawn beside the rail: the section the rail points at. */
const content = () =>
  document.querySelector('nav[aria-label="设置分类"] ~ section')?.textContent ??
  "";

const highlighted = () =>
  document.querySelector("nav button[aria-current]")?.textContent ?? null;

afterEach(async () => {
  await cleanup();
  setWire(undefined);
  window.history.replaceState(null, "", "/");
  useWorkspaceStore.getState().setSettings({ open: false, section: "agents" });
});

describe("设置左侧那一列", () => {
  it("没有「需先确认的工具」，也没有已关掉的条目，其余顺序不变", async () => {
    host();
    useWorkspaceStore
      .getState()
      .setSettings({ open: true, section: "appearance" });
    await mount(<Dialog />);
    await flush();
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
    expect(rail().join("")).not.toContain("需先确认的工具");
  });

  it("?settings=approvals 仍能打开那一面，并把参数从地址里去掉", async () => {
    host(["bash"]);
    useWorkspaceStore
      .getState()
      .setSettings({ open: false, section: "appearance" });
    window.history.replaceState(null, "", "/?settings=approvals");
    await mount(<Dialog />);
    await flush();
    expect(useWorkspaceStore.getState().settings).toEqual({
      open: true,
      section: "approvals",
    });
    // The saved list is still the one edited here.
    expect(content()).toContain("bash");
    expect(window.location.search).toBe("");
    expect(rail()).not.toContain("需先确认的工具");
  });

  it("?settings= 指向不存在的分区：打开默认分区，不报错", async () => {
    host([]);
    useWorkspaceStore
      .getState()
      .setSettings({ open: false, section: "agents" });
    window.history.replaceState(null, "", "/?settings=gone");
    await mount(<Dialog />);
    await flush();
    expect(useWorkspaceStore.getState().settings).toEqual({
      open: true,
      section: "agents",
    });
    expect(window.location.search).toBe("");
  });

  it("上次停在 approvals 时重开：内容照画，那一列上没有任何高亮", async () => {
    host(["bash"]);
    useWorkspaceStore
      .getState()
      .setSettings({ open: true, section: "approvals" });
    await mount(<Dialog />);
    await flush();
    expect(content()).toContain("需先确认的工具");
    expect(content()).toContain("列在这里的工具");
    expect(content()).toContain("bash");
    expect(highlighted()).toBeNull();
  });
});
