/** Lines named by their item and back: what keeps the scroll, the selection and the search on their content. */
import type {
  RenderedItem,
  TranscriptItem,
} from "../../src/ext/conversation/contract";
import { describe, expect, it } from "vitest";
import { layoutTranscript } from "../../src/ext/conversation/transcript/layout";
import {
  lineOfPlace,
  placeIn,
  placeOfLine,
} from "../../src/ext/conversation/transcript/places";

const text = (key: string): TranscriptItem => ({
  kind: "text",
  key,
  text: key,
  streaming: false,
});

function drawn(...lines: string[]): RenderedItem {
  return { lines, plain: lines, source: "", foldable: false };
}

// a (2 lines), blank, b (3 lines), blank, c (1 line): lines 0-1, 2, 3-5, 6, 7.
const items = [text("a"), text("b"), text("c")];
const layout = layoutTranscript(items, [
  drawn("a0", "a1"),
  drawn("b0", "b1", "b2"),
  drawn("c0"),
]);

// Three rows as the items name them: a row's items are keyed by its id, alone or before a colon.
// r0 (2 lines), blank, r1:at5:0 (2 lines), blank, r1:at5:1 (3 lines), blank, r2 (1 line):
// lines 0-1, 2, 3-4, 5, 6-8, 9, 10.
const rowItems = [text("r0"), text("r1:at5:0"), text("r1:at5:1"), text("r2")];
const rowLayout = layoutTranscript(rowItems, [
  drawn("r0.0", "r0.1"),
  drawn("think0", "think1"),
  drawn("say0", "say1", "say2"),
  drawn("r2.0"),
]);

/** `rowLayout` once r1's streamed blocks landed as one text item of `lines`. */
function landed(...lines: string[]) {
  return layoutTranscript(
    [text("r0"), text("r1:text"), text("r2")],
    [drawn("r0.0", "r0.1"), drawn(...lines), drawn("r2.0")],
  );
}

describe("lineOfPlace once the item is gone but its row is there", () => {
  it("goes as far into the row's item nearest the place's own line as it went into the gone item", () => {
    // r1:text is lines 3-5 of the landed layout.
    const after = landed("say0", "say1", "say2");
    const gone = { key: "r1:at5:1", offset: 1 };
    expect(lineOfPlace(after, { ...gone, line: 0 })).toBe(4);
    expect(lineOfPlace(after, { ...gone, line: 4 })).toBe(4);
    expect(lineOfPlace(after, { ...gone, line: 9 })).toBe(4);
    expect(lineOfPlace(after, { ...gone, offset: 9, line: 0 })).toBe(5);
    expect(lineOfPlace(after, { ...gone, offset: -1, line: 0 })).toBe(2);
  });

  it("picks, among several items of the row, the one nearest the place's own line", () => {
    const after = layoutTranscript(
      [text("r0"), text("r1:thinking"), text("r1:text"), text("r2")],
      [
        drawn("r0.0", "r0.1"),
        drawn("t0"),
        drawn("s0", "s1", "s2"),
        drawn("r2.0"),
      ],
    );
    // r1:thinking is line 3, r1:text lines 5-7.
    const gone = { key: "r1:at5:1", offset: 1 };
    expect(lineOfPlace(after, { ...gone, line: 3 })).toBe(3);
    expect(lineOfPlace(after, { ...gone, line: 6 })).toBe(6);
    expect(lineOfPlace(after, { ...gone, line: 10 })).toBe(6);
  });

  it("takes a row id that has no colon of its own as the whole row", () => {
    const after = layoutTranscript(
      [text("r0"), text("r1"), text("r1:joined"), text("r2")],
      [drawn("r0.0", "r0.1"), drawn("u0"), drawn("joined"), drawn("r2.0")],
    );
    // r1 is line 3, r1:joined line 5.
    expect(lineOfPlace(after, { key: "r1:gone", offset: 0, line: 0 })).toBe(3);
    expect(lineOfPlace(after, { key: "r1:gone", offset: 0, line: 10 })).toBe(5);
  });

  it("does not count a row whose id only starts the same", () => {
    const after = layoutTranscript(
      [text("r0"), text("r10:text"), text("r2")],
      [drawn("r0.0", "r0.1"), drawn("ten0", "ten1"), drawn("r2.0")],
    );
    // No item of row r1 is left, so the place's own line stands; r10:text would be line 3.
    expect(lineOfPlace(after, { key: "r1:at5:1", offset: 0, line: 1 })).toBe(1);
  });
});

describe("placeIn", () => {
  it("keeps an offset past the item's end while the item is there, for when it grows back", () => {
    const place = { key: "b", offset: 5, line: 5 };
    expect(placeIn(layout, place)).toBe(place);
  });

  it("names the line a gone item stands in for by the item there now", () => {
    const place = placeOfLine(rowLayout, 7); // say1, offset 1 of r1:at5:1
    expect(place).toEqual({ key: "r1:at5:1", offset: 1, line: 7 });
    // Landing folded the thinking away: r1:text is lines 3-5, and line 7 is past it.
    const after = landed("say0", "say1", "say2");
    expect(placeIn(after, place)).toEqual({
      key: "r1:text",
      offset: 1,
      line: 4,
    });
  });

  it("leaves a place alone in an empty layout, so it is still there when the lines come back", () => {
    const place = { key: "b", offset: 1, line: 4 };
    expect(placeIn(layoutTranscript([], []), place)).toBe(place);
  });
});
