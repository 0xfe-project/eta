/** Folded pastes: when a paste folds, how its placeholder behaves as one piece, and how it expands. */
import type { ComposerState } from "../../src/ext/conversation/composer/state";
import { describe, expect, it } from "vitest";
import {
  deleteBackward,
  deleteForward,
  deleteToLineStart,
  deleteWordBefore,
  insertText,
  moveLeft,
  moveRight,
  moveVertically,
} from "../../src/ext/conversation/composer/editing";
import {
  outgoing,
  pasteText,
  placeholderLabel,
} from "../../src/ext/conversation/composer/paste";
import {
  emptyComposer,
  placeCursor,
} from "../../src/ext/conversation/composer/state";

const typed = (text: string, cursor = text.length): ComposerState =>
  placeCursor(insertText(emptyComposer(), text), cursor);

const sixLines = "1\n2\n3\n4\n5\n6";
const label1 = "[Pasted text #1 +6 lines]";

describe("when a paste folds", () => {
  it("inserts up to 5 lines as written", () => {
    const state = pasteText(typed(""), "1\n2\n3\n4\n5");
    expect(state.text).toBe("1\n2\n3\n4\n5");
    expect(state.pastes).toEqual([]);
  });

  it("inserts 800 characters as written and folds 801", () => {
    expect(pasteText(typed(""), "x".repeat(800)).pastes).toEqual([]);
    const folded = pasteText(typed(""), "x".repeat(801));
    expect(folded.text).toBe("[Pasted text #1 +1 lines]");
    expect(folded.pastes[0]?.content).toBe("x".repeat(801));
  });

  it("counts characters, not UTF-16 units: 800 emoji are not folded", () => {
    expect(pasteText(typed(""), "😀".repeat(800)).pastes).toEqual([]);
  });

  it("counts lines after normalizing, so CRLF pastes fold the same as LF ones", () => {
    const state = pasteText(typed(""), "1\r\n2\r\n3\r\n4\r\n5\r\n6");
    expect(state.text).toBe(label1);
    expect(state.pastes[0]?.content).toBe(sixLines);
  });

  it("numbers placeholders one past the highest in the draft", () => {
    let state = pasteText(typed(""), sixLines);
    state = pasteText(state, `${sixLines}\n7`);
    expect(state.text).toBe(`${label1}[Pasted text #2 +7 lines]`);
    expect(placeholderLabel(2, 7)).toBe("[Pasted text #2 +7 lines]");
  });
});

describe("a placeholder is one piece", () => {
  const withPaste = () => pasteText(typed("ab", 1), sixLines);

  it("steps over the placeholder in one move left or right", () => {
    const state = withPaste();
    expect(moveLeft(state).cursor).toBe(1);
    expect(moveRight(moveLeft(state)).cursor).toBe(1 + label1.length);
  });

  it("never puts the cursor inside it", () => {
    const state = withPaste();
    expect(placeCursor(state, 5).cursor).toBe(1);
    const narrow = moveVertically(
      placeCursor(insertText(state, "\nxxxxxxxx"), state.text.length + 6),
      40,
      -1,
    );
    expect(narrow?.cursor).toBe(1);
  });

  it("goes whole with Delete before it", () => {
    const state = deleteForward(moveLeft(withPaste()));
    expect(state.text).toBe("ab");
    expect(state.pastes).toEqual([]);
  });

  it("goes whole when a word or line deletion reaches into it", () => {
    expect(deleteWordBefore(withPaste()).text).toBe("ab");
    expect(deleteToLineStart(withPaste()).text).toBe("b");
  });

  it("moves along with text typed before it", () => {
    const state = insertText(placeCursor(withPaste(), 0), "中文");
    expect(state.pastes[0]?.start).toBe(3);
    expect(state.text.slice(3, state.pastes[0]?.end)).toBe(label1);
  });

  it("is not one when the user types the same text", () => {
    const state = typed(label1);
    expect(state.pastes).toEqual([]);
    expect(deleteBackward(state).text).toBe(label1.slice(0, -1));
  });
});

describe("expanding for sending", () => {
  it("puts every paste back and says where each sits, in UTF-16 offsets", () => {
    let state = typed("中");
    state = pasteText(state, sixLines);
    state = insertText(state, "👍🏽 and ");
    state = pasteText(state, `${sixLines}\n7`);
    state = insertText(state, "end");
    const sent = outgoing(state);
    const second = `${sixLines}\n7`;
    expect(sent.text).toBe(`中${sixLines}👍🏽 and ${second}end`);
    const firstStart = 1;
    const secondStart = firstStart + sixLines.length + 4 + 5;
    expect(sent.pastes).toEqual([
      [firstStart, firstStart + sixLines.length],
      [secondStart, secondStart + second.length],
    ]);
    for (const [start, end] of sent.pastes)
      expect([sixLines, second]).toContain(sent.text.slice(start, end));
  });

  it("trims the text as the host stores it, and the ranges with it", () => {
    let state = typed("  \n ");
    state = pasteText(state, sixLines);
    state = insertText(state, "  ");
    const sent = outgoing(state);
    expect(sent.text).toBe(sixLines);
    expect(sent.pastes).toEqual([[0, sixLines.length]]);
  });

  it("cuts a range to the trimmed text when the paste itself starts or ends in spaces", () => {
    const padded = `  ${sixLines}\n  `;
    const sent = outgoing(pasteText(typed(""), padded));
    expect(sent.text).toBe(padded.trim());
    expect(sent.pastes).toEqual([[0, padded.trim().length]]);
  });
});
