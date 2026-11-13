import type { KeyBinding, TuiConfig } from "../../src/config/types";
/**
 * The transcript drawn in memory and driven with real keys: scrolling, the "below" hint, search,
 * selection, copying, folding. The items are drawn here (not by `render/`), so every line is known.
 */
import type {
  RenderedItem,
  TranscriptItem,
} from "../../src/ext/conversation/contract";
import type { TranscriptUi } from "../../src/ext/conversation/transcript/ui";
import { useState, useSyncExternalStore } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStore } from "zustand/vanilla";
import { Transcript } from "../../src/ext/conversation/transcript/transcript";
import { INITIAL_TRANSCRIPT_UI } from "../../src/ext/conversation/transcript/ui";
import { ConfigContext } from "../../src/extensions/react";
import { LocaleContext } from "../../src/i18n/react";
import { testConfig } from "../ui-support/config";
import { flush, KEYS, plain, realDelay, renderInk } from "../ui-support/render";

// Ink's colour library reads this once, when it loads, so it is set before any import.
vi.hoisted(() => {
  globalThis.process.env.FORCE_COLOR = "3";
});

const KEY = {
  pageUp: "\u001B[5~",
  pageDown: "\u001B[6~",
  lineUp: "\u001B[1;2A",
  lineDown: "\u001B[1;2B",
  top: "\u001B[1;5H",
  bottom: "\u001B[1;5F",
  home: "\u001B[H",
  end: "\u001B[F",
  search: "\u0006",
  select: "\u001Bv",
  expandAll: "\u000F",
};

/** The search bar as plain text: the input draws its cursor as one cell after the query. */
const bar = (query: string, where: string) => `/ ${query}   ${where}`;

const GREEN = (text: string) => `\u001B[32m${text}\u001B[39m`;

interface Source {
  items: TranscriptItem[];
  rendered: RenderedItem[];
  hasOlder: boolean;
  loadingOlder: boolean;
  active: boolean;
  /** The settings as `useConfig()` reads them; changing them is a change through `/config`. */
  config: TuiConfig;
}

/** `count` items of `each` lines, keyed `${prefix}${i}`, plain lines `${prefix}${i}.${j}`. */
function block(count: number, each: number, prefix = "item", foldable = false) {
  const items: TranscriptItem[] = [];
  const rendered: RenderedItem[] = [];
  for (let i = 0; i < count; i += 1) {
    const key = `${prefix}${i}`;
    items.push({ kind: "text", key, text: key, streaming: false });
    const plainLines = Array.from({ length: each }, (_, j) => `${key}.${j}`);
    rendered.push({
      lines: plainLines.map(GREEN),
      plain: plainLines,
      source: `source of ${key}`,
      foldable,
    });
  }
  return { items, rendered };
}

/**
 * `source` with the items at the given indexes drawn in that many lines (`${key}.${j}`), as
 * folding or unfolding draws them; each changed item is a new object.
 */
function withLines(
  source: Pick<Source, "items" | "rendered">,
  counts: Record<number, number>,
): Pick<Source, "items" | "rendered"> {
  const items = source.items.map((item, index) =>
    counts[index] === undefined ? item : { ...item },
  );
  const rendered = source.rendered.map((drawn, index) => {
    const count = counts[index];
    if (count === undefined) return drawn;
    const plainLines = Array.from(
      { length: count },
      (_, j) => `${source.items[index]!.key}.${j}`,
    );
    return { ...drawn, lines: plainLines.map(GREEN), plain: plainLines };
  });
  return { items, rendered };
}

/** `config` with `transcript.bottom` bound to `keys`. */
function withBottomKeys(config: TuiConfig, keys: KeyBinding[]): TuiConfig {
  return {
    ...config,
    keybindings: { ...config.keybindings, "transcript.bottom": keys },
  };
}

const mounted: { unmount: () => void }[] = [];
afterEach(() => {
  for (const one of mounted.splice(0)) one.unmount();
});

function mount(
  initial: Partial<Source>,
  options: {
    height?: number;
    width?: number;
    ui?: Partial<TranscriptUi>;
    locale?: "en" | "zh";
  } = {},
) {
  const source = createStore<Source>(() => ({
    items: [],
    rendered: [],
    hasOlder: false,
    loadingOlder: false,
    active: true,
    config: testConfig(),
    ...initial,
  }));
  const seen = {
    ui: { ...INITIAL_TRANSCRIPT_UI, ...options.ui } as TranscriptUi,
    reachedTop: 0,
    copies: [] as string[],
    notes: [] as string[],
    modes: [] as string[],
    /** Every update the transcript asked for, oldest first. */
    updates: [] as Partial<TranscriptUi>[],
  };
  function Harness() {
    const state = useSyncExternalStore(source.subscribe, source.getState);
    const [ui, setUi] = useState<TranscriptUi>(seen.ui);
    seen.ui = ui;
    return (
      <ConfigContext value={state.config}>
        <Transcript
          items={state.items}
          rendered={state.rendered}
          height={options.height ?? 10}
          width={options.width ?? 40}
          isActive={state.active}
          ui={ui}
          onUi={(update) => {
            seen.updates.push(update);
            setUi((was) => ({ ...was, ...update }));
          }}
          hasOlder={state.hasOlder}
          loadingOlder={state.loadingOlder}
          onReachTop={() => {
            seen.reachedTop += 1;
          }}
          onNotify={(text) => seen.notes.push(text)}
          copy={(text) => seen.copies.push(text)}
          onModeChange={(mode) => seen.modes.push(mode)}
        />
      </ConfigContext>
    );
  }
  const rendered = renderInk(
    <LocaleContext value={options.locale ?? "en"}>
      <Harness />
    </LocaleContext>,
    { columns: options.width ?? 40, rows: (options.height ?? 10) + 2 },
  );
  mounted.push(rendered);
  const rows = () =>
    plain(rendered)
      .split("\n")
      .map((line) => line.trimEnd());
  return { ...rendered, source, seen, rows };
}

describe("scrolling", () => {
  it("follows the newest line: the last `height` lines, and no hint", async () => {
    // 10 items of 2 lines with 9 blank lines between: 29 lines.
    const view = mount(block(10, 2));
    await flush();
    const rows = view.rows();
    expect(rows.slice(0, 10)).toEqual([
      "item6.1",
      "",
      "item7.0",
      "item7.1",
      "",
      "item8.0",
      "item8.1",
      "",
      "item9.0",
      "item9.1",
    ]);
    expect(view.lastFrame()).toContain(GREEN("item9.1"));
    expect(plain(view)).not.toContain("below");
  });

  it("a page up shows the hint with the key back to the bottom, a page down comes back", async () => {
    const view = mount(block(10, 2));
    await flush();
    await view.press(KEY.pageUp);
    // 29 lines, following top 19; up 9 to top 10, 9 rows of lines: 10 lines below.
    expect(view.rows().slice(0, 10)).toEqual([
      "item3.1",
      "",
      "item4.0",
      "item4.1",
      "",
      "item5.0",
      "item5.1",
      "",
      "item6.0",
      "↓ ctrl+end to go to the bottom",
    ]);
    await view.press(KEY.pageDown);
    await view.press(KEY.pageDown);
    expect(view.rows()[9]).toBe("item9.1");
    expect(view.seen.ui.scroll).toEqual({ follow: true });
  });

  it("says the hint in Chinese", async () => {
    const view = mount(block(10, 2), { locale: "zh" });
    await flush();
    await view.press(KEY.pageUp);
    expect(view.rows()[9]).toBe("↓ ctrl+end 回到最下面");
  });

  it("names the first key bound to going to the bottom", async () => {
    const config = testConfig();
    const view = mount({
      ...block(10, 2),
      config: withBottomKeys(config, [
        { key: "b", ctrl: false, alt: true, shift: false },
        { key: "end", ctrl: true, alt: false, shift: false },
      ]),
    });
    await flush();
    await view.press(KEY.pageUp);
    expect(view.rows()[9]).toBe("↓ alt+b to go to the bottom");
  });

  it("counts the lines below when no key goes to the bottom", async () => {
    const unbound = withBottomKeys(testConfig(), []);
    const en = mount({ ...block(10, 2), config: unbound });
    await flush();
    await en.press(KEY.pageUp);
    expect(en.rows()[9]).toBe("↓ 10 lines below");
    // One line up from the bottom, the fewest a view away from it leaves: 2.
    const near = mount({ ...block(10, 2), config: unbound });
    await flush();
    await near.press(KEY.lineUp);
    expect(near.rows()[9]).toBe("↓ 2 lines below");
    const zh = mount({ ...block(10, 2), config: unbound }, { locale: "zh" });
    await flush();
    await zh.press(KEY.pageUp);
    expect(zh.rows()[9]).toBe("↓ 10 行在下面");
  });

  it("follows a key rebound in the settings at once", async () => {
    const view = mount(block(10, 2));
    await flush();
    await view.press(KEY.pageUp);
    expect(view.rows()[9]).toBe("↓ ctrl+end to go to the bottom");
    const rebound = withBottomKeys(view.source.getState().config, [
      { key: "b", ctrl: false, alt: true, shift: false },
    ]);
    view.source.setState({ config: rebound });
    await flush();
    expect(view.rows()[9]).toBe("↓ alt+b to go to the bottom");
    view.source.setState({ config: withBottomKeys(rebound, []) });
    await flush();
    expect(view.rows()[9]).toBe("↓ 10 lines below");
  });

  it("goes to the top and back to the bottom", async () => {
    const view = mount(block(10, 2));
    await flush();
    await view.press(KEY.top);
    expect(view.rows()[0]).toBe("item0.0");
    await view.press(KEY.bottom);
    expect(view.rows()[9]).toBe("item9.1");
    expect(view.seen.ui.scroll).toEqual({ follow: true });
  });

  it("follows again after lines up and as many back down, with the last line on screen", async () => {
    for (const lines of [1, 6]) {
      const view = mount(block(10, 2));
      await flush();
      for (let i = 0; i < lines; i += 1) await view.press(KEY.lineUp);
      expect(view.rows()[9]).toBe("↓ ctrl+end to go to the bottom");
      for (let i = 0; i < lines; i += 1) await view.press(KEY.lineDown);
      expect(view.rows()[9]).toBe("item9.1");
      expect(plain(view)).not.toContain("go to the bottom");
      expect(view.seen.ui.scroll).toEqual({ follow: true });
    }
  });

  it("follows again after a page up and one page down", async () => {
    const view = mount(block(10, 2));
    await flush();
    await view.press(KEY.pageUp);
    await view.press(KEY.pageDown);
    expect(view.rows()[9]).toBe("item9.1");
    expect(view.seen.ui.scroll).toEqual({ follow: true });
  });

  it("keeps following while the last item grows", async () => {
    const view = mount(block(10, 2));
    await flush();
    const { items, rendered } = block(10, 2);
    rendered[9] = {
      ...rendered[9]!,
      lines: ["a", "b", "c"].map(GREEN),
      plain: ["a", "b", "c"],
    };
    view.source.setState({
      items: [...items.slice(0, 9), { ...items[9]! }],
      rendered,
    });
    await flush();
    expect(view.rows()[9]).toBe("c");
  });

  it("follows again once fewer lines bring the last one on screen, and keeps following as lines come", async () => {
    const view = mount(block(10, 2));
    await flush();
    // Up one line from top 19 to top 18: 9 rows of lines, 2 below.
    await view.press(KEY.lineUp);
    expect(view.rows()[9]).toBe("↓ ctrl+end to go to the bottom");
    // Items 8 and 9 down to one line each: 27 lines, and the 9 rows from top 18 reach the last.
    view.source.setState(withLines(view.source.getState(), { 8: 1, 9: 1 }));
    await flush();
    expect(view.rows()[9]).toBe("item9.0");
    expect(view.seen.ui.scroll).toEqual({ follow: true });
    // Item 9 unfolds to four lines: the view stays on the newest line.
    view.source.setState(withLines(view.source.getState(), { 9: 4 }));
    await flush();
    expect(view.rows()[9]).toBe("item9.3");
    expect(plain(view)).not.toContain("go to the bottom");
  });

  it("asks once to follow again, not on every drawing after", async () => {
    const view = mount(block(10, 2));
    await flush();
    await view.press(KEY.lineUp);
    const before = view.seen.updates.length;
    view.source.setState(withLines(view.source.getState(), { 8: 1, 9: 1 }));
    await flush();
    view.source.setState({ active: false });
    await flush();
    view.source.setState({ active: true });
    await flush();
    const scrollUpdates = view.seen.updates
      .slice(before)
      .filter((update) => update.scroll !== undefined);
    expect(scrollUpdates.map((update) => update.scroll)).toEqual([
      { follow: true },
    ]);
  });

  it("stays where it is when fewer lines still leave the last one below", async () => {
    const view = mount(block(10, 2));
    await flush();
    await view.press(KEY.pageUp);
    const before = view.rows().slice(0, 9);
    // 28 lines; the 9 rows from top 10 end at line 18.
    view.source.setState(withLines(view.source.getState(), { 9: 1 }));
    await flush();
    view.source.setState(withLines(view.source.getState(), { 9: 6 }));
    await flush();
    expect(view.rows().slice(0, 9)).toEqual(before);
    expect(view.rows()[9]).toBe("↓ ctrl+end to go to the bottom");
    expect(view.seen.ui.scroll.follow).toBe(false);
  });

  it("keeps what is on screen while the last item grows when not following", async () => {
    const view = mount(block(10, 2));
    await flush();
    await view.press(KEY.pageUp);
    const before = view.rows().slice(0, 9);
    const { items, rendered } = block(10, 2);
    rendered[9] = {
      ...rendered[9]!,
      lines: ["a", "b", "c", "d"].map(GREEN),
      plain: ["a", "b", "c", "d"],
    };
    view.source.setState({
      items: [...items.slice(0, 9), { ...items[9]! }],
      rendered,
    });
    await flush();
    expect(view.rows().slice(0, 9)).toEqual(before);
    expect(view.rows()[9]).toBe("↓ ctrl+end to go to the bottom");
  });

  it("keeps what is on screen when an older page comes in on top", async () => {
    const view = mount(block(10, 2));
    await flush();
    await view.press(KEY.pageUp);
    const before = view.rows();
    const older = block(3, 2, "old");
    const now = view.source.getState();
    view.source.setState({
      items: [...older.items, ...now.items],
      rendered: [...older.rendered, ...now.rendered],
    });
    await flush();
    expect(view.rows()).toEqual(before);
  });

  it("asks for older rows once on reaching the top, and not while a page is on its way", async () => {
    const view = mount({ ...block(10, 2), hasOlder: true });
    await flush();
    await view.press(KEY.lineUp);
    expect(view.seen.reachedTop).toBe(0);
    await view.press(KEY.top);
    expect(view.seen.reachedTop).toBe(1);
    view.source.setState({ loadingOlder: true });
    await flush();
    await view.press(KEY.lineDown);
    await view.press(KEY.lineUp);
    expect(view.seen.reachedTop).toBe(1);
  });

  it("does not ask for older rows when there are none", async () => {
    const view = mount(block(10, 2));
    await flush();
    await view.press(KEY.top);
    expect(view.seen.reachedTop).toBe(0);
  });

  it("draws nothing for an empty conversation and moves nowhere", async () => {
    const view = mount({});
    await flush();
    await view.press(KEY.pageUp);
    expect(view.rows().join("").trim()).toBe("");
    expect(view.seen.ui.scroll).toEqual({ follow: true });
  });

  it("at height 1 draws one row", async () => {
    const view = mount(block(3, 2), { height: 1 });
    await flush();
    expect(view.rows()[0]).toBe("item2.1");
    expect(view.rows()[1] ?? "").toBe("");
  });

  it("does not move while not active", async () => {
    const view = mount({ ...block(10, 2), active: false });
    await flush();
    await view.press(KEY.pageUp);
    expect(view.seen.ui.scroll).toEqual({ follow: true });
  });
});

describe("search", () => {
  it("counts matches, jumps to the nearest above the view's bottom, and highlights them", async () => {
    const view = mount(block(10, 2));
    await flush();
    await view.press(KEY.search);
    expect(view.seen.modes.at(-1)).toBe("search");
    await view.type(".1");
    // Ten ".1" lines; the newest is on screen at the bottom.
    expect(view.rows()[9]).toBe(bar(".1", "10/10"));
    const frame = view.lastFrame();
    expect(frame).toContain("\u001B[7m.1\u001B[27m");
    // The current match is drawn in the selection colour (blue background in the test theme).
    expect(frame).toContain("\u001B[44m.1");
  });

  it("goes to older matches with Enter and up, newer with down, round at both ends", async () => {
    const view = mount(block(10, 2));
    await flush();
    await view.press(KEY.search);
    await view.type("item");
    // 20 matches; current is the newest.
    expect(view.rows()[9]).toBe(bar("item", "20/20"));
    await view.press(KEYS.enter);
    expect(view.rows()[9]).toBe(bar("item", "19/20"));
    await view.press(KEYS.up);
    expect(view.rows()[9]).toBe(bar("item", "18/20"));
    await view.press(KEYS.down);
    await view.press(KEYS.down);
    await view.press(KEYS.down);
    expect(view.rows()[9]).toBe(bar("item", "1/20"));
    await view.press(KEYS.up);
    expect(view.rows()[9]).toBe(bar("item", "20/20"));
  });

  it("brings an older match into view", async () => {
    const view = mount(block(10, 2));
    await flush();
    await view.press(KEY.search);
    await view.type("item0.0");
    expect(view.rows()).toContain("item0.0");
    expect(view.rows()[9]).toBe(bar("item0.0", "1/1"));
  });

  it("says when nothing matches, ignoring case otherwise", async () => {
    const view = mount(block(3, 1));
    await flush();
    await view.press(KEY.search);
    await view.type("zzz");
    expect(view.rows()[9]).toBe(bar("zzz", "No matches"));
    await view.press(KEYS.backspace);
    await view.press(KEYS.backspace);
    await view.press(KEYS.backspace);
    await view.type("ITEM1");
    expect(view.rows()[9]).toBe(bar("ITEM1", "1/1"));
  });

  it("turns a pasted line break into a space", async () => {
    const view = mount(block(3, 1));
    await flush();
    await view.press(KEY.search);
    await view.press(KEYS.paste("a\nb"));
    expect(view.rows()[9]).toBe(bar("a b", "No matches"));
  });

  it("closes with Escape, leaving the view where the search put it", async () => {
    const view = mount(block(10, 2));
    await flush();
    await view.press(KEY.search);
    await view.type("item0.0");
    const scroll = view.seen.ui.scroll;
    await view.press(KEYS.escape);
    expect(view.seen.ui.search).toBeUndefined();
    expect(view.seen.ui.scroll).toEqual(scroll);
    expect(plain(view)).not.toContain("/ item0.0");
    expect(view.lastFrame()).not.toContain("\u001B[7m");
    expect(view.seen.modes.at(-1)).toBe("normal");
  });
});

describe("selection", () => {
  it("starts on the last line on screen, drawn inverted, with the keys on the last row", async () => {
    const view = mount(block(10, 2), { width: 80 });
    await flush();
    await view.press(KEY.select);
    expect(view.seen.modes.at(-1)).toBe("select");
    const rows = view.rows();
    expect(rows[9]).toBe(
      "↑↓ move  v mark range  y copy lines  c copy item  space fold  Esc done",
    );
    // The keys take the last row, so the cursor is on the line above it.
    expect(rows[8]).toBe("item9.1");
    expect(view.lastFrame()).toContain("\u001B[7mitem9.1\u001B[27m");
  });

  it("copies the cursor line, trimmed, says so, and leaves selection", async () => {
    const view = mount(block(10, 2));
    await flush();
    await view.press(KEY.select);
    await view.press(KEYS.up);
    await view.press("y");
    expect(view.seen.copies).toEqual(["item9.0"]);
    expect(view.seen.notes).toEqual(["Copied 1 line"]);
    expect(view.seen.modes.at(-1)).toBe("normal");
    expect(view.rows()[9]).toBe("item9.1");
  });

  it("copies a range marked downward from the cursor with Enter", async () => {
    const view = mount(block(10, 2));
    await flush();
    await view.press(KEY.select);
    await view.press(KEYS.up);
    await view.press(KEYS.up);
    await view.press(KEYS.up);
    await view.press("v");
    await view.press(KEYS.down);
    await view.press(KEYS.down);
    expect(view.lastFrame()).toContain("\u001B[44mitem8.1");
    await view.press(KEYS.enter);
    expect(view.seen.copies).toEqual(["item8.1\n\nitem9.0"]);
    expect(view.seen.notes).toEqual(["Copied 3 lines"]);
  });

  it("copies a range whose start is below the cursor", async () => {
    const view = mount(block(10, 2));
    await flush();
    await view.press(KEY.select);
    await view.press("v");
    await view.press(KEYS.up);
    await view.press(KEYS.up);
    await view.press("y");
    // The cursor went up to the blank line over item9: three lines, the first empty.
    expect(view.seen.copies).toEqual(["\nitem9.0\nitem9.1"]);
    expect(view.seen.notes).toEqual(["Copied 3 lines"]);
  });

  it("copies the item under the cursor as written", async () => {
    const view = mount(block(10, 2));
    await flush();
    await view.press(KEY.select);
    await view.press("c");
    expect(view.seen.copies).toEqual(["source of item9"]);
    expect(view.seen.notes).toEqual(["Copied"]);
  });

  it("moves by pages and to either end, the view following the cursor", async () => {
    const view = mount(block(10, 2));
    await flush();
    await view.press(KEY.select);
    await view.press(KEY.home);
    expect(view.rows()[0]).toBe("item0.0");
    expect(view.lastFrame()).toContain("\u001B[7mitem0.0\u001B[27m");
    await view.press(KEYS.down);
    await view.press(KEY.pageDown);
    // 10 rows, less the keys row: a page is 8 lines, from line 1 to line 9.
    expect(view.lastFrame()).toContain("\u001B[7mitem3.0\u001B[27m");
    await view.press(KEY.end);
    expect(view.lastFrame()).toContain("\u001B[7mitem9.1\u001B[27m");
    expect(view.rows()[8]).toBe("item9.1");
    await view.press(KEYS.up);
    await view.press(KEY.pageUp);
    // From line 27 up 8 to line 19.
    expect(view.lastFrame()).toContain("\u001B[7mitem6.1\u001B[27m");
  });

  it("folds the item under the cursor with space and puts the cursor on its first line", async () => {
    const view = mount(block(10, 2, "item", true));
    await flush();
    await view.press(KEY.select);
    await view.press(" ");
    expect([...view.seen.ui.expanded]).toEqual(["item9"]);
    expect(view.lastFrame()).toContain("\u001B[7mitem9.0\u001B[27m");
    await view.press(" ");
    expect([...view.seen.ui.expanded]).toEqual([]);
  });

  it("does not fold an item that cannot fold", async () => {
    const view = mount(block(10, 2));
    await flush();
    await view.press(KEY.select);
    await view.press(" ");
    expect(view.seen.ui.expanded.size).toBe(0);
  });

  it("leaves with Escape without copying", async () => {
    const view = mount(block(10, 2));
    await flush();
    await view.press(KEY.select);
    await view.press(KEYS.escape);
    expect(view.seen.copies).toEqual([]);
    expect(view.seen.modes.at(-1)).toBe("normal");
    expect(view.lastFrame()).not.toContain("\u001B[7m");
  });
});

/** `rendered` for `items` where the item keyed `key` draws `lines` instead. */
function redrawn(
  source: Pick<Source, "items" | "rendered">,
  key: string,
  lines: string[],
): RenderedItem[] {
  return source.rendered.map((drawn, i) =>
    source.items[i]!.key === key
      ? { ...drawn, lines: lines.map(GREEN), plain: lines }
      : drawn,
  );
}

/** `source` with `older` items put before it. */
function withOlder(
  source: Pick<Source, "items" | "rendered">,
  older: Pick<Source, "items" | "rendered">,
) {
  return {
    items: [...older.items, ...source.items],
    rendered: [...older.rendered, ...source.rendered],
  };
}

describe("older pages", () => {
  it("asks once per reach of the top: a page settling while the view stays on top asks nothing more", async () => {
    const view = mount({ ...block(10, 2), hasOlder: true });
    await flush();
    await view.press(KEY.top);
    expect(view.seen.reachedTop).toBe(1);
    // The page came back empty, failed, or is not drawn yet: the view is still on the first line.
    for (let i = 0; i < 3; i += 1) {
      view.source.setState({ loadingOlder: true });
      await flush();
      view.source.setState({ loadingOlder: false });
      await flush();
    }
    expect(view.seen.reachedTop).toBe(1);
  });

  it("asks again on the next scroll up that reaches the top, also from the top itself", async () => {
    const view = mount({ ...block(10, 2), hasOlder: true });
    await flush();
    await view.press(KEY.top);
    view.source.setState({ loadingOlder: true });
    await flush();
    view.source.setState({ loadingOlder: false });
    await flush();
    await view.press(KEY.lineUp);
    expect(view.seen.reachedTop).toBe(2);
    await view.press(KEY.pageUp);
    expect(view.seen.reachedTop).toBe(3);
  });

  it("asks nothing for a conversation that fits on screen until a scroll up", async () => {
    const view = mount({ ...block(2, 1), hasOlder: true });
    await flush();
    await realDelay(30);
    expect(view.seen.reachedTop).toBe(0);
    await view.press(KEY.lineUp);
    expect(view.seen.reachedTop).toBe(1);
  });

  it("asks when the selection cursor reaches the top", async () => {
    const view = mount({ ...block(10, 2), hasOlder: true });
    await flush();
    await view.press(KEY.select);
    await view.press(KEY.home);
    expect(view.seen.reachedTop).toBe(1);
  });

  it("keeps what is on screen through later redraws after an older page comes in on top", async () => {
    const view = mount(block(10, 2));
    await flush();
    await view.press(KEY.pageUp);
    const before = view.rows();
    view.source.setState(withOlder(view.source.getState(), block(3, 2, "old")));
    await flush();
    expect(view.rows()).toEqual(before);
    // Each of these draws the transcript again from what `ui` holds.
    await view.press(KEY.lineDown);
    await view.press(KEY.lineUp);
    view.source.setState({ ...view.source.getState() });
    await flush();
    expect(view.rows()).toEqual(before);
    await view.press(KEY.expandAll);
    expect(view.rows()).toEqual(before);
  });
});

describe("lines that move under the view", () => {
  it("keeps what is on screen when items above it draw more lines", async () => {
    const view = mount(block(10, 2));
    await flush();
    await view.press(KEY.pageUp);
    const before = view.rows();
    const now = view.source.getState();
    view.source.setState({
      rendered: redrawn(now, "item1", ["item1.0", "a", "b", "c", "item1.1"]),
    });
    await flush();
    expect(view.rows()).toEqual(before);
  });

  it("copies the lines that were marked after an older page comes in on top", async () => {
    const view = mount({ ...block(10, 2), hasOlder: true });
    await flush();
    await view.press(KEY.select);
    await view.press(KEY.home);
    await view.press("v");
    await view.press(KEYS.down);
    view.source.setState(withOlder(view.source.getState(), block(5, 2, "old")));
    await flush();
    expect(view.lastFrame()).toContain("\u001B[7mitem0.1\u001B[27m");
    await view.press("y");
    expect(view.seen.copies).toEqual(["item0.0\nitem0.1"]);
    expect(view.seen.notes).toEqual(["Copied 2 lines"]);
  });

  it("copies the lines that were marked after expand-all draws an item above them longer", async () => {
    const view = mount(block(10, 2, "item", true));
    await flush();
    await view.press(KEY.select);
    await view.press(KEYS.up);
    await view.press("v");
    await view.press(KEYS.down);
    await view.press(KEY.expandAll);
    expect(view.seen.ui.expandAll).toBe(true);
    const now = view.source.getState();
    view.source.setState({
      rendered: redrawn(now, "item8", ["item8.0", "item8.1", "x", "y"]),
    });
    await flush();
    await view.press("y");
    expect(view.seen.copies).toEqual(["item9.0\nitem9.1"]);
  });

  it("keeps a range's start below an item that folds", async () => {
    const source = block(10, 2, "item", true);
    const view = mount({
      items: source.items,
      rendered: redrawn(source, "item8", [
        "item8.0",
        "item8.1",
        "item8.2",
        "item8.3",
      ]),
    });
    await flush();
    await view.press(KEY.select);
    await view.press("v");
    await view.press(KEYS.up);
    await view.press(KEYS.up);
    await view.press(KEYS.up);
    expect(view.lastFrame()).toContain("\u001B[7mitem8.3\u001B[27m");
    await view.press(" ");
    view.source.setState({ rendered: source.rendered });
    await flush();
    await view.press("y");
    expect(view.seen.copies).toEqual(["item8.0\nitem8.1\n\nitem9.0\nitem9.1"]);
    expect(view.seen.notes).toEqual(["Copied 5 lines"]);
  });

  it("puts the cursor on the last line left when the item under it gets shorter", async () => {
    const source = block(10, 2);
    const long = ["item9.0", "item9.1", "item9.2", "item9.3"];
    const view = mount({
      items: source.items,
      rendered: redrawn(source, "item9", long),
    });
    await flush();
    await view.press(KEY.select);
    expect(view.lastFrame()).toContain("\u001B[7mitem9.3\u001B[27m");
    view.source.setState({ rendered: source.rendered });
    await flush();
    expect(view.lastFrame()).toContain("\u001B[7mitem9.1\u001B[27m");
    await view.press("y");
    expect(view.seen.copies).toEqual(["item9.1"]);
    expect(view.seen.notes).toEqual(["Copied 1 line"]);
  });

  it("puts the cursor on the nearest item when the item under it is gone", async () => {
    const view = mount(block(10, 2));
    await flush();
    await view.press(KEY.select);
    const now = view.source.getState();
    view.source.setState({
      items: now.items.slice(0, 9),
      rendered: now.rendered.slice(0, 9),
    });
    await flush();
    await view.press("y");
    expect(view.seen.copies).toEqual(["item8.1"]);
  });

  it("copies nothing from blank lines, and says so", async () => {
    const view = mount(block(10, 2));
    await flush();
    await view.press(KEY.select);
    await view.press(KEYS.up);
    await view.press(KEYS.up);
    await view.press("y");
    expect(view.seen.copies).toEqual([]);
    expect(view.seen.notes).toEqual(["Nothing to copy"]);
  });

  it("copies nothing from a range of lines that hold only white space, and says so", async () => {
    const lines = ["words", "   ", "\t "];
    const view = mount({
      items: [{ kind: "text", key: "t", text: "", streaming: false }],
      rendered: [{ lines, plain: lines, source: "", foldable: false }],
    });
    await flush();
    await view.press(KEY.select);
    await view.press("v");
    await view.press(KEYS.up);
    await view.press("y");
    expect(view.seen.copies).toEqual([]);
    expect(view.seen.notes).toEqual(["Nothing to copy"]);
  });

  it("says in Chinese that nothing was copied", async () => {
    const view = mount(block(10, 2), { locale: "zh" });
    await flush();
    await view.press(KEY.select);
    await view.press(KEYS.up);
    await view.press(KEYS.up);
    await view.press("y");
    expect(view.seen.notes).toEqual(["没有可复制的内容"]);
  });

  it("keeps the current match on the same line after an older page comes in on top", async () => {
    const view = mount(block(10, 2));
    await flush();
    await view.press(KEY.search);
    await view.type("item");
    await view.press(KEYS.enter);
    await view.press(KEYS.enter);
    expect(view.rows()[9]).toBe(bar("item", "18/20"));
    // Six older lines that match too.
    view.source.setState(
      withOlder(view.source.getState(), block(3, 2, "olditem")),
    );
    await flush();
    expect(view.rows()[9]).toBe(bar("item", "24/26"));
    expect(view.lastFrame()).toContain("\u001B[44mitem\u001B[49m8.1");
  });
});

/** `source` with the item keyed `from` keyed `to`: a streamed block that landed, say. */
function rekeyed(
  source: Pick<Source, "items" | "rendered">,
  from: string,
  to: string,
) {
  return {
    items: source.items.map((item) =>
      item.key === from ? { ...item, key: to } : item,
    ),
    rendered: source.rendered,
  };
}

describe("an item that changes key after the lines above it moved", () => {
  it("copies the line under the cursor when an older page came in on top first", async () => {
    const view = mount(block(10, 2));
    await flush();
    await view.press(KEY.select);
    view.source.setState(
      withOlder(view.source.getState(), block(10, 2, "old")),
    );
    await flush();
    view.source.setState(rekeyed(view.source.getState(), "item9", "landed9"));
    await flush();
    await view.press("y");
    expect(view.seen.copies).toEqual(["item9.1"]);
  });

  it("copies the line under the cursor when the items above drew longer first", async () => {
    const view = mount(block(10, 2));
    await flush();
    await view.press(KEY.select);
    const now = view.source.getState();
    const more = ["x", "y", "z", "w"];
    view.source.setState({
      rendered: now.rendered.map((drawn, i) =>
        i < 9
          ? {
              ...drawn,
              lines: [...drawn.lines, ...more],
              plain: [...drawn.plain, ...more],
            }
          : drawn,
      ),
    });
    await flush();
    view.source.setState(rekeyed(view.source.getState(), "item9", "landed9"));
    await flush();
    await view.press("y");
    expect(view.seen.copies).toEqual(["item9.1"]);
  });

  it("keeps what is on screen when the item at its top changes key after an older page came in", async () => {
    const view = mount(block(10, 2));
    await flush();
    await view.press(KEY.pageUp);
    const before = view.rows();
    expect(before[0]).toBe("item3.1");
    expect(before[9]).toBe("↓ ctrl+end to go to the bottom");
    view.source.setState(
      withOlder(view.source.getState(), block(10, 2, "old")),
    );
    await flush();
    view.source.setState(rekeyed(view.source.getState(), "item3", "landed3"));
    await flush();
    expect(view.rows()).toEqual(before);
  });

  it("keeps the cursor in its row when the item lands in the same redraw as an older page", async () => {
    // Keys as rows give them: the row id alone, or before a colon.
    const view = mount(block(10, 2, "r"));
    await flush();
    await view.press(KEY.select);
    view.source.setState(
      rekeyed(
        withOlder(view.source.getState(), block(10, 2, "old")),
        "r9",
        "r9:text",
      ),
    );
    await flush();
    await view.press("y");
    expect(view.seen.copies).toEqual(["r9.1"]);
  });
});

describe("modifier keys in the search", () => {
  it("scrolls a line on shift+up and leaves the current match alone", async () => {
    const view = mount(block(10, 2));
    await flush();
    await view.press(KEY.search);
    await view.type("item");
    expect(view.rows()[9]).toBe(bar("item", "20/20"));
    await view.press(KEY.lineUp);
    expect(view.rows()[9]).toBe(bar("item", "20/20"));
    // 29 lines in 9 rows follow from line 20; one up shows from line 19, item6.1.
    expect(view.rows()[0]).toBe("item6.1");
    await view.press(KEY.lineDown);
    expect(view.rows()[9]).toBe(bar("item", "20/20"));
    expect(view.rows()[0]).toBe("");
  });
});

describe("copying keeps what the lines start with", () => {
  it("keeps each line's leading spaces and drops only the trailing ones", async () => {
    const lines = ["$ ls", "  out 1", "    nested  ", "\tdone"];
    const view = mount({
      items: [{ kind: "text", key: "t", text: "", streaming: false }],
      rendered: [{ lines, plain: lines, source: "", foldable: false }],
    });
    await flush();
    await view.press(KEY.select);
    await view.press("v");
    await view.press(KEYS.up);
    await view.press(KEYS.up);
    await view.press("y");
    expect(view.seen.copies).toEqual(["  out 1\n    nested\n\tdone"]);
  });
});
