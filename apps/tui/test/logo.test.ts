import { describe, expect, it } from "vitest";
import { logoLineColors } from "../src/ui/logo";

describe("logoLineColors", () => {
  it("draws in the terminal's own colour where a token is default", () => {
    expect(logoLineColors({ brand: "default", brandDim: "gray" })).toEqual([
      ...Array.from({ length: 4 }).fill(undefined),
      ...Array.from({ length: 4 }).fill("gray"),
    ]);
  });
});
