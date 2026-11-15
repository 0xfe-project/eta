import { describe, expect, it } from "@rstest/core";
import { agentNameProblem } from "./agent-form";

const agents = [
  { id: "cap", name: "Captain" },
  { id: "ada", name: "Ada" },
  // A user agent from before "Captain" was reserved.
  { id: "old", name: "captain" },
];

describe("agentNameProblem", () => {
  it("says Captain's name is reserved, in any case", () => {
    for (const name of ["Captain", "captain", "  CAPTAIN "])
      expect(agentNameProblem(agents, name)).toBe("reserved");
    expect(agentNameProblem(agents, "Captain", "ada")).toBe("reserved");
  });

  it("says another agent's name is taken, in any case", () => {
    expect(agentNameProblem(agents, "ada")).toBe("taken");
    expect(agentNameProblem(agents, "Bob")).toBeUndefined();
  });

  it("lets an agent keep the name it has", () => {
    expect(agentNameProblem(agents, "ADA", "ada")).toBeUndefined();
    expect(agentNameProblem(agents, "captain", "old")).toBeUndefined();
  });
});
