/**
 * What a group is called when nobody named it: the rule on its own. The path that applies it —
 * a real socket, a real project — is in routing.test.ts.
 */
import { describe, expect, it } from "vitest";
import { defaultGroupName } from "../src/conversations/views";

describe("the default name of a group", () => {
  it("is the project's name, whoever is in it", () => {
    expect(defaultGroupName("roadmap", ["Ada", "Bob"])).toBe("roadmap");
    expect(defaultGroupName("roadmap", [])).toBe("roadmap");
  });

  it("falls back to the members only for a project with no name", () => {
    // A group with an empty name is a row nobody can tell apart, so there is always this last
    // resort; nothing in the host produces a nameless project today.
    expect(defaultGroupName("", ["Ada", "Bob"])).toBe("Ada, Bob");
    expect(defaultGroupName("", [undefined, "Bob"])).toBe("Bob");
  });
});
