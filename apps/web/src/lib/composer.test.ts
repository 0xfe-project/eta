import type { Draft } from "./composer";
import { describe, expect, it } from "@rstest/core";
import {
  afterCommand,
  charCount,
  draftFiles,
  draftOf,
  draftText,
  draftWithBlocks,
  isBlank,
  isLongPaste,
  LONG_PASTE,
  pasteBlocksOf,
} from "./composer";

describe("long pastes", () => {
  it("count characters as people see them, and lines", () => {
    expect(charCount("😀字a")).toBe(3);
    expect(isLongPaste("字".repeat(LONG_PASTE.chars))).toBe(false);
    expect(isLongPaste("字".repeat(LONG_PASTE.chars + 1))).toBe(true);
    expect(isLongPaste("x\n".repeat(LONG_PASTE.lines - 1))).toBe(false);
    expect(isLongPaste("x\n".repeat(LONG_PASTE.lines))).toBe(true);
  });
});

describe("a draft as a message", () => {
  const draft: Draft = [
    { type: "text", text: "看：" },
    { type: "paste", id: "p", text: "很长\n的日志" },
    { type: "text", text: "和" },
  ];

  it("keeps the order, a paste as the text it stands for", () => {
    expect(draftText(draft)).toBe("看：很长\n的日志和");
  });

  it("is blank without text", () => {
    expect(isBlank([{ type: "text", text: " \n" }])).toBe(true);
    expect(isBlank([])).toBe(true);
    expect(isBlank(draft)).toBe(false);
  });

  it("does not count a file as text, and is not blank with one", () => {
    const file = {
      type: "file" as const,
      id: "f",
      name: "a.png",
      contentType: "image/png",
      size: 3,
    };
    expect(draftText([{ type: "text", text: "看" }, file])).toBe("看");
    expect(isBlank([file])).toBe(false);
    expect(draftFiles([{ type: "text", text: "看" }, file, file])).toEqual([
      file,
      file,
    ]);
  });

  it("splits a slash command from what follows it", () => {
    expect(afterCommand("/goal  ship it ", "/goal")).toBe("ship it");
    expect(afterCommand("/stop", "/stop")).toBe("");
  });
});

describe("where the folded pastes sit in that text", () => {
  const log = "很长\n的日志"; // 6 UTF-16 units
  const paste = { type: "paste" as const, id: "p", text: log };
  const file = {
    type: "file" as const,
    id: "f",
    name: "a.png",
    contentType: "image/png",
    size: 3,
  };

  it("marks each paste's range, a file worth no text", () => {
    expect(
      draftWithBlocks([{ type: "text", text: "看：" }, paste, file]),
    ).toEqual({
      text: "看：很长\n的日志",
      blocks: [[2, 8]],
    });
  });

  it("covers a block at the start, at the end, and two of them", () => {
    expect(draftWithBlocks([paste, { type: "text", text: "?" }])).toEqual({
      text: `${log}?`,
      blocks: [[0, 6]],
    });
    expect(draftWithBlocks([{ type: "text", text: "?" }, paste])).toEqual({
      text: `?${log}`,
      blocks: [[1, 7]],
    });
    expect(
      draftWithBlocks([paste, { type: "text", text: " 和 " }, paste]),
    ).toEqual({
      text: `${log} 和 ${log}`,
      blocks: [
        [0, 6],
        [9, 15],
      ],
    });
  });

  it("trims the way the host will, moving the ranges with the text", () => {
    // The host stores the trimmed text and a renderer slices that, so the ranges must be at
    // home in it: leading whitespace goes and every range slides left with it.
    expect(
      draftWithBlocks([
        { type: "text", text: " \n" },
        paste,
        { type: "text", text: " " },
      ]),
    ).toEqual({ text: log, blocks: [[0, 6]] });
  });

  it("says there are no blocks when the draft is only typing", () => {
    expect(draftWithBlocks([{ type: "text", text: "打字" }])).toEqual({
      text: "打字",
      blocks: [],
    });
  });
});

describe("a row's blocks, read back", () => {
  const text = "ab" + "12345" + "cd"; // the paste sits at [2, 7)

  it("reads validated pairs, in order and apart from each other", () => {
    expect(pasteBlocksOf({ blocks: [[2, 7]] }, text)).toEqual([[2, 7]]);
    expect(
      pasteBlocksOf(
        {
          blocks: [
            [0, 2],
            [2, 7],
            [7, 9],
          ],
        },
        text,
      ),
    ).toEqual([
      [0, 2],
      [2, 7],
      [7, 9],
    ]);
  });

  it("reads none for an old row, and none for anything malformed", () => {
    expect(pasteBlocksOf({}, text)).toBeUndefined();
    expect(pasteBlocksOf({ blocks: [] }, text)).toBeUndefined();
    expect(pasteBlocksOf({ blocks: [[2, 20]] }, text)).toBeUndefined(); // past the end
    expect(pasteBlocksOf({ blocks: [[-1, 2]] }, text)).toBeUndefined();
    expect(pasteBlocksOf({ blocks: [[7, 2]] }, text)).toBeUndefined(); // end before start
    expect(pasteBlocksOf({ blocks: [[2, 2]] }, text)).toBeUndefined(); // empty
    expect(
      pasteBlocksOf(
        {
          blocks: [
            [5, 7],
            [2, 4],
          ],
        },
        text,
      ),
    ).toBeUndefined(); // out of order
    expect(
      pasteBlocksOf(
        {
          blocks: [
            [0, 5],
            [3, 7],
          ],
        },
        text,
      ),
    ).toBeUndefined(); // overlapping
    expect(pasteBlocksOf({ blocks: [[2, 7, 0]] }, text)).toBeUndefined(); // not a pair
    expect(pasteBlocksOf({ blocks: [["a", "b"]] }, text)).toBeUndefined(); // not integers
    expect(pasteBlocksOf({ blocks: [[1.5, 3]] }, text)).toBeUndefined();
    expect(pasteBlocksOf({ blocks: 2 }, text)).toBeUndefined();
  });
});

describe("a message back as a draft", () => {
  it("folds a long text into a block again and keeps a short one as text", () => {
    const long = "x\n".repeat(LONG_PASTE.lines + 1);
    expect(draftOf("你好")).toEqual([{ type: "text", text: "你好" }]);
    const folded = draftOf(long);
    expect(folded).toHaveLength(1);
    expect(folded[0]).toMatchObject({ type: "paste", text: long });
    expect(draftOf("")).toEqual([]);
  });
});
