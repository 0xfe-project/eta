import { describe, expect, it } from "@rstest/core";
import { cn } from "@/lib/utils";

describe("cn", () => {
  it("joins class names and drops falsy ones", () => {
    expect(cn("a", false, "b")).toBe("a b");
  });
});
