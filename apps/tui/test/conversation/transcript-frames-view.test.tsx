/**
 * Framed group replies in the transcript drawn in memory and driven with real keys: following the
 * bottom edge, a frame that grows, the selection cursor on every framed line, copying and searching
 * the content without the frame, and the frame dropped below 40 columns. The items are drawn here
 * (not by `render/`), so every line is known.
 */
import type {
  FrameStyle,
  RenderedItem,
  TranscriptItem,
} from "../../src/ext/conversation/contract";
import type { TranscriptUi } from "../../src/ext/conversation/transcript/ui";
import { stripVTControlCharacters } from "node:util";
import { useState, useSyncExternalStore } from "react";
import stringWidth from "string-width";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStore } from "zustand/vanilla";
import { Transcript } from "../../src/ext/conversation/transcript/transcript";
import { INITIAL_TRANSCRIPT_UI } from "../../src/ext/conversation/transcript/ui";
import { ConfigContext } from "../../src/extensions/react";
import { LocaleContext } from "../../src/i18n/react";
import { testConfig } from "../ui-support/config";
import { flush, KEYS, renderInk } from "../ui-support/render";

// Ink's colour library reads this once, when it loads, so it is set before any import.
vi.hoisted(() => {
  globalThis.process.env.FORCE_COLOR = "3";
});

const KEY = {
  lineUp: "\u001B[1;2A",
  pageUp: "\u001B[5~",
  search: "\u0006",
  select: "\u001Bv",
  home: "\u001B[H",
};

const MAGENTA = "\u001B[35m";
const BLUE_BRIGHT = "\u001B[94m";
const FG_OFF = "\u001B[39m";
const INVERSE = "\u001B[7m";
const GREEN = (text: string) => `\u001B[32m${text}\u001B[39m`;

function style(name: string, open: string): FrameStyle {
  return {
    name,
    border: { open, close: FG_OFF },
    nameStyle: { open: `\u001B[1m${open}`, close: `${FG_OFF}\u001B[22m` },
  };
}

const author = (row: string, name: string): TranscriptItem => ({
  kind: "author",
  key: `${row}:author`,
  name,
  agentId: name,
  members: [name],
});
const text = (key: string): TranscriptItem => ({
  kind: "text",
  key,
  text: key,
  streaming: false,
});

function drawn(lines: string[], source = lines.join("\n")): RenderedItem {
  return { lines: lines.map(GREEN), plain: lines, source, foldable: false };
}

function drawnAuthor(name: string, open: string): RenderedItem {
  return { ...drawn([`● ${name}`], name), frame: style(name, open) };
}

interface Source {
  items: TranscriptItem[];
  rendered: RenderedItem[];
  width: number;
}

/** Ada's reply (two items) over Ben's (one item, `benLines` long). */
function scene(benLines = 1): Pick<Source, "items" | "rendered"> {
  return {
    items: [
      author("r1", "Ada"),
      text("r1:a"),
      text("r1:b"),
      author("r2", "Ben"),
      text("r2:a"),
    ],
    rendered: [
      drawnAuthor("Ada", MAGENTA),
      drawn(["ada one", "ada two"], "Ada's first words"),
      drawn(["ada three"], "Ada's last words"),
      drawnAuthor("Ben", BLUE_BRIGHT),
      drawn(
        Array.from({ length: benLines }, (_, i) => `ben ${i}`),
        "Ben's words",
      ),
    ],
  };
}

const mounted: { unmount: () => void }[] = [];
afterEach(() => {
  for (const one of mounted.splice(0)) one.unmount();
});

function mount(
  initial: Pick<Source, "items" | "rendered">,
  options: { height?: number; width?: number; ui?: Partial<TranscriptUi> } = {},
) {
  const source = createStore<Source>(() => ({
    width: options.width ?? 40,
    ...initial,
  }));
  const seen = {
    ui: { ...INITIAL_TRANSCRIPT_UI, ...options.ui } as TranscriptUi,
    copies: [] as string[],
  };
  function Harness() {
    const state = useSyncExternalStore(source.subscribe, source.getState);
    const [ui, setUi] = useState<TranscriptUi>(seen.ui);
    seen.ui = ui;
    return (
      <Transcript
        items={state.items}
        rendered={state.rendered}
        height={options.height ?? 20}
        width={state.width}
        isActive
        ui={ui}
        onUi={(update) => setUi((was) => ({ ...was, ...update }))}
        hasOlder={false}
        loadingOlder={false}
        onReachTop={() => {}}
        onNotify={() => {}}
        copy={(copied) => seen.copies.push(copied)}
      />
    );
  }
  const rendered = renderInk(
    <ConfigContext value={testConfig()}>
      <LocaleContext value="en">
        <Harness />
      </LocaleContext>
    </ConfigContext>,
    { columns: options.width ?? 40, rows: (options.height ?? 20) + 2 },
  );
  mounted.push(rendered);
  const frameLines = () => rendered.lastFrame().split("\n");
  const rows = () =>
    frameLines().map((line) => stripVTControlCharacters(line).trimEnd());
  return { ...rendered, source, seen, rows, frameLines };
}

const dashes = (count: number) => "─".repeat(count);
const pad = (content: string, width = 40) =>
  `│ ${content}${" ".repeat(width - 4 - stringWidth(content))} │`;

/** The coloured row whose plain text is `plain`. */
function rowOf(r: ReturnType<typeof mount>, plain: string): string {
  const index = r.rows().indexOf(plain);
  expect(
    index,
    `no row ${JSON.stringify(plain)} in\n${r.rows().join("\n")}`,
  ).toBeGreaterThanOrEqual(0);
  return r.frameLines()[index]!;
}

/** The plain text in front of the first occurrence of `code` in a coloured row. */
function before(row: string, code: string): string {
  const at = row.indexOf(code);
  expect(at, JSON.stringify(row)).toBeGreaterThanOrEqual(0);
  return stripVTControlCharacters(row.slice(0, at));
}

describe("frames on screen", () => {
  it("draws each reply in a frame of its own colour, edges included, at the transcript's width", async () => {
    const r = mount(scene());
    await flush();
    expect(r.rows().slice(0, 11)).toEqual([
      `╭─ Ada ${dashes(32)}╮`,
      pad("ada one"),
      pad("ada two"),
      `│${" ".repeat(38)}│`,
      pad("ada three"),
      `╰${dashes(38)}╯`,
      "",
      `╭─ Ben ${dashes(32)}╮`,
      pad("ben 0"),
      `╰${dashes(38)}╯`,
      "",
    ]);
    expect(rowOf(r, `╭─ Ada ${dashes(32)}╮`)).toContain(MAGENTA);
    expect(rowOf(r, pad("ada one"))).toContain(MAGENTA);
    expect(rowOf(r, `╭─ Ben ${dashes(32)}╮`)).toContain(BLUE_BRIGHT);
    expect(rowOf(r, pad("ben 0"))).not.toContain(MAGENTA);
  });

  it("following, the bottom edge of the newest reply is the last row", async () => {
    const r = mount(scene(30), { height: 10 });
    await flush();
    expect(r.rows()).toHaveLength(10);
    expect(r.rows().at(-1)).toBe(`╰${dashes(38)}╯`);
    expect(r.rows().at(-2)).toBe(pad("ben 29"));
  });

  it("grows with a reply that is still being written, its bottom edge still last", async () => {
    const r = mount(scene(2), { height: 10 });
    await flush();
    expect(r.rows().at(-1)).toBe(`╰${dashes(38)}╯`);
    expect(r.rows().at(-2)).toBe(pad("ben 1"));
    r.source.setState(scene(12));
    await flush();
    expect(r.rows().at(-1)).toBe(`╰${dashes(38)}╯`);
    expect(r.rows().at(-2)).toBe(pad("ben 11"));
    expect(r.rows().filter((row) => row.startsWith("│ ben"))).toHaveLength(9);
  });

  it("counts the edges among the lines a page moves by", async () => {
    const r = mount(scene(30), { height: 10 });
    await flush();
    await r.press(KEY.pageUp);
    // Ada's frame is 6 lines, a blank, Ben's 32 (top edge at line 7): 39 lines. Following shows
    // lines 29..38; a page of 9 up shows lines 20..28 over the hint, "ben 12" to "ben 20".
    expect(r.rows().slice(0, 9)).toEqual(
      Array.from({ length: 9 }, (_, i) => pad(`ben ${12 + i}`)),
    );
  });
});

describe("the selection in a frame", () => {
  it("stops on every framed line, edges included, and marks only the content", async () => {
    const r = mount(scene());
    await flush();
    await r.press(KEY.select);
    // The cursor starts on the last line: Ben's bottom edge, which has no content, so one cell
    // where content would start is marked and the edge is drawn whole.
    expect(r.rows()[9]).toBe(`╰${dashes(38)}╯`);
    expect(before(r.frameLines()[9]!, INVERSE)).toBe("╰─");
    await r.press(KEYS.up);
    expect(r.rows()[8]).toBe(pad("ben 0"));
    expect(before(r.frameLines()[8]!, INVERSE)).toBe("│ ");
    expect(r.frameLines()[8]).toContain(BLUE_BRIGHT);
    await r.press(KEYS.up);
    expect(r.rows()[7]).toBe(`╭─ Ben ${dashes(32)}╮`);
    expect(before(r.frameLines()[7]!, INVERSE)).toBe("╭─ ");
    expect(r.frameLines()[7]).toContain(BLUE_BRIGHT);
    await r.press(KEYS.up);
    await r.press(KEYS.up);
    await r.press(KEYS.up);
    await r.press(KEYS.up);
    // The blank line inside Ada's frame.
    expect(r.rows()[3]).toBe(`│${" ".repeat(38)}│`);
    expect(before(r.frameLines()[3]!, INVERSE)).toBe("│ ");
  });

  it("copies lines without the frame: the name for the top edge, an empty line for the bottom", async () => {
    const r = mount(scene());
    await flush();
    await r.press(KEY.select);
    await r.press(KEYS.up);
    await r.press("y");
    expect(r.seen.copies).toEqual(["ben 0"]);
    await r.press(KEY.select);
    await r.press(KEY.home);
    await r.press("v");
    for (let i = 0; i < 5; i += 1) await r.press(KEYS.down);
    await r.press(KEYS.enter);
    expect(r.seen.copies[1]).toBe("Ada\nada one\nada two\n\nada three\n");
  });

  it("copies the item under the cursor: the author on the top edge, the last item on the bottom edge", async () => {
    const r = mount(scene());
    await flush();
    await r.press(KEY.select);
    await r.press("c");
    await r.press(KEYS.up);
    await r.press("c");
    await r.press(KEYS.up);
    await r.press("c");
    await r.press(KEY.home);
    await r.press(KEYS.down);
    await r.press("c");
    expect(r.seen.copies).toEqual([
      "Ben's words",
      "Ben's words",
      "Ben",
      "Ada's first words",
    ]);
  });

  it("marks a range on the content of each line it covers, the frame drawn as before", async () => {
    const r = mount(scene());
    await flush();
    await r.press(KEY.select);
    await r.press(KEY.home);
    await r.press("v");
    await r.press(KEYS.down);
    await r.press(KEYS.down);
    expect(r.rows().slice(0, 3)).toEqual([
      `╭─ Ada ${dashes(32)}╮`,
      pad("ada one"),
      pad("ada two"),
    ]);
    const selected = "\u001B[44m";
    expect(before(r.frameLines()[0]!, selected)).toBe("╭─ ");
    expect(before(r.frameLines()[1]!, selected)).toBe("│ ");
    expect(r.frameLines()[1]).toContain(MAGENTA);
  });
});

describe("the search in a frame", () => {
  it("finds the content and the names, never the frame, and marks the match where it is drawn", async () => {
    const r = mount(scene());
    await flush();
    await r.press(KEY.search);
    await r.type("│");
    await flush();
    expect(r.rows().at(-1)).toContain("No matches");
    await r.press(KEYS.escape);
    await r.press(KEY.search);
    await r.type("two");
    await flush();
    expect(r.rows()[2]).toBe(pad("ada two"));
    expect(before(r.frameLines()[2]!, "\u001B[44m")).toBe("│ ada ");
    expect(r.frameLines()[2]).toContain(MAGENTA);
    await r.press(KEYS.escape);
    await r.press(KEY.search);
    await r.type("ben");
    await flush();
    // "Ben" on the top edge and "ben 0": the newest is current, the other inverse.
    expect(r.rows().at(-1)).toContain("2/2");
    expect(before(r.frameLines()[7]!, INVERSE)).toBe("╭─ ");
  });
});

describe("below 40 columns", () => {
  it("draws no frame: the author's own line, the items as drawn", async () => {
    const r = mount(scene(), { width: 39 });
    await flush();
    expect(r.rows().slice(0, 8)).toEqual([
      "● Ada",
      "ada one",
      "ada two",
      "",
      "ada three",
      "",
      "● Ben",
      "ben 0",
    ]);
  });

  it("keeps the scroll on the same item when the frames come and go", async () => {
    const r = mount(scene(30), { height: 10 });
    await flush();
    await r.press(KEY.pageUp);
    await r.press(KEY.pageUp);
    // Two pages up from the top at line 29 is line 11: Ben's frame starts at line 7, so "ben 3".
    const top = r.rows()[0];
    expect(top).toBe(pad("ben 3"));
    r.source.setState({ width: 39 });
    await flush();
    expect(r.rows()[0]).toBe("ben 3");
    r.source.setState({ width: 40 });
    await flush();
    expect(r.rows()[0]).toBe(top);
  });
});
