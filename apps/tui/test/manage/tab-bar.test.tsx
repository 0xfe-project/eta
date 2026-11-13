/**
 * The tab bar with more tabs than fit: the pinned entries stay whole at the right end. A pinned
 * entry that waits on the user is drawn in the warning colour.
 */
import type { Extension, PinnedTab } from "../../src/extensions/types";
import type { RenderedApp } from "../ui-support/app";
import { Text } from "ink";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderApp } from "../ui-support/app";
import { plain } from "../ui-support/render";

// Ink's colour library reads this once, when it loads, so it is set before any import.
vi.hoisted(() => {
  globalThis.process.env.FORCE_COLOR = "3";
});

const open: RenderedApp[] = [];
afterEach(() => {
  for (const r of open.splice(0)) r.unmount();
});

function feature(pinned: PinnedTab[]): Extension {
  return {
    id: "zz-bar-test",
    views: [
      {
        kind: "bar-test",
        Component: () => <Text>view</Text>,
        useTitle: (tab) => tab.id,
      },
    ],
    pinnedTabs: pinned,
  };
}

async function show(
  pinned: PinnedTab[],
  tabCount: number,
  columns = 60,
): Promise<RenderedApp> {
  const ids = Array.from({ length: tabCount }, (_, i) => `tab-number-${i}`);
  const r = await renderApp({
    extensions: [feature(pinned)],
    state: { tabs: ids.map((id) => ({ kind: "bar-test", id })), activeTab: 0 },
    columns,
    rows: 12,
  });
  open.push(r);
  return r;
}

const bar = (r: RenderedApp) => plain(r).split("\n").at(-1) ?? "";
const pinned = (
  id: string,
  label: string,
  attention?: () => boolean,
): PinnedTab => ({
  id,
  useLabel: () => label,
  ...(attention === undefined ? {} : { useAttention: attention }),
  onSelect: () => {},
});

describe("a tab bar too full for the terminal", () => {
  it("cuts the open tabs and keeps the pinned entries whole at the right end", async () => {
    const r = await show(
      [pinned("zz-one", "Waiting 12"), pinned("zz-two", "Other 3")],
      12,
    );
    const line = bar(r).trimEnd();
    expect(line.endsWith("Waiting 12  Other 3")).toBe(true);
    expect(line).toContain("1:tab-number-0");
    expect(line).not.toContain("12:tab-number-11");
    expect([...bar(r)].length).toBeLessThanOrEqual(60);
    // The bar is still one line.
    expect(plain(r).split("\n")).toHaveLength(12);
  });

  it("keeps the pinned entry whole when even the first tab does not fit beside it", async () => {
    // 34 columns: the real "Pending 0" entry and this one take 32 with their gaps, and no tab fits.
    const r = await show([pinned("zz-one", "A long pinned label")], 3, 34);
    expect(bar(r).trimEnd().endsWith("A long pinned label")).toBe(true);
    expect(bar(r)).not.toContain("tab-number");
    expect([...bar(r)].length).toBeLessThanOrEqual(34);
  });
});
