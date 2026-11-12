/** Finding text in the transcript's plain lines, and moving between the matches. */
import { describe, expect, it } from "vitest";
import { findMatches } from "../../src/ext/conversation/transcript/search";

describe("findMatches", () => {
  it("finds wide characters", () => {
    expect(findMatches(["你好，世界"], "世界")).toEqual([
      { line: 0, start: 3, end: 5 },
    ]);
  });
});
