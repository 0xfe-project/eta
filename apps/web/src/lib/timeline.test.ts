import { describe, expect, it } from "@rstest/core";
import { messageView } from "@/test-product";
import { mergeRows } from "./timeline";

const row = (seq: number, revision = 1, text = "") =>
  messageView({ id: `r${seq}`, conversationId: "c", seq, revision, text });

describe("folding rows into a timeline", () => {
  it("puts new rows in seq order", () => {
    const merged = mergeRows([row(2), row(4)], [row(3), row(1)]);
    expect(merged.map((r) => r.seq)).toEqual([1, 2, 3, 4]);
  });

  it("replaces a row with a newer revision of itself where it stands", () => {
    const merged = mergeRows([row(1), row(2, 1, "old")], [row(2, 2, "new")]);
    expect(merged.map((r) => r.text)).toEqual(["", "new"]);
  });

  it("ignores a copy that is not newer, and keeps everything when nothing changed", () => {
    const known = [row(1, 3, "kept"), row(2)];
    expect(mergeRows(known, [row(1, 3, "same"), row(1, 2, "older")])).toBe(
      known,
    );
    expect(mergeRows(known, [])).toBe(known);
  });

  it("leaves the rows that did not change as the same objects", () => {
    const known = [row(1), row(2)];
    const merged = mergeRows(known, [row(3)]);
    expect(merged[0]).toBe(known[0]);
    expect(merged[1]).toBe(known[1]);
  });
});
