/** Editing the composer's text: typing, deleting and moving, by grapheme and by display column. */
import type { ComposerState } from "../../src/ext/conversation/composer/state";
import { describe, expect, it } from "vitest";
import {
  breakLineAtBackslash,
  deleteBackward,
  deleteForward,
  deleteToLineEnd,
  deleteToLineStart,
  deleteWordBefore,
  insertText,
  moveLeft,
  moveRight,
  moveToLineEnd,
  moveToLineStart,
  moveToRowEnd,
  moveToRowStart,
  moveVertically,
} from "../../src/ext/conversation/composer/editing";
import {
  emptyComposer,
  placeCursor,
} from "../../src/ext/conversation/composer/state";

const typed = (text: string, cursor = text.length): ComposerState =>
  placeCursor(insertText(emptyComposer(), text), cursor);

const view = (state: ComposerState) =>
  `${state.text.slice(0, state.cursor)}|${state.text.slice(state.cursor)}`;

describe("moving by grapheme", () => {
  it("moves left and right over a combining mark and an emoji as one step", () => {
    const text = "aé👍🏽b";
    let state = typed(text, 0);
    const stops: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      state = moveRight(state);
      stops.push(state.cursor);
    }
    expect(stops).toEqual([1, 3, 7, 8, 8]);
    state = moveLeft(state);
    expect(state.cursor).toBe(7);
    state = moveLeft(state);
    expect(state.cursor).toBe(3);
  });

  it("goes to the head and tail of the logical line, across wrapping", () => {
    const state = typed("one\ntwo three\nx", 9);
    expect(view(moveToLineStart(state))).toBe("one\n|two three\nx");
    expect(view(moveToLineEnd(state))).toBe("one\ntwo three|\nx");
  });

  it("goes to the head and tail of the display row", () => {
    // "abcdefgh" at 3 columns: rows "abc", "def", "gh". Offset 6 is drawn at the head of "gh",
    // so the tail of "def" is the cell of its last character.
    const state = typed("abcdefgh", 4);
    expect(moveToRowStart(state, 3).cursor).toBe(3);
    expect(moveToRowEnd(state, 3).cursor).toBe(5);
    expect(moveToRowEnd(typed("abcdefgh", 7), 3).cursor).toBe(8);
  });
});

describe("deleting", () => {
  it("deletes the grapheme before and after the cursor, a whole cluster at a time", () => {
    expect(view(deleteBackward(typed("a👍🏽b", 5)))).toBe("a|b");
    expect(view(deleteForward(typed("a👍🏽b", 1)))).toBe("a|b");
    expect(view(deleteBackward(typed("aé", 3)))).toBe("a|");
  });

  it("does nothing at either end", () => {
    expect(view(deleteBackward(typed("ab", 0)))).toBe("|ab");
    expect(view(deleteForward(typed("ab", 2)))).toBe("ab|");
  });

  it("deletes to the head of the line with Ctrl+U, and to the tail with Ctrl+K", () => {
    const state = typed("one\ntwo three\nx", 8);
    expect(view(deleteToLineStart(state))).toBe("one\n|three\nx");
    expect(view(deleteToLineEnd(state))).toBe("one\ntwo |\nx");
  });

  it("deletes the word before the cursor and the spaces after it with Ctrl+W", () => {
    expect(view(deleteWordBefore(typed("say hello  ")))).toBe("say |");
    expect(view(deleteWordBefore(typed("say hello", 6)))).toBe("say |llo");
    expect(view(deleteWordBefore(typed("你好 世界")))).toBe("你好 |");
  });
});

describe("a backslash before Enter", () => {
  it("works in the middle of the text too", () => {
    const state = breakLineAtBackslash(typed("a\\b", 2));
    expect(state && view(state)).toBe("a\n|b");
  });

  it("is not there: nothing to break", () => {
    expect(breakLineAtBackslash(typed("first"))).toBeUndefined();
    expect(breakLineAtBackslash(typed("a\\b"))).toBeUndefined();
  });
});

describe("moving up and down by display column", () => {
  it("keeps the column across logical lines", () => {
    const state = typed("abcdef\nxy\nlonger line", 4);
    const down = moveVertically(state, 20, 1);
    expect(down && view(down)).toBe("abcdef\nxy|\nlonger line");
    const downAgain = down && moveVertically(down, 20, 1);
    expect(downAgain?.cursor).toBe("abcdef\nxy\n".length + 2);
  });

  it("lands before a wide character when the column falls in its middle", () => {
    // 5 columns: rows "ab你" and "好cd".
    const text = "ab你好cd";
    const up = moveVertically(typed(text, 5), 5, -1);
    expect(up?.cursor).toBe(2);
    const down = moveVertically(typed(text, 1), 5, 1);
    expect(down?.cursor).toBe(3);
  });
});
