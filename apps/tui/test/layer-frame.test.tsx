/**
 * The layer frame on its own: as tall as its content, never taller than the room it is given, and
 * content taller than that scrolls inside it, with a line above and below saying how much is out
 * of view.
 */
import type { ReactNode } from "react";
import type { Locale } from "../src/config/types";
import { stripVTControlCharacters } from "node:util";
import { Box, Text, useInput, useWindowSize } from "ink";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { PickList } from "../src/ext/kit/pick-list";
import { ChoiceList } from "../src/ui/components/choice-list";
import { LayerFrame } from "../src/ui/components/layer-frame";
import { FRAME_ROWS, LayerAreaContext } from "../src/ui/components/layer-space";
import { RowList } from "../src/ui/components/row-list";
import { LIST_KEYS } from "./ext-support/keys";
import { renderKit } from "./ext-support/render-kit";
import { flush, KEYS, plain } from "./ui-support/render";

/** "Line 01" … "Line {count}". */
function numbered(count: number): string[] {
  return Array.from(
    { length: count },
    (_, i) => `Line ${String(i + 1).padStart(2, "0")}`,
  );
}

/**
 * A frame in a box `height` rows tall: border 2, title 1, the two hint rows, the footer 1, so
 * `height - 6` content rows show.
 */
async function frame(
  lines: readonly string[],
  height: number,
  locale: Locale = "en",
) {
  const r = renderKit(
    <LayerAreaContext value>
      <Box flexDirection="column" height={height}>
        <LayerFrame title="Title" footer="Esc to close">
          {lines.map((line) => (
            <Text key={line}>{line}</Text>
          ))}
        </LayerFrame>
      </Box>
    </LayerAreaContext>,
    { columns: 40, rows: height, locale },
  );
  // The frame knows what fits once Ink has laid it out.
  await flush();
  return r;
}

/** The frame's rows, without the border and padding. */
function rows(r: { lastFrame: () => string }): string[] {
  return plain(r)
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) =>
      line
        .replace(/^[│┌└]/, "")
        .replace(/[│┐┘]$/, "")
        .trim(),
    );
}

/** The numbered lines on screen, in order. */
function shownLines(r: { lastFrame: () => string }): string[] {
  return rows(r).filter((line) => /^Line \d\d$/.test(line));
}

describe("a layer whose content fits", () => {
  it("shows everything, no hint rows, and ignores the scroll keys", async () => {
    const r = await frame(numbered(5), 16);
    await flush();
    expect(shownLines(r)).toEqual(numbered(5));
    expect(plain(r)).not.toContain("↑");
    expect(plain(r)).not.toContain("↓");
    for (const key of [KEYS.down, LIST_KEYS.pageDown, KEYS.up]) {
      await r.press(key);
      expect(shownLines(r)).toEqual(numbered(5));
    }
  });
});

describe("a layer whose content is taller than the room", () => {
  it("scrolls a row with ↓ and ↑ and stops at both ends", async () => {
    const r = await frame(numbered(30), 16);
    await r.press(KEYS.up);
    expect(shownLines(r)[0]).toBe("Line 01");
    await r.press(KEYS.down);
    expect(shownLines(r)).toEqual(numbered(11).slice(1));
    expect(plain(r)).toContain("↑ 1 more");
    expect(plain(r)).toContain("↓ 19 more");
    await r.press(KEYS.up);
    expect(shownLines(r)).toEqual(numbered(10));
    expect(plain(r)).not.toContain("↑");
    for (let i = 0; i < 25; i += 1) await r.press(KEYS.down);
    expect(shownLines(r)).toEqual(numbered(30).slice(20));
    expect(plain(r)).toContain("↑ 20 more");
    expect(plain(r)).not.toContain("↓");
  });

  it("turns a page with PageDown and PageUp and stops at both ends", async () => {
    const r = await frame(numbered(30), 16);
    await r.press(LIST_KEYS.pageDown);
    expect(shownLines(r)[0]).toBe("Line 11");
    expect(plain(r)).toContain("↑ 10 more");
    expect(plain(r)).toContain("↓ 10 more");
    await r.press(LIST_KEYS.pageDown);
    expect(shownLines(r)[0]).toBe("Line 21");
    await r.press(LIST_KEYS.pageDown);
    expect(shownLines(r)[0]).toBe("Line 21");
    expect(shownLines(r).at(-1)).toBe("Line 30");
    await r.press(LIST_KEYS.pageUp);
    expect(shownLines(r)[0]).toBe("Line 11");
    await r.press(LIST_KEYS.pageUp);
    await r.press(LIST_KEYS.pageUp);
    expect(shownLines(r)[0]).toBe("Line 01");
  });

  it("says how much is out of view in Chinese", async () => {
    const r = await frame(numbered(30), 16, "zh");
    await r.press(KEYS.down);
    expect(plain(r)).toContain("↑ 还有 1 行");
    expect(plain(r)).toContain("↓ 还有 19 行");
  });

  it("comes back from past the end when the content gets shorter", async () => {
    const r = renderKit(
      <LayerAreaContext value>
        <Box flexDirection="column" height={16}>
          <Shrinking />
        </Box>
      </LayerAreaContext>,
      { columns: 40, rows: 16 },
    );
    await flush();
    await r.press(LIST_KEYS.pageDown);
    await r.press(LIST_KEYS.pageDown);
    expect(shownLines(r)[0]).toBe("Line 21");
    await r.press("x");
    await flush();
    expect(shownLines(r)).toEqual(numbered(12).slice(2));
    expect(plain(r)).toContain("↑ 2 more");
    expect(plain(r)).not.toContain("↓");
  });
});

/** A frame of 30 lines that drops to 12 when x is pressed. */
function Shrinking() {
  const [count, setCount] = useState(30);
  useInput((input) => {
    if (input === "x") setCount(12);
  });
  return (
    <LayerFrame title="Title" footer="Esc to close">
      {numbered(count).map((line) => (
        <Text key={line}>{line}</Text>
      ))}
    </LayerFrame>
  );
}

const ITEMS = numbered(30).map((label, i) => ({ key: `k${i + 1}`, label }));

/** The marked list row, past its marker. */
function markedRow(r: { lastFrame: () => string }): string | undefined {
  return rows(r)
    .find((row) => row.startsWith("›"))
    ?.slice(2)
    .trim();
}

describe("lists in a layer frame", () => {
  it("a pick list takes the rows its frame has left, so the frame does not scroll", async () => {
    // 14 rows: 8 for content, one of them the intro, leaving 7: five items and two hint rows.
    const r = renderKit(
      <LayerAreaContext value>
        <Box flexDirection="column" height={14}>
          <LayerFrame title="Title" footer="Esc to close">
            <Text>Intro</Text>
            <PickList items={ITEMS} empty="none" onPick={() => {}} />
          </LayerFrame>
        </Box>
      </LayerAreaContext>,
      { columns: 40, rows: 14 },
    );
    await flush();
    const all = rows(r);
    expect(all[2]).toBe("");
    expect(all.at(-3)).toBe("");
    expect(all).toContain("Intro");
    const items = all.filter((row) => /Line \d\d$/.test(row));
    expect(items).toHaveLength(5);
    expect(all).toContain(`↓ ${30 - items.length} more`);
    // Moving to the end: the hint row above comes, the items shown drop by one, still fitting.
    for (let i = 0; i < 29; i += 1) await r.press(KEYS.down);
    const end = rows(r);
    expect(markedRow(r)).toBe("Line 30");
    expect(end[2]).toBe("");
    expect(end.at(-3)).toBe("");
    expect(end.filter((row) => /Line \d\d$/.test(row))).toHaveLength(5);
  });

  it("a row list takes the rows its frame has left, without hint rows", async () => {
    const list = numbered(30).map((label) => ({ key: label, label }));
    const r = renderKit(
      <LayerAreaContext value>
        <Box flexDirection="column" height={14}>
          <LayerFrame title="Title" footer="Esc to close">
            <RowList rows={list} cursor={0} height={20} />
          </LayerFrame>
        </Box>
      </LayerAreaContext>,
      { columns: 40, rows: 14 },
    );
    await flush();
    const all = rows(r);
    expect(all[2]).toBe("");
    expect(all.at(-3)).toBe("");
    expect(all.filter((row) => /Line \d\d$/.test(row))).toEqual(
      numbered(8).map((line, i) => (i === 0 ? `› ${line}` : line)),
    );
  });

  it("a list in a frame too short for it: ↓ moves the cursor only, the frame keeps it in view, PageUp and PageDown scroll the frame", async () => {
    // 10 rows: 4 for content, all taken by the text above the list.
    const r = renderKit(
      <LayerAreaContext value>
        <Box flexDirection="column" height={10}>
          <LayerFrame title="Title" footer="Esc to close">
            {numbered(4).map((line) => (
              <Text key={line}>{`Text ${line}`}</Text>
            ))}
            <PickList items={ITEMS} empty="none" onPick={() => {}} />
          </LayerFrame>
        </Box>
      </LayerAreaContext>,
      { columns: 40, rows: 10 },
    );
    await flush();
    expect(markedRow(r)).toBe("Line 01");
    for (const expected of ["Line 02", "Line 03"]) {
      await r.press(KEYS.down);
      expect(markedRow(r)).toBe(expected);
    }
    // PageUp turns the frame to its top: the first text row shows, whole.
    await r.press(LIST_KEYS.pageUp);
    expect(rows(r)[3]).toBe("Text Line 01");
    expect(markedRow(r)).toBeUndefined();
    // The cursor is where it was: ↓ moves it one item and brings it back into view.
    await r.press(KEYS.down);
    expect(markedRow(r)).toBe("Line 04");
    // PageDown turns the frame to its end: the list's own hint row shows.
    await r.press(LIST_KEYS.pageDown);
    await r.press(LIST_KEYS.pageDown);
    expect(rows(r)).toContain("↓ 26 more");
    for (const line of rows(r))
      expect(line).toMatch(
        /^(?:(?:› )?Line \d\d|Text Line \d\d|[↑↓] \d+ more|Title|Esc to close|─*)$/,
      );
  });

  it("a frame with a choice list leaves ↑ ↓ to it and keeps the marked choice in view", async () => {
    const choices = ["One", "Two", "Three", "Four", "Five"].map((label) => ({
      label,
    }));
    const chosen: number[] = [];
    // 10 rows: 4 for content; the five choices come first, three text rows after them.
    const r = renderKit(
      <LayerAreaContext value>
        <Box flexDirection="column" height={10}>
          <LayerFrame title="Title" footer="Esc to close">
            <ChoiceList choices={choices} onChoose={(i) => chosen.push(i)} />
            {numbered(3).map((line) => (
              <Text key={line}>{`Text ${line}`}</Text>
            ))}
          </LayerFrame>
        </Box>
      </LayerAreaContext>,
      { columns: 40, rows: 10 },
    );
    await flush();
    expect(markedRow(r)).toBe("1. One");
    // Two is in view already: the frame stays where it is.
    await r.press(KEYS.down);
    expect(markedRow(r)).toBe("2. Two");
    expect(rows(r)[3]).toBe("1. One");
    for (const expected of ["3. Three", "4. Four", "5. Five"]) {
      await r.press(KEYS.down);
      expect(markedRow(r)).toBe(expected);
    }
    await r.press(KEYS.down);
    expect(markedRow(r)).toBe("5. Five");
    // PageDown shows the text under the choices.
    await r.press(LIST_KEYS.pageDown);
    expect(rows(r)).toContain("Text Line 03");
    // ↑ moves the marker and brings it back into view.
    await r.press(KEYS.up);
    expect(markedRow(r)).toBe("4. Four");
    for (let i = 0; i < 3; i += 1) await r.press(KEYS.up);
    expect(markedRow(r)).toBe("1. One");
    await r.press(KEYS.enter);
    expect(chosen).toEqual([0]);
  });
});

describe("a layer frame outside the shell's layer area", () => {
  it("is as tall as its content and shows every row, lists at their full height", async () => {
    const r = renderKit(
      <LayerFrame title="Title" footer="Esc to close">
        {numbered(3).map((line) => (
          <Text key={line}>{`Text ${line}`}</Text>
        ))}
        <PickList items={ITEMS} empty="none" onPick={() => {}} />
      </LayerFrame>,
      { columns: 40, rows: 10 },
    );
    await flush();
    const all = rows(r);
    expect(all).toContain("Text Line 03");
    expect(
      all.filter((row) => /Line \d\d$/.test(row) && !row.startsWith("Text")),
    ).toHaveLength(10);
    expect(all).toContain("↓ 20 more");
    expect(all.at(-2)).toBe("Esc to close");
  });
});

describe("enter while PageUp or PageDown took the cursor out of view", () => {
  it("in a pick list: brings the cursor back and picks nothing; the next Enter picks", async () => {
    const picked: string[] = [];
    const r = renderKit(
      <LayerAreaContext value>
        <Box flexDirection="column" height={10}>
          <LayerFrame title="Title" footer="Esc to close">
            {numbered(4).map((line) => (
              <Text key={line}>{`Text ${line}`}</Text>
            ))}
            <PickList
              items={ITEMS}
              empty="none"
              onPick={(key) => picked.push(key)}
            />
          </LayerFrame>
        </Box>
      </LayerAreaContext>,
      { columns: 40, rows: 10 },
    );
    await flush();
    await r.press(LIST_KEYS.pageUp);
    expect(markedRow(r)).toBeUndefined();
    await r.press(KEYS.enter);
    expect(picked).toEqual([]);
    expect(markedRow(r)).toBe("Line 01");
    await r.press(KEYS.enter);
    expect(picked).toEqual(["k1"]);
  });

  it("in a choice list: brings the marker back and chooses nothing; the next Enter chooses", async () => {
    const choices = ["One", "Two", "Three", "Four", "Five"].map((label) => ({
      label,
    }));
    const chosen: number[] = [];
    const r = renderKit(
      <LayerAreaContext value>
        <Box flexDirection="column" height={10}>
          <LayerFrame title="Title" footer="Esc to close">
            <ChoiceList choices={choices} onChoose={(i) => chosen.push(i)} />
            {numbered(3).map((line) => (
              <Text key={line}>{`Text ${line}`}</Text>
            ))}
          </LayerFrame>
        </Box>
      </LayerAreaContext>,
      { columns: 40, rows: 10 },
    );
    await flush();
    await r.press(LIST_KEYS.pageDown);
    expect(markedRow(r)).toBeUndefined();
    await r.press(KEYS.enter);
    expect(chosen).toEqual([]);
    expect(markedRow(r)).toBe("1. One");
    await r.press(KEYS.enter);
    expect(chosen).toEqual([0]);
  });
});

/**
 * Where the frame's border is in the last frame Ink wrote: the line of its top and of its bottom,
 * and whether every line under the bottom is blank.
 */
function frameBox(r: { lastFrame: () => string }): {
  top: number;
  height: number;
  blankBelow: boolean;
} {
  const lines = plain(r).split("\n");
  const top = lines.findIndex((line) => line.startsWith("┌"));
  const bottom = lines.findIndex((line) => line.startsWith("└"));
  return {
    top,
    height: bottom - top + 1,
    blankBelow: lines.slice(bottom + 1).every((line) => line.trim() === ""),
  };
}

/** A frame of `start` lines that switches to `next` lines when x is pressed. */
function Switching({ start, next }: { start: number; next: number }) {
  const [count, setCount] = useState(start);
  useInput((input) => {
    if (input === "x") setCount(next);
  });
  return (
    <LayerFrame title="Title" footer="Esc to close">
      {numbered(count).map((line) => (
        <Text key={line}>{line}</Text>
      ))}
    </LayerFrame>
  );
}

/** A layer area as tall as the terminal, as the shell gives one. */
function TerminalArea({ children }: { children: ReactNode }) {
  const { rows: height } = useWindowSize();
  return (
    <LayerAreaContext value>
      <Box flexDirection="column" height={height}>
        {children}
      </Box>
    </LayerAreaContext>
  );
}

async function settle() {
  for (let i = 0; i < 4; i += 1) await flush();
}

describe("a layer frame in the layer area is as tall as its content", () => {
  it("content that fits: the frame is its rows plus the frame's own, at the top, blank under it", async () => {
    const r = await frame(numbered(5), 16);
    await settle();
    const box = frameBox(r);
    expect(box.top).toBe(0);
    expect(box.height).toBe(5 + FRAME_ROWS);
    expect(box.blankBelow).toBe(true);
    expect(shownLines(r)).toEqual(numbered(5));
    // Nothing to scroll: the two hint rows stay, empty.
    const all = rows(r);
    expect(all[2]).toBe("");
    expect(all.at(-3)).toBe("");
  });

  it("content one row short of the room: no empty row in the frame beyond the hint rows", async () => {
    const r = await frame(numbered(9), 16);
    await settle();
    expect(frameBox(r).height).toBe(9 + FRAME_ROWS);
    expect(plain(r)).not.toContain("more");
  });

  it("content exactly as tall as the room: the frame fills it and does not scroll", async () => {
    const r = await frame(numbered(10), 16);
    await settle();
    expect(frameBox(r).height).toBe(16);
    expect(shownLines(r)).toEqual(numbered(10));
    expect(plain(r)).not.toContain("more");
  });

  it("without a footer the frame is one row shorter", async () => {
    const r = renderKit(
      <LayerAreaContext value>
        <Box flexDirection="column" height={16}>
          <LayerFrame title="Title">
            {numbered(4).map((line) => (
              <Text key={line}>{line}</Text>
            ))}
          </LayerFrame>
        </Box>
      </LayerAreaContext>,
      { columns: 40, rows: 16 },
    );
    await settle();
    expect(frameBox(r).height).toBe(4 + FRAME_ROWS - 1);
    expect(shownLines(r)).toEqual(numbered(4));
  });

  it("content taller than the room: the frame is as tall as the room and scrolls", async () => {
    const r = await frame(numbered(30), 16);
    await settle();
    const box = frameBox(r);
    expect(box.top).toBe(0);
    expect(box.height).toBe(16);
    expect(shownLines(r)).toEqual(numbered(10));
    expect(plain(r)).toContain("↓ 20 more");
  });

  it("grows with its content, and scrolls once the content no longer fits", async () => {
    const r = renderKit(
      <LayerAreaContext value>
        <Box flexDirection="column" height={16}>
          <Switching start={3} next={30} />
        </Box>
      </LayerAreaContext>,
      { columns: 40, rows: 16 },
    );
    await settle();
    expect(frameBox(r).height).toBe(3 + FRAME_ROWS);
    await r.press("x");
    await settle();
    expect(frameBox(r).height).toBe(16);
    expect(shownLines(r)).toEqual(numbered(10));
    expect(plain(r)).toContain("↓ 20 more");
    await r.press(LIST_KEYS.pageDown);
    expect(shownLines(r)[0]).toBe("Line 11");
  });

  it("grows by a row that still fits without a hint row showing in any frame on the way", async () => {
    const r = renderKit(
      <LayerAreaContext value>
        <Box flexDirection="column" height={16}>
          <Switching start={5} next={6} />
        </Box>
      </LayerAreaContext>,
      { columns: 40, rows: 16 },
    );
    await settle();
    const from = r.stdout.frames.length;
    await r.press("x");
    await settle();
    expect(frameBox(r).height).toBe(6 + FRAME_ROWS);
    for (const written of r.stdout.frames.slice(from))
      expect(stripVTControlCharacters(written)).not.toContain("more");
  });

  it("draws its content in the very first frame Ink writes, the frame as tall as it", async () => {
    const r = renderKit(
      <LayerAreaContext value>
        <Box flexDirection="column" height={16}>
          <Switching start={5} next={5} />
        </Box>
      </LayerAreaContext>,
      { columns: 40, rows: 16 },
    );
    await settle();
    expect(r.stdout.frames.length).toBeGreaterThan(0);
    for (const [index, written] of r.stdout.frames.entries()) {
      const screen = { lastFrame: () => written };
      expect(shownLines(screen), `frame ${index}`).toEqual(numbered(5));
      expect(frameBox(screen).height, `frame ${index}`).toBe(5 + FRAME_ROWS);
    }
  });

  it("draws content taller than the room in the very first frame, its first rows whole and within the room", async () => {
    const r = renderKit(
      <LayerAreaContext value>
        <Box flexDirection="column" height={16}>
          <Switching start={30} next={30} />
        </Box>
      </LayerAreaContext>,
      { columns: 40, rows: 16 },
    );
    await settle();
    for (const [index, written] of r.stdout.frames.entries()) {
      const screen = { lastFrame: () => written };
      const shown = shownLines(screen);
      expect(shown.length, `frame ${index}`).toBeGreaterThan(0);
      expect(shown, `frame ${index}`).toEqual(numbered(shown.length));
      expect(plain(screen).trimEnd().split("\n").length).toBeLessThanOrEqual(
        16,
      );
      for (const line of rows(screen))
        expect(line).toMatch(
          /^(?:Line \d\d|[↑↓] \d+ more|Title|Esc to close|─*)$/,
        );
    }
    expect(shownLines(r)).toEqual(numbered(10));
    expect(frameBox(r).height).toBe(16);
  });

  it("shows rows the content grows by in the first frame after it grew", async () => {
    const r = renderKit(
      <LayerAreaContext value>
        <Box flexDirection="column" height={16}>
          <Switching start={3} next={7} />
        </Box>
      </LayerAreaContext>,
      { columns: 40, rows: 16 },
    );
    await settle();
    const from = r.stdout.frames.length;
    await r.press("x");
    await settle();
    const after = r.stdout.frames.slice(from);
    expect(after.length).toBeGreaterThan(0);
    for (const [index, written] of after.entries()) {
      const screen = { lastFrame: () => written };
      expect(shownLines(screen), `frame ${index}`).toEqual(numbered(7));
      expect(frameBox(screen).height, `frame ${index}`).toBe(7 + FRAME_ROWS);
    }
  });

  it("shrinks with its content, and scrolls no more once it fits", async () => {
    const r = renderKit(
      <LayerAreaContext value>
        <Box flexDirection="column" height={16}>
          <Switching start={30} next={4} />
        </Box>
      </LayerAreaContext>,
      { columns: 40, rows: 16 },
    );
    await settle();
    await r.press(LIST_KEYS.pageDown);
    expect(shownLines(r)[0]).toBe("Line 11");
    await r.press("x");
    await settle();
    expect(frameBox(r).height).toBe(4 + FRAME_ROWS);
    expect(frameBox(r).blankBelow).toBe(true);
    expect(shownLines(r)).toEqual(numbered(4));
    expect(plain(r)).not.toContain("more");
    // Nothing scrolls now: the keys leave the content where it is.
    await r.press(LIST_KEYS.pageDown);
    await r.press(KEYS.down);
    expect(shownLines(r)).toEqual(numbered(4));
  });

  it("starts scrolling when the terminal gets too short, and fits again when it gets taller", async () => {
    const r = renderKit(
      <TerminalArea>
        <Switching start={15} next={15} />
      </TerminalArea>,
      { columns: 40, rows: 30 },
    );
    await settle();
    expect(frameBox(r).height).toBe(15 + FRAME_ROWS);
    expect(plain(r)).not.toContain("more");

    r.stdout.resize(40, 12);
    await settle();
    expect(frameBox(r).height).toBe(12);
    expect(shownLines(r)).toEqual(numbered(6));
    expect(plain(r)).toContain("↓ 9 more");
    await r.press(LIST_KEYS.pageDown);
    expect(shownLines(r)[0]).toBe("Line 07");

    r.stdout.resize(40, 30);
    await settle();
    expect(frameBox(r).height).toBe(15 + FRAME_ROWS);
    expect(frameBox(r).blankBelow).toBe(true);
    expect(shownLines(r)).toEqual(numbered(15));
    expect(plain(r)).not.toContain("more");
  });

  it("never writes more rows than the room, nor two rows run together, while the room changes", async () => {
    const r = renderKit(
      <TerminalArea>
        <Switching start={15} next={15} />
      </TerminalArea>,
      { columns: 40, rows: 30 },
    );
    await settle();
    for (const height of [20, 9, 14, 30, 8, 21, 22]) {
      r.stdout.resize(40, height);
      await settle();
      expect(frameBox(r).height, `at ${height} rows`).toBe(
        Math.min(height, 15 + FRAME_ROWS),
      );
      expect(plain(r).trimEnd().split("\n").length).toBeLessThanOrEqual(height);
      for (const line of rows(r))
        expect(line).toMatch(
          /^(?:Line \d\d|[↑↓] \d+ more|Title|Esc to close|─*)$/,
        );
    }
  });
});

describe("lists in a frame as tall as its content", () => {
  it("a list that fits shows every item, the frame no taller than they need", async () => {
    const r = renderKit(
      <TerminalArea>
        <LayerFrame title="Title" footer="Esc to close">
          <Text>Intro</Text>
          <PickList items={ITEMS.slice(0, 4)} empty="none" onPick={() => {}} />
        </LayerFrame>
      </TerminalArea>,
      { columns: 40, rows: 24 },
    );
    await settle();
    expect(frameBox(r).height).toBe(1 + 4 + FRAME_ROWS);
    expect(rows(r).filter((row) => /Line \d\d$/.test(row))).toHaveLength(4);
  });

  it("a long list takes its preferred height when the room has it, and gets it back after the room shrank", async () => {
    const r = renderKit(
      <TerminalArea>
        <LayerFrame title="Title" footer="Esc to close">
          <Text>Intro</Text>
          <PickList items={ITEMS} empty="none" onPick={() => {}} />
        </LayerFrame>
      </TerminalArea>,
      { columns: 40, rows: 24 },
    );
    await settle();
    const items = () => rows(r).filter((row) => /Line \d\d$/.test(row));
    // The pick list's preferred height is 10 items; at the top of the list only the hint row
    // under them shows.
    expect(items()).toHaveLength(10);
    expect(frameBox(r).height).toBe(1 + 11 + FRAME_ROWS);
    expect(frameBox(r).blankBelow).toBe(true);

    r.stdout.resize(40, 12);
    await settle();
    // 6 content rows at most: the intro, and three items with the list's two hint rows kept
    // for them, of which only the one under the items shows at the top of the list.
    expect(items()).toHaveLength(3);
    expect(frameBox(r).height).toBe(1 + 3 + 1 + FRAME_ROWS);
    expect(rows(r)[2]).toBe("");
    expect(rows(r).at(-3)).toBe("");

    r.stdout.resize(40, 24);
    await settle();
    expect(items()).toHaveLength(10);
    expect(frameBox(r).height).toBe(1 + 11 + FRAME_ROWS);
  });

  it("a row list as tall as the room allows grows back when the room does", async () => {
    const list = numbered(30).map((label) => ({ key: label, label }));
    const r = renderKit(
      <TerminalArea>
        <LayerFrame title="Title" footer="Esc to close">
          <RowList rows={list} cursor={0} height={20} />
        </LayerFrame>
      </TerminalArea>,
      { columns: 40, rows: 14 },
    );
    await settle();
    const items = () => rows(r).filter((row) => /Line \d\d$/.test(row));
    expect(items()).toHaveLength(8);
    expect(frameBox(r).height).toBe(14);
    r.stdout.resize(40, 30);
    await settle();
    expect(items()).toHaveLength(20);
    expect(frameBox(r).height).toBe(20 + FRAME_ROWS);
  });

  it("a choice list that fits: ↑ ↓ move the marker, the frame keeps its content's height, Enter chooses", async () => {
    const choices = ["One", "Two", "Three"].map((label) => ({ label }));
    const chosen: number[] = [];
    const r = renderKit(
      <TerminalArea>
        <LayerFrame title="Title" footer="Esc to close">
          <ChoiceList choices={choices} onChoose={(i) => chosen.push(i)} />
        </LayerFrame>
      </TerminalArea>,
      { columns: 40, rows: 24 },
    );
    await settle();
    expect(frameBox(r).height).toBe(3 + FRAME_ROWS);
    await r.press(KEYS.down);
    await r.press(KEYS.down);
    expect(markedRow(r)).toBe("3. Three");
    expect(frameBox(r).height).toBe(3 + FRAME_ROWS);
    expect(plain(r)).not.toContain("more");
    await r.press(KEYS.enter);
    expect(chosen).toEqual([2]);
  });
});
