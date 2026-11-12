/** How the composer's text is cut into display rows, and how offsets map to cells and back. */
import { describe, expect, it } from "vitest";
import { layoutRows } from "../../src/ext/conversation/composer/text-layout";

const rowTexts = (text: string, columns: number) =>
  layoutRows(text, columns).map((row) => text.slice(row.start, row.end));

describe("display rows", () => {
  it("puts a wide character alone on a row narrower than it, rather than looping", () => {
    expect(rowTexts("中文", 1)).toEqual(["中", "文", ""]);
  });

  it("keeps a grapheme cluster on one row", () => {
    expect(rowTexts("ab👨‍👩‍👧c", 3)).toEqual(["ab", "👨‍👩‍👧c", ""]);
    expect(rowTexts("abéd", 3)).toEqual(["abé", "d"]);
  });
});
