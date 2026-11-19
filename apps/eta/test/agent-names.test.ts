/**
 * How agent names are compared: one rule, used by create, assignee, and routing.
 */
import { describe, expect, it } from "vitest";
import { foldName, sameName } from "../src/agents/names";
import { resolveNamed, routeUserMessage } from "../src/conversations/routing";

describe("foldName", () => {
  it("trims and ignores case, so these are the same name", () => {
    expect(foldName("  Captain ")).toBe("captain");
    expect(foldName("captain")).toBe("captain");
    expect(foldName("CAPTAIN")).toBe("captain");
  });
});

describe("sameName", () => {
  it("is symmetric", () => {
    expect(sameName("Ada", "ada")).toBe(sameName("ada", "Ada"));
    expect(sameName("Ada", "Bob")).toBe(sameName("Bob", "Ada"));
    expect(sameName("  Captain ", "CAPTAIN")).toBe(
      sameName("CAPTAIN", "  Captain "),
    );
  });
});

describe("routeUserMessage", () => {
  it("wakes the same member when an @ name differs only in case", () => {
    const members = [
      { id: "a1", name: "Ada" },
      { id: "b1", name: "Bob" },
    ];
    const ids = ["a1", "b1"];
    const asWritten = resolveNamed(["@Ada"], members, "user").ids;
    const folded = resolveNamed(["@ADA"], members, "user").ids;
    expect(folded).toEqual(asWritten);
    expect(
      routeUserMessage({
        kind: "group",
        members: ids,
        mentions: folded,
        steward: "b1",
      }).targets,
    ).toEqual(["a1"]);
  });
});
