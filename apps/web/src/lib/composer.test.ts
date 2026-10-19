import type { Draft } from "./composer";
import { describe, expect, it } from "@rstest/core";
import {
  afterCommand,
  charCount,
  draftOf,
  draftText,
  isBlank,
  isLongPaste,
  LONG_PASTE,
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

  it("splits a slash command from what follows it", () => {
    expect(afterCommand("/goal  ship it ", "/goal")).toBe("ship it");
    expect(afterCommand("/stop", "/stop")).toBe("");
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
