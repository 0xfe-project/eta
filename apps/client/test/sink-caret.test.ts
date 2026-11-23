import { expect, test } from "nsh/test";
import {
  pairMiddle,
  retypedCaret,
} from "../src/components/eta-editor/sink-caret";

// What the editor's caret follows when an input method moved its own caret in nsh's hidden field
// (#366). The field's replay can't be driven from a test (no driver moves that caret), so these
// are the documents before and after it, as the editor shows them.

const at = (text: string, caret: number, start = 1) => ({
  head: start + caret,
  start,
  text,
});

test("the next character after a pair lands between its halves: the caret goes after it", () => {
  // "（）|" then 中 typed between: the field replays Backspace, then "中）".
  expect(retypedCaret(at("（）", 2), at("（中）", 3))).toBe(1 + 2);
  expect(retypedCaret(at("前（）后", 3), at("前（中文）后", 5))).toBe(1 + 4);
  // A character equal to the closing half.
  expect(retypedCaret(at("（）", 2), at("（））", 3))).toBe(null);
  expect(retypedCaret(at("（））", 3), at("（）x）", 4))).toBe(1 + 3);
});

test("plain typing, autocorrection and other blocks are left alone", () => {
  expect(retypedCaret(at("ab", 2), at("abc", 3))).toBe(null);
  expect(retypedCaret(at("ab", 1), at("axb", 2))).toBe(null);
  expect(retypedCaret(at("teh", 3), at("the", 3))).toBe(null);
  expect(retypedCaret(at("（）", 2), at("（中）", 3, 5))).toBe(null);
});

test("a pair typed at once has a middle; a lone bracket or other text has none", () => {
  expect(pairMiddle(at("", 0), at("（）", 2))).toBe(1 + 1);
  expect(pairMiddle(at("看", 1), at("看“”", 3))).toBe(1 + 2);
  expect(pairMiddle(at("（", 1), at("（）", 2))).toBe(null);
  expect(pairMiddle(at("", 0), at("中文", 2))).toBe(null);
  expect(pairMiddle(at("", 0), at("）（", 2))).toBe(null);
});
