/** What opens the composer's completion menu, what it lists, and what accepting an item writes. */
import type { ComposerState } from "../../src/ext/conversation/composer/state";
import { describe, expect, it } from "vitest";
import {
  acceptCompletion,
  completionQuery,
  mentionItems,
} from "../../src/ext/conversation/composer/completion";
import { insertText } from "../../src/ext/conversation/composer/editing";
import {
  emptyComposer,
  placeCursor,
} from "../../src/ext/conversation/composer/state";

const typed = (text: string, cursor = text.length): ComposerState =>
  placeCursor(insertText(emptyComposer(), text), cursor);

const members = [
  { id: "a1b2c3d4", name: "Alice" },
  { id: "b1", name: "Bob" },
  { id: "x1y2z3w4", name: "Alice" },
  { id: "m1", name: "Malice" },
];

describe("what opens the menu", () => {
  it("opens the slash menu while the text starts with / and nothing before the cursor is a space", () => {
    expect(completionQuery(typed("/he"))).toEqual({
      kind: "slash",
      query: "he",
      start: 0,
    });
    expect(completionQuery(typed("/"))).toEqual({
      kind: "slash",
      query: "",
      start: 0,
    });
    expect(completionQuery(typed("/help me"))).toBeUndefined();
    expect(completionQuery(typed("/help me", 3))).toEqual({
      kind: "slash",
      query: "he",
      start: 0,
    });
    expect(completionQuery(typed(" /he"))).toBeUndefined();
  });

  it("opens the mention menu on a word starting with @ right before the cursor", () => {
    expect(completionQuery(typed("@al"))).toEqual({
      kind: "mention",
      query: "al",
      start: 0,
    });
    expect(completionQuery(typed("hi @"))).toEqual({
      kind: "mention",
      query: "",
      start: 3,
    });
    expect(completionQuery(typed("line\n@bo"))).toEqual({
      kind: "mention",
      query: "bo",
      start: 5,
    });
  });

  it("does not open on an @ inside a word, after a finished mention, or away from the cursor", () => {
    expect(completionQuery(typed("me@al"))).toBeUndefined();
    expect(completionQuery(typed("@al "))).toBeUndefined();
    expect(completionQuery(typed("@al x", 5))).toBeUndefined();
    expect(completionQuery(typed("plain"))).toBeUndefined();
  });
});

describe("the mention menu", () => {
  it("lists members whose label holds the query in any case, then everyone, then files", () => {
    const items = mentionItems("ali", {
      members,
      locale: "en",
      files: ["src/alias.ts", "README.md", "lib/Align.ts"],
    });
    expect(items).toEqual([
      { kind: "member", id: "a1b2c3d4", label: "Alice·a1b2c3" },
      { kind: "member", id: "x1y2z3w4", label: "Alice·x1y2z3" },
      { kind: "member", id: "m1", label: "Malice" },
      { kind: "file", path: "src/alias.ts" },
      { kind: "file", path: "lib/Align.ts" },
    ]);
  });

  it("lists every member and everyone for a bare @, in the reader's language", () => {
    const en = mentionItems("", { members, locale: "en", files: undefined });
    expect(en.map((item) => item.kind)).toEqual([
      "member",
      "member",
      "member",
      "member",
      "everyone",
    ]);
    expect(en.at(-1)).toEqual({ kind: "everyone", label: "everyone" });
    const zh = mentionItems("", { members, locale: "zh", files: undefined });
    expect(zh.at(-1)).toEqual({ kind: "everyone", label: "所有人" });
  });

  it("lists everyone for a query that matches either name of it", () => {
    for (const query of ["Every", "所有"]) {
      expect(
        mentionItems(query, { members: [], locale: "en", files: [] }),
      ).toEqual([{ kind: "everyone", label: "everyone" }]);
    }
  });

  it("puts members whose label starts with the query before those that only contain it", () => {
    const items = mentionItems("b", {
      members: [
        { id: "1", name: "Rob" },
        { id: "2", name: "Bea" },
      ],
      locale: "en",
      files: [],
    });
    expect(items.map((item) => item.kind === "member" && item.label)).toEqual([
      "Bea",
      "Rob",
    ]);
  });

  it("writes @<path> and a space for a file, and @everyone for everyone", () => {
    const state = typed("see @rea");
    const query = completionQuery(state)!;
    expect(
      acceptCompletion(state, query, { kind: "file", path: "README.md" }).text,
    ).toBe("see @README.md ");
    expect(
      acceptCompletion(state, query, { kind: "everyone", label: "所有人" })
        .text,
    ).toBe("see @所有人 ");
  });
});
