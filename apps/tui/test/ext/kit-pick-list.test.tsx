/**
 * PickList on its own: the keys that move the marker, the window that follows it, picking, the
 * keys it leaves to its caller, and the scope that takes keys away from it.
 *
 * It renders with the settings and the language and nothing else: the list reads only the theme,
 * the language and whether its part of the screen receives keys. The covering by a real layer is
 * in kit-lists-in-shell.test.tsx.
 */
import type { PickItem } from "../../src/ext/kit/pick-list";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { PickList } from "../../src/ext/kit/pick-list";
import { LIST_KEYS } from "../ext-support/keys";
import { renderKit } from "../ext-support/render-kit";
import { flush, KEYS, plain } from "../ui-support/render";

function items(count: number): PickItem[] {
  return Array.from({ length: count }, (_, i) => ({
    key: `k${i + 1}`,
    label: `Item ${i + 1}`,
  }));
}

/** The line the marker is on, without the marker. */
function markedLine(screen: string): string | undefined {
  return screen
    .split("\n")
    .find((line) => line.trimStart().startsWith("›"))
    ?.replace("›", "")
    .trim();
}

function visibleItems(screen: string): string[] {
  return [...screen.matchAll(/Item \d+/g)].map((m) => m[0]);
}

async function pickList(
  props: Partial<Parameters<typeof PickList>[0]> & { items: PickItem[] },
  options: { locale?: "en" | "zh" } = {},
) {
  const picked: string[] = [];
  const r = renderKit(
    <PickList
      empty="Nothing here"
      onPick={(key) => picked.push(key)}
      {...props}
    />,
    options,
  );
  await flush();
  return { r, picked };
}

describe("pick list: moving and picking", () => {
  it("starts on initialKey when the items arrive after it is drawn", async () => {
    let fill: (() => void) | undefined;
    function Arriving() {
      const [list, setList] = useState<PickItem[]>([]);
      fill = () => setList(items(6));
      return (
        <PickList
          items={list}
          initialKey="k5"
          empty="loading"
          onPick={() => undefined}
        />
      );
    }
    const r = renderKit(<Arriving />);
    await flush();
    expect(plain(r)).toContain("loading");
    fill!();
    await flush();
    expect(markedLine(plain(r))).toBe("Item 5");
  });

  it("does not pick a disabled item, and goes on working after", async () => {
    const list: PickItem[] = [
      { key: "a", label: "Alpha" },
      { key: "b", label: "Beta", disabled: true },
      { key: "c", label: "Gamma" },
    ];
    const { r, picked } = await pickList({ items: list });
    await r.press(KEYS.down);
    expect(markedLine(plain(r))).toBe("Beta");
    await r.press(KEYS.enter);
    expect(picked).toEqual([]);
    await r.press(KEYS.down);
    await r.press(KEYS.enter);
    expect(picked).toEqual(["c"]);
  });

  it("draws the caller's empty text for no items, and Enter does nothing", async () => {
    const seen: (string | undefined)[] = [];
    const { r, picked } = await pickList({
      items: [],
      onKey: (_input, _key, marked) => {
        seen.push(marked);
        return true;
      },
    });
    expect(plain(r)).toContain("Nothing here");
    await r.press(KEYS.enter);
    await r.press(KEYS.down);
    await r.press("d");
    expect(picked).toEqual([]);
    expect(seen).toEqual([undefined]);
  });
});

describe("pick list: the window", () => {
  it("scrolls when the marker leaves the window, one row at a time", async () => {
    const { r } = await pickList({ items: items(25), height: 5 });
    for (let i = 0; i < 5; i += 1) await r.press(KEYS.down);
    expect(markedLine(plain(r))).toBe("Item 6");
    expect(visibleItems(plain(r))).toEqual([
      "Item 2",
      "Item 3",
      "Item 4",
      "Item 5",
      "Item 6",
    ]);
    expect(plain(r)).toContain("↑ 1 more");
    expect(plain(r)).toContain("↓ 19 more");
    // Back up inside the window: it stays put.
    await r.press(KEYS.up);
    expect(visibleItems(plain(r))[0]).toBe("Item 2");
    // Above it: it follows.
    for (let i = 0; i < 4; i += 1) await r.press(KEYS.up);
    expect(markedLine(plain(r))).toBe("Item 1");
    expect(visibleItems(plain(r))[0]).toBe("Item 1");
    expect(plain(r)).not.toContain("↑");
  });

  it("goes to the ends with Home and End", async () => {
    const { r, picked } = await pickList({ items: items(25), height: 5 });
    await r.press(LIST_KEYS.end);
    expect(markedLine(plain(r))).toBe("Item 25");
    expect(visibleItems(plain(r)).at(-1)).toBe("Item 25");
    expect(plain(r)).toContain("↑ 20 more");
    expect(plain(r)).not.toContain("↓");
    await r.press(KEYS.enter);
    await r.press(LIST_KEYS.home);
    expect(markedLine(plain(r))).toBe("Item 1");
    expect(plain(r)).toContain("↓ 20 more");
    expect(picked).toEqual(["k25"]);
  });

  it("turns a page with PageDown and PageUp, stopping at the ends", async () => {
    const { r } = await pickList({ items: items(12), height: 5 });
    await r.press(LIST_KEYS.pageDown);
    expect(markedLine(plain(r))).toBe("Item 6");
    await r.press(LIST_KEYS.pageDown);
    expect(markedLine(plain(r))).toBe("Item 11");
    await r.press(LIST_KEYS.pageDown);
    expect(markedLine(plain(r))).toBe("Item 12");
    await r.press(LIST_KEYS.pageUp);
    expect(markedLine(plain(r))).toBe("Item 7");
    await r.press(LIST_KEYS.pageUp);
    await r.press(LIST_KEYS.pageUp);
    expect(markedLine(plain(r))).toBe("Item 1");
  });
});

describe("pick list: several keys in one read", () => {
  it("picks the item a move in the same read went to", async () => {
    const { r, picked } = await pickList({ items: items(3) });
    await r.press(`${KEYS.down}${KEYS.enter}`);
    expect(picked).toEqual(["k2"]);
  });

  it("hands onKey the key a move in the same read went to", async () => {
    const seen: (string | undefined)[] = [];
    const { r } = await pickList({
      items: items(3),
      onKey: (_input, _key, marked) => {
        seen.push(marked);
        return true;
      },
    });
    await r.press(`${KEYS.down}d`);
    expect(seen).toEqual(["k2"]);
  });
});
