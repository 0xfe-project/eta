/**
 * Tabs whose shown names are the same: each gets its view's qualifiers after the name, one more
 * at a time, until the names differ or the qualifiers run out. A tab whose name is unique, and a
 * tab of a kind without qualifiers, shows the name alone.
 */
import type { StoreApi } from "zustand/vanilla";
import type { Extension } from "../../src/extensions/types";
import type { RenderedApp } from "../ui-support/app";
import { Text } from "ink";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { renderApp } from "../ui-support/app";
import { flush, KEYS, plain } from "../ui-support/render";

// Ink's colour library reads this once, when it loads, so it is set before any import.
vi.hoisted(() => {
  globalThis.process.env.FORCE_COLOR = "3";
});

const open: RenderedApp[] = [];
afterEach(() => {
  for (const r of open.splice(0)) r.unmount();
});

interface Facts {
  title: string;
  qualifiers: readonly string[];
  status?: "running";
}

const NAMED = "names-test";
const PLAIN = "names-plain";

function feature(store: StoreApi<Record<string, Facts>>): Extension {
  return {
    id: "zz-names-test",
    views: [
      {
        kind: NAMED,
        Component: () => <Text>view</Text>,
        useTitle: (tab) => useStore(store, (s) => s[tab.id].title),
        useQualifiers: (tab) => useStore(store, (s) => s[tab.id].qualifiers),
        useStatus: (tab) => useStore(store, (s) => s[tab.id].status),
      },
      {
        kind: PLAIN,
        Component: () => <Text>view</Text>,
        useTitle: (tab) => useStore(store, (s) => s[tab.id].title),
      },
    ],
  };
}

type TabSpec = Facts & { id: string; kind?: string };

async function show(tabs: TabSpec[], activeTab = 0, columns = 160) {
  const store = createStore<Record<string, Facts>>(() =>
    Object.fromEntries(tabs.map(({ id, kind: _, ...facts }) => [id, facts])),
  );
  const r = await renderApp({
    extensions: [feature(store)],
    state: {
      tabs: tabs.map((t) => ({ kind: t.kind ?? NAMED, id: t.id })),
      activeTab,
    },
    columns,
    rows: 12,
  });
  open.push(r);
  await flush();
  return { r, store };
}

/** The open tabs of the bar, without the pinned entries at its right end. */
function tabNames(r: RenderedApp): string[] {
  const line = plain(r).split("\n").at(-1) ?? "";
  return line
    .split(/ {2,}/)
    .filter((part) => /^\d+:/.test(part))
    .map((part) => part.trimEnd());
}

const tab = (
  id: string,
  title: string,
  qualifiers: string[],
  extra: Partial<TabSpec> = {},
): TabSpec => ({ id, title, qualifiers, ...extra });

describe("tabs with the same shown name", () => {
  it("adds the first qualifier to both when it tells them apart", async () => {
    const { r } = await show([
      tab("a", "demo-project", ["Ada", "aaaaaa"]),
      tab("b", "demo-project", ["Ben", "bbbbbb"]),
    ]);
    expect(tabNames(r)).toEqual([
      "1:demo-project (Ada)",
      "2:demo-project (Ben)",
    ]);
  });

  it("adds the second qualifier when the first is the same for both", async () => {
    const { r } = await show([
      tab("a", "demo-project", ["Ada", "aaaaaa"]),
      tab("b", "demo-project", ["Ada", "bbbbbb"]),
    ]);
    expect(tabNames(r)).toEqual([
      "1:demo-project (Ada · aaaaaa)",
      "2:demo-project (Ada · bbbbbb)",
    ]);
  });

  it("goes on to the second qualifier only for the tabs the first leaves alike", async () => {
    const { r } = await show([
      tab("a", "demo-project", ["Ada", "aaaaaa"]),
      tab("b", "demo-project", ["Ada", "bbbbbb"]),
      tab("c", "demo-project", ["Ben", "cccccc"]),
    ]);
    expect(tabNames(r)).toEqual([
      "1:demo-project (Ada · aaaaaa)",
      "2:demo-project (Ada · bbbbbb)",
      "3:demo-project (Ben)",
    ]);
  });

  it("compares the names as cut to the bar's width, and keeps the qualifier whole", async () => {
    const { r } = await show([
      tab("a", "a-very-long-project-name-one", ["Ada", "aaaaaa"]),
      tab("b", "a-very-long-project-name-two", [
        "Ben-the-long-named",
        "bbbbbb",
      ]),
    ]);
    expect(tabNames(r)).toEqual([
      "1:a-very-long-project… (Ada)",
      "2:a-very-long-project… (Ben-the-long-named)",
    ]);
  });

  it("uses what qualifiers a tab has: one without the first goes by the next", async () => {
    // A conversation without a steward has only its id prefix.
    const { r } = await show([
      tab("a", "demo-project", ["aaaaaa"]),
      tab("b", "demo-project", ["Ada", "bbbbbb"]),
    ]);
    expect(tabNames(r)).toEqual([
      "1:demo-project (aaaaaa)",
      "2:demo-project (Ada)",
    ]);
  });

  it("shows all the qualifiers when even they leave the names alike", async () => {
    const { r } = await show([
      tab("a", "demo-project", ["Ada"]),
      tab("b", "demo-project", ["Ada"]),
    ]);
    expect(tabNames(r)).toEqual([
      "1:demo-project (Ada)",
      "2:demo-project (Ada)",
    ]);
  });

  it("shows the name alone for tabs without qualifiers", async () => {
    const { r } = await show([
      tab("a", "demo-project", []),
      tab("b", "demo-project", []),
    ]);
    expect(tabNames(r)).toEqual(["1:demo-project", "2:demo-project"]);
  });
});

describe("tabs that need no qualifier", () => {
  it("adds nothing to a name no other tab shows", async () => {
    const { r } = await show([
      tab("a", "demo-project", ["Ada", "aaaaaa"]),
      tab("b", "demo-project", ["Ben", "bbbbbb"]),
      tab("c", "other", ["Ada", "cccccc"]),
    ]);
    expect(tabNames(r)).toEqual([
      "1:demo-project (Ada)",
      "2:demo-project (Ben)",
      "3:other",
    ]);
  });

  it("adds nothing to a tab of a kind without qualifiers", async () => {
    const { r } = await show([
      tab("a", "demo-project", [], { kind: PLAIN }),
      tab("b", "demo-project", [], { kind: PLAIN }),
    ]);
    expect(tabNames(r)).toEqual(["1:demo-project", "2:demo-project"]);
  });

  it("leaves a tab of an unknown kind showing its id", async () => {
    const { r } = await show([
      tab("a", "demo-project", ["Ada"]),
      tab("demo-project", "", [], { kind: "nobody-draws-this" }),
    ]);
    expect(tabNames(r)).toEqual(["1:demo-project", "2:demo-project"]);
  });
});

describe("qualifiers as the names change", () => {
  it("drops the qualifiers once a rename makes the names differ", async () => {
    const { r, store } = await show([
      tab("a", "demo-project", ["Ada", "aaaaaa"]),
      tab("b", "demo-project", ["Ben", "bbbbbb"]),
    ]);
    expect(tabNames(r)).toEqual([
      "1:demo-project (Ada)",
      "2:demo-project (Ben)",
    ]);
    store.setState({ b: { title: "renamed", qualifiers: ["Ben", "bbbbbb"] } });
    await flush();
    expect(tabNames(r)).toEqual(["1:demo-project", "2:renamed"]);
  });

  it("follows a changed qualifier", async () => {
    const { r, store } = await show([
      tab("a", "demo-project", ["Ada", "aaaaaa"]),
      tab("b", "demo-project", ["Ben", "bbbbbb"]),
    ]);
    store.setState({
      b: { title: "demo-project", qualifiers: ["Ada", "bbbbbb"] },
    });
    await flush();
    expect(tabNames(r)).toEqual([
      "1:demo-project (Ada · aaaaaa)",
      "2:demo-project (Ada · bbbbbb)",
    ]);
  });
});

describe("qualifiers as tabs close", () => {
  it("drops the qualifier of the tab left once the other of its name is closed", async () => {
    const { r } = await show(
      [
        tab("a", "demo-project", ["Ada", "aaaaaa"]),
        tab("b", "demo-project", ["Ben", "bbbbbb"]),
      ],
      1,
    );
    expect(tabNames(r)).toEqual([
      "1:demo-project (Ada)",
      "2:demo-project (Ben)",
    ]);
    await r.press(KEYS.ctrlW); // tabs.close in the test settings
    expect(tabNames(r)).toEqual(["1:demo-project"]);
  });
});

describe("the look of a qualified tab", () => {
  it("puts the status mark after the qualifier", async () => {
    const { r } = await show([
      tab("a", "demo-project", ["Ada"], { status: "running" }),
      tab("b", "demo-project", ["Ben"]),
    ]);
    expect(tabNames(r)).toEqual([
      "1:demo-project (Ada) ●",
      "2:demo-project (Ben)",
    ]);
  });

  it("draws the qualifier in the name's colour, the active one's included", async () => {
    const { r } = await show(
      [tab("a", "demo-project", ["Ada"]), tab("b", "demo-project", ["Ben"])],
      1,
    );
    const raw = r.lastFrame().split("\n").at(-1) ?? "";
    // Each in one run of its style: no colour change between the number, the name and the qualifier.
    expect(raw).toContain("1:demo-project (Ada)");
    expect(raw).toContain("2:demo-project (Ben)");
  });
});
