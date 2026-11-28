/**
 * What a group is called when nobody named it, for the one case a socket cannot reach: a project
 * with no name. The project's name itself, through a real socket, is in routing.test.ts.
 */
import { describe, expect, it } from "vitest";
import { defaultGroupName } from "../src/conversations/views";

describe("the default name of a group", () => {
  it("falls back to the members only for a project with no name", () => {
    // A group with an empty name is a row nobody can tell apart, so there is always this last
    // resort; nothing in the host produces a nameless project today.
    expect(defaultGroupName("", ["Ada", "Bob"])).toBe("Ada, Bob");
    expect(defaultGroupName("", [undefined, "Bob"])).toBe("Bob");
  });
});
