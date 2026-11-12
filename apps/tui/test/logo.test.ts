import { describe, expect, it } from "vitest";
import { logoLineColors } from "../src/ui/logo";

describe("logoLineColors", () => {
  it("draws in the terminal's own colour where a token is default", () => {
    expect(logoLineColors({ brand: "default", brandDim: "gray" }, 4)).toEqual([
      undefined,
      undefined,
      "gray",
      "gray",
    ]);
  });
});
