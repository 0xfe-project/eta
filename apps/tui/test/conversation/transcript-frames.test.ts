/**
 * A group reply framed in its agent's colour: which items a frame holds, the width they are drawn
 * at, the colour an agent id picks, and the frame put together around the drawn lines.
 */
import type {
  AuthorDrawing,
  FrameStyle,
  RenderedItem,
  RenderItem,
  RenderOptions,
  TranscriptItem,
} from "../../src/ext/conversation/contract";
import type { TranscriptLayout } from "../../src/ext/conversation/transcript/layout";
import { stripVTControlCharacters } from "node:util";
import stringWidth from "string-width";
import { describe, expect, it } from "vitest";
import {
  agentColour,
  agentColourIndex,
} from "../../src/ext/conversation/render/agent-colour";
import { createItemKeeper } from "../../src/ext/conversation/stable-items";
import {
  drawWidths,
  FRAME_MIN_WIDTH,
  frameOwners,
} from "../../src/ext/conversation/transcript/frames";
import { layoutTranscript } from "../../src/ext/conversation/transcript/layout";
import {
  lineOfPlace,
  placeOfLine,
} from "../../src/ext/conversation/transcript/places";
import { createRenderCache } from "../../src/ext/conversation/transcript/render-cache";
import { foldPlace } from "../../src/ext/conversation/transcript/selection";
import { testConfig } from "../ui-support/config";

const MAGENTA = "\u001B[35m";
const FG_OFF = "\u001B[39m";
const BOLD = "\u001B[1m";
const BOLD_OFF = "\u001B[22m";
// eslint-disable-next-line no-control-regex
const SGR = /\u001B\[[\d;]*m/;

const user = (key: string): TranscriptItem => ({
  kind: "user",
  key,
  text: key,
  pastes: [],
  attachments: [],
  images: [],
});
const author = (row: string, name: string): TranscriptItem => ({
  kind: "author",
  key: `${row}:author`,
  name,
  agentId: `agent-${name}`,
  members: [],
});
const text = (key: string): TranscriptItem => ({
  kind: "text",
  key,
  text: key,
  streaming: false,
});

function drawn(...lines: string[]): RenderedItem {
  return {
    lines: lines.map((line) =>
      line === "" ? "" : `${BOLD}${line}${BOLD_OFF}`,
    ),
    plain: lines,
    source: `source of ${lines.join("/")}`,
    foldable: false,
  };
}

function style(name: string): FrameStyle {
  return {
    name,
    border: { open: MAGENTA, close: FG_OFF },
    nameStyle: { open: `${BOLD}${MAGENTA}`, close: `${FG_OFF}${BOLD_OFF}` },
  };
}

function drawnAuthor(name: string): AuthorDrawing {
  return { ...drawn(`● ${name}`), source: name, frame: style(name) };
}

/**
 * A drawing with a frame style whatever the item, as a renderer standing in for `render/` gives
 * it: `RenderItem` asks for one on every author, and the layout reads it only there.
 */
function framedDrawing(line: string): AuthorDrawing {
  return { ...drawn(line), frame: style(line) };
}

/** A user message, then Ada's reply of two items, then Ben's reply of one. */
function scene(): { items: TranscriptItem[]; rendered: RenderedItem[] } {
  return {
    items: [
      user("r1"),
      author("r2", "Ada"),
      text("r2:a"),
      text("r2:b"),
      author("r3", "Ben"),
      text("r3:a"),
    ],
    rendered: [
      drawn("r1"),
      drawnAuthor("Ada"),
      drawn("a.0", "a.1"),
      drawn("b.0"),
      drawnAuthor("Ben"),
      drawn("c.0"),
    ],
  };
}

const visible = (layout: TranscriptLayout) =>
  layout.lines.map((line) => stripVTControlCharacters(line));

const dashes = (count: number) => "─".repeat(count);
const spaces = (count: number) => " ".repeat(count);

describe("agentColourIndex", () => {
  it("is the 32-bit FNV-1a hash of the id's UTF-16 units, modulo the number of colours", () => {
    expect(agentColourIndex("a", 6)).toBe(3826002220 % 6);
    expect(agentColourIndex("", 6)).toBe(2166136261 % 6);
    expect(agentColourIndex("bob", 7)).toBe(2261164244 % 7);
    expect(agentColourIndex("中文", 6)).toBe(1362277805 % 6);
  });

  it("is the same index for the same id every time, and always inside the list", () => {
    for (const id of ["a1", "a2", "agent-ada-0001", "", "中文"]) {
      for (const count of [1, 2, 3, 6, 13]) {
        const index = agentColourIndex(id, count);
        expect(agentColourIndex(id, count)).toBe(index);
        expect(index).toBeGreaterThanOrEqual(0);
        expect(index).toBeLessThan(count);
        expect(Number.isInteger(index)).toBe(true);
      }
    }
  });

  it("spreads different ids over the colours", () => {
    const ids = Array.from({ length: 60 }, (_, i) => `agent-${i}`);
    const used = new Set(ids.map((id) => agentColourIndex(id, 6)));
    expect(used.size).toBe(6);
  });
});

// Preferred indexes among 6 colours, from the hash: a1 1, ada 1, agent-2 1, bob 2, x 3, a3 5, c1 5;
// among 2: a1 1, a2 0, a3 1, ada 1, bob 0.
const SIX = ["c0", "c1", "c2", "c3", "c4", "c5"];

function permutations<T>(list: readonly T[]): T[][] {
  if (list.length <= 1) return [[...list]];
  return list.flatMap((first, index) =>
    permutations([...list.slice(0, index), ...list.slice(index + 1)]).map(
      (rest) => [first, ...rest],
    ),
  );
}

describe("agentColour", () => {
  it("gives each member its preferred colour when none of them share one", () => {
    const members = ["bob", "x"];
    expect(agentColour("bob", members, SIX)).toBe("c2");
    expect(agentColour("x", members, SIX)).toBe("c3");
  });

  it("moves the later of two members by id that prefer the same colour on to the next free one", () => {
    const members = ["ada", "a1"];
    expect(agentColour("a1", members, SIX)).toBe("c1");
    expect(agentColour("ada", members, SIX)).toBe("c2");
  });

  it("goes round past the last colour, and past every colour already taken", () => {
    expect(agentColour("a3", ["c1", "a3"], SIX)).toBe("c5");
    expect(agentColour("c1", ["c1", "a3"], SIX)).toBe("c0");
    const crowded = ["bob", "agent-2", "ada", "a1"];
    expect(crowded.map((id) => agentColour(id, crowded, SIX))).toEqual([
      "c4",
      "c3",
      "c2",
      "c1",
    ]);
  });

  it("gives every member one colour of the list when there are more members than colours, the first ones all different", () => {
    const two = ["p", "q"];
    const members = ["bob", "ada", "a3", "a2", "a1"];
    const got = members.map((id) => agentColour(id, members, two));
    for (const colour of got) expect(two).toContain(colour);
    expect(agentColour("a1", members, two)).not.toBe(
      agentColour("a2", members, two),
    );
    expect(got).toEqual(["p", "p", "q", "p", "q"]);
  });

  it("is the same whatever order the members come in", () => {
    const members = ["bob", "agent-2", "ada", "a1"];
    const expected = members.map((id) => agentColour(id, members, SIX));
    for (const order of permutations(members))
      expect(members.map((id) => agentColour(id, order, SIX))).toEqual(
        expected,
      );
  });

  it("works in the user's own list of colours", () => {
    const mine = ["#111", "#222"];
    // a1 and ada both prefer index 1 of two.
    expect(agentColour("a1", ["a1", "ada"], mine)).toBe("#222");
    expect(agentColour("ada", ["a1", "ada"], mine)).toBe("#111");
    expect(agentColour("a1", ["a1"], ["only"])).toBe("only");
  });

  it("gives an agent that is not a member its preferred colour", () => {
    expect(agentColour("ada", ["a1"], SIX)).toBe("c1");
    expect(agentColour("ada", [], SIX)).toBe("c1");
  });

  it("counts a member named twice once", () => {
    expect(agentColour("ada", ["a1", "a1", "ada"], SIX)).toBe("c2");
  });
});

describe("the members an author carries and the drawing cache", () => {
  const withMembers = (members: string[]): TranscriptItem => ({
    kind: "author",
    key: "r1:author",
    name: "Ada",
    agentId: "a1",
    members,
  });

  it("keeps the author and its drawing while the members stay the same, and draws it again when they change", () => {
    const keep = createItemKeeper();
    let draws = 0;
    const cache = createRenderCache((item) => {
      draws += 1;
      return framedDrawing(item.key);
    }, drawWidths);
    const shared = {
      width: 50,
      previewLines: 5,
      theme: testConfig().theme,
      locale: "en" as const,
    };
    const first = keep([withMembers(["a1", "ada"])]);
    cache(first, shared, () => false);
    const same = keep([withMembers(["a1", "ada"])]);
    expect(same[0]).toBe(first[0]);
    cache(same, shared, () => false);
    expect(draws).toBe(1);
    const joined = keep([withMembers(["a1", "ada", "bob"])]);
    expect(joined[0]).not.toBe(first[0]);
    cache(joined, shared, () => false);
    expect(draws).toBe(2);
  });
});

describe("frameOwners", () => {
  it("puts an author and the items of its row after it in one frame, owned by the author", () => {
    const { items } = scene();
    expect(frameOwners(items)).toEqual([-1, 1, 1, 1, 4, 4]);
  });

  it("ends a frame at an item of another row, and starts none without an author", () => {
    const items = [
      author("r1", "Ada"),
      text("r1:a"),
      user("r2"),
      text("r3:a"),
      text("r1:late"),
    ];
    expect(frameOwners(items)).toEqual([0, 0, -1, -1, -1]);
    expect(frameOwners([text("r1:a"), user("r2")])).toEqual([-1, -1]);
  });

  it("ends a frame at the next author even of the same row", () => {
    const items = [author("r1", "Ada"), text("r1:a"), author("r1", "Ada")];
    expect(frameOwners(items)).toEqual([0, 0, 2]);
  });

  it("frames an author with nothing after it on its own", () => {
    expect(frameOwners([author("r1", "Ada")])).toEqual([0]);
  });
});

describe("drawWidths", () => {
  it("draws the items inside a frame four columns narrower, the author and the rest at the whole width", () => {
    const { items } = scene();
    expect(drawWidths(items, 50)).toEqual([50, 50, 46, 46, 50, 46]);
  });

  it("frames from 40 columns, and below that draws everything at the whole width", () => {
    const { items } = scene();
    expect(FRAME_MIN_WIDTH).toBe(40);
    expect(drawWidths(items, 40)).toEqual([40, 40, 36, 36, 40, 36]);
    expect(drawWidths(items, 39)).toEqual([39, 39, 39, 39, 39, 39]);
  });
});

describe("layoutTranscript with frames", () => {
  const WIDTH = 40;
  const framed = () => {
    const { items, rendered } = scene();
    return layoutTranscript(items, rendered, WIDTH);
  };

  it("draws each reply in a frame with its name in the top edge, the user's message bare", () => {
    expect(visible(framed())).toEqual([
      "r1",
      "",
      `╭─ Ada ${dashes(WIDTH - 5 - 3)}╮`,
      `│ a.0${spaces(WIDTH - 4 - 3)} │`,
      `│ a.1${spaces(WIDTH - 4 - 3)} │`,
      `│${spaces(WIDTH - 2)}│`,
      `│ b.0${spaces(WIDTH - 4 - 3)} │`,
      `╰${dashes(WIDTH - 2)}╯`,
      "",
      `╭─ Ben ${dashes(WIDTH - 5 - 3)}╮`,
      `│ c.0${spaces(WIDTH - 4 - 3)} │`,
      `╰${dashes(WIDTH - 2)}╯`,
    ]);
  });

  it("keeps the frame out of the plain lines: the name on the top edge, nothing on the bottom", () => {
    expect(framed().plain).toEqual([
      "r1",
      "",
      "Ada",
      "a.0",
      "a.1",
      "",
      "b.0",
      "",
      "",
      "Ben",
      "c.0",
      "",
    ]);
  });

  it("gives the top edge to the author and the bottom edge to the frame's last item", () => {
    const layout = framed();
    expect(layout.owner).toEqual([0, -1, 1, 2, 2, -1, 3, 3, -1, 4, 5, 5]);
    expect(layout.starts).toEqual([0, 2, 3, 6, 9, 10]);
    expect(layout.counts).toEqual([1, 1, 2, 2, 1, 2]);
    expect(layout.keys).toEqual(scene().items.map((item) => item.key));
  });

  it("colours only the frame and the name; the content keeps its own codes", () => {
    const layout = framed();
    const { rendered } = scene();
    expect(layout.lines[0]).toBe(rendered[0]!.lines[0]);
    expect(layout.lines[1]).toBe("");
    expect(layout.lines[2]!.startsWith(`${MAGENTA}╭─ ${FG_OFF}`)).toBe(true);
    expect(layout.lines[2]).toContain(
      `${BOLD}${MAGENTA}Ada${FG_OFF}${BOLD_OFF}`,
    );
    expect(layout.lines[2]!.endsWith(`╮${FG_OFF}`)).toBe(true);
    const content = rendered[2]!.lines[0]!;
    expect(layout.lines[3]!.startsWith(`${MAGENTA}│ ${FG_OFF}${content}`)).toBe(
      true,
    );
    expect(layout.lines[3]!.endsWith(` │${FG_OFF}`)).toBe(true);
    // Between the left edge and the right edge only the content's own codes.
    const between = layout.lines[3]!.slice(
      `${MAGENTA}│ ${FG_OFF}`.length + content.length,
      layout.lines[3]!.lastIndexOf(MAGENTA),
    );
    expect(between).toMatch(/^ *$/);
    expect(layout.lines[7]).toBe(`${MAGENTA}╰${dashes(WIDTH - 2)}╯${FG_OFF}`);
    expect(layout.lines[8]).toBe("");
  });

  it("says how each line is framed, and nothing for the lines outside", () => {
    const layout = framed();
    expect(layout.frames.map((frame) => frame?.edge)).toEqual([
      undefined,
      undefined,
      "top",
      "side",
      "side",
      "side",
      "side",
      "bottom",
      undefined,
      "top",
      "side",
      "bottom",
    ]);
    expect(layout.frames[3]?.style).toEqual(style("Ada"));
    expect(layout.frames).toHaveLength(layout.lines.length);
  });

  it("keeps every framed line exactly as wide as the transcript with wide characters and content that fills it", () => {
    const wide = "中文字符".repeat(4); // 32 columns, the most at 36 is 36
    const full = "x".repeat(WIDTH - 4);
    const layout = layoutTranscript(
      [author("r1", "宽字名"), text("r1:a"), text("r1:b")],
      [drawnAuthor("宽字名"), drawn(wide, `${wide}中文`), drawn(full)],
      WIDTH,
    );
    for (const line of visible(layout)) {
      expect(stringWidth(line), line).toBe(WIDTH);
      expect(/[│╮╯]$/.test(line), line).toBe(true);
    }
  });

  it("cuts a name too long for the top edge, keeping the edge whole", () => {
    const name = "N".repeat(60);
    const layout = layoutTranscript(
      [author("r1", name), text("r1:a")],
      [drawnAuthor(name), drawn("a")],
      WIDTH,
    );
    const top = visible(layout)[0]!;
    expect(stringWidth(top)).toBe(WIDTH);
    expect(top.startsWith("╭─ N")).toBe(true);
    expect(top).toContain("…");
    expect(top.endsWith("─╮")).toBe(true);
    expect(layout.plain[0]).toBe(top.slice(3, top.indexOf("…") + 1));
  });

  it("frames an author with nothing after it as a top and a bottom edge", () => {
    const layout = layoutTranscript(
      [author("r1", "Ada")],
      [drawnAuthor("Ada")],
      WIDTH,
    );
    expect(visible(layout)).toEqual([
      `╭─ Ada ${dashes(WIDTH - 8)}╮`,
      `╰${dashes(WIDTH - 2)}╯`,
    ]);
    expect(layout.owner).toEqual([0, 0]);
    expect(layout.counts).toEqual([2]);
  });

  it("puts a blank line between a reply with no items and what follows, the empty reply still framed", () => {
    const layout = layoutTranscript(
      [author("r1", "Ada"), author("r2", "Ben"), text("r2:a"), user("r3")],
      [drawnAuthor("Ada"), drawnAuthor("Ben"), drawn("c.0"), drawn("r3")],
      WIDTH,
    );
    expect(visible(layout)).toEqual([
      `╭─ Ada ${dashes(WIDTH - 8)}╮`,
      `╰${dashes(WIDTH - 2)}╯`,
      "",
      `╭─ Ben ${dashes(WIDTH - 8)}╮`,
      `│ c.0${spaces(WIDTH - 4 - 3)} │`,
      `╰${dashes(WIDTH - 2)}╯`,
      "",
      "r3",
    ]);
    expect(layout.owner).toEqual([0, 0, -1, 1, 2, 2, -1, 3]);
    const last = layoutTranscript(
      [author("r1", "Ada"), user("r2")],
      [drawnAuthor("Ada"), drawn("r2")],
      WIDTH,
    );
    expect(visible(last)).toEqual([
      `╭─ Ada ${dashes(WIDTH - 8)}╮`,
      `╰${dashes(WIDTH - 2)}╯`,
      "",
      "r2",
    ]);
  });

  it("below 40 columns puts a blank line after an author whose reply has no items", () => {
    const layout = layoutTranscript(
      [author("r1", "Ada"), author("r2", "Ben"), text("r2:a")],
      [drawnAuthor("Ada"), drawnAuthor("Ben"), drawn("c.0")],
      FRAME_MIN_WIDTH - 1,
    );
    expect(layout.plain).toEqual(["● Ada", "", "● Ben", "c.0"]);
  });

  it("cuts content wider than the inside of the frame, so every framed line is the transcript's width", () => {
    const wide = "x".repeat(WIDTH);
    const cjk = "宽".repeat(WIDTH);
    // Half as many characters as columns, but twice as wide as it is long: only its width shows it
    // does not fit.
    const halfLong = "宽".repeat(WIDTH / 2);
    const layout = layoutTranscript(
      [author("r1", "Ada"), text("r1:a")],
      [drawnAuthor("Ada"), drawn(wide, cjk, "fits", halfLong)],
      WIDTH,
    );
    const shown = visible(layout);
    for (const line of shown) {
      expect(stringWidth(line), line).toBe(WIDTH);
      expect(/[│╮╯]$/.test(line), line).toBe(true);
    }
    expect(shown[1]).toBe(`│ ${"x".repeat(WIDTH - 5)}… │`);
    // A cut between wide characters can leave one column before the bar.
    expect(shown[2]).toMatch(/… +│$/);
    expect(shown[3]).toBe(`│ fits${spaces(WIDTH - 8)} │`);
    // The plain lines are what shows, so the search marks what is on screen.
    expect(layout.plain[1]).toBe(`${"x".repeat(WIDTH - 5)}…`);
    expect(stringWidth(layout.plain[2]!)).toBeLessThanOrEqual(WIDTH - 4);
    expect(halfLong.length).toBeLessThanOrEqual(WIDTH - 4);
    expect(shown[4]).toBe(`│ ${"宽".repeat((WIDTH - 6) / 2)}…  │`);
    expect(layout.plain[4]).toBe(`${"宽".repeat((WIDTH - 6) / 2)}…`);
  });

  it("refuses an author drawn without a frame style where frames show, and needs none below 40 columns", () => {
    const bare: RenderedItem = { ...drawn("● Ada"), source: "Ada" };
    const items = [author("r1", "Ada"), text("r1:a")];
    expect(() => layoutTranscript(items, [bare, drawn("a.0")], WIDTH)).toThrow(
      /no frame style/,
    );
    expect(
      layoutTranscript(items, [bare, drawn("a.0")], FRAME_MIN_WIDTH - 1).plain,
    ).toEqual(["● Ada", "a.0"]);
  });

  it("below 40 columns draws the author's own line and no frame", () => {
    const { items, rendered } = scene();
    const layout = layoutTranscript(items, rendered, FRAME_MIN_WIDTH - 1);
    expect(layout.plain).toEqual([
      "r1",
      "",
      "● Ada",
      "a.0",
      "a.1",
      "",
      "b.0",
      "",
      "● Ben",
      "c.0",
    ]);
    expect(layout.lines[2]).toBe(rendered[1]!.lines[0]);
    expect(layout.frames.every((frame) => frame === undefined)).toBe(true);
    expect(layout.owner).toEqual([0, -1, 1, 2, 2, -1, 3, -1, 4, 5]);
  });
});

describe("places in a framed layout", () => {
  const { items, rendered } = scene();
  const layout = layoutTranscript(items, rendered, 40);

  it("names every line by an item and finds the same line again", () => {
    layout.lines.forEach((_, line) => {
      const place = placeOfLine(layout, line);
      expect(place.key, `line ${line}`).not.toBe("");
      expect(lineOfPlace(layout, place), `line ${line}`).toBe(line);
    });
  });

  it("names the top edge by the author and the bottom edge by the frame's last item", () => {
    expect(placeOfLine(layout, 2)).toMatchObject({
      key: "r2:author",
      offset: 0,
    });
    expect(placeOfLine(layout, 7)).toMatchObject({ key: "r2:b", offset: 1 });
    expect(placeOfLine(layout, 5)).toMatchObject({ key: "r2:b", offset: -1 });
  });

  it("folds and copies from the item each edge belongs to", () => {
    expect(foldPlace(layout, 2)).toEqual({ item: 1, line: 2 });
    expect(foldPlace(layout, 7)).toEqual({ item: 3, line: 6 });
    expect(foldPlace(layout, 11)).toEqual({ item: 5, line: 10 });
    expect(foldPlace(layout, 5)).toBeUndefined();
  });
});

describe("createRenderCache with frames", () => {
  const theme = testConfig().theme;
  const shared = (width: number) => ({
    width,
    previewLines: 5,
    theme,
    locale: "en" as const,
  });

  function counting() {
    const seen: { key: string; options: RenderOptions }[] = [];
    const render: RenderItem = (item, options) => {
      seen.push({ key: item.key, options });
      return framedDrawing(`${item.key}@${options.width}`);
    };
    return { seen, cache: createRenderCache(render, drawWidths) };
  }

  it("draws each item at the width the caller's widths give", () => {
    const seen: string[] = [];
    const cache = createRenderCache(
      (item, options) => {
        seen.push(`${item.key}@${options.width}`);
        return framedDrawing(item.key);
      },
      (items, width) => items.map((_, index) => width - index),
    );
    cache(scene().items.slice(0, 3), shared(50), () => false);
    expect(seen).toEqual(["r1@50", "r2:author@49", "r2:a@48"]);
  });

  it("draws the items inside a frame at the width inside it", () => {
    const { seen, cache } = counting();
    const { items } = scene();
    cache(items, shared(50), () => false);
    expect(seen.map((one) => `${one.key}@${one.options.width}`)).toEqual([
      "r1@50",
      "r2:author@50",
      "r2:a@46",
      "r2:b@46",
      "r3:author@50",
      "r3:a@46",
    ]);
  });

  it("draws an item again when it moves into or out of a frame, and not otherwise", () => {
    const { seen, cache } = counting();
    const { items } = scene();
    const lone = items[2]!;
    cache([lone], shared(50), () => false);
    cache(items, shared(50), () => false);
    expect(
      seen.filter((one) => one.key === "r2:a").map((one) => one.options.width),
    ).toEqual([50, 46]);
    const before = seen.length;
    const again = cache(items, shared(50), () => false);
    expect(seen.length).toBe(before);
    expect(again[2]!.plain).toEqual(["r2:a@46"]);
    cache(items, shared(39), () => false);
    expect(seen.slice(before).map((one) => one.options.width)).toEqual([
      39, 39, 39, 39, 39, 39,
    ]);
  });

  it("puts no frame codes into a drawing", () => {
    const { cache } = counting();
    const out = cache(scene().items, shared(50), () => false);
    for (const one of out)
      for (const line of one.plain) expect(SGR.test(line)).toBe(false);
  });
});
