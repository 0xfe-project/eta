/**
 * Agents for commands: finding one from what the user typed, the live list, and the layer that
 * asks which agent, against a real host.
 */
import type { AgentView } from "@eta/client-contracts";
import { describe, expect, it } from "vitest";
import { findAgent } from "../../src/ext/kit/agents";

function agent(id: string, name: string): AgentView {
  return {
    id,
    name,
    instructions: "",
    persona: "",
    runtime: "eta" as AgentView["runtime"],
    model: null,
    thinkingLevel: null,
    machineId: null,
    systemRole: null,
    plugins: [],
    skippedPlugins: [],
    home: "",
    homeProjectId: "",
    status: "idle",
    createdAt: 0,
    updatedAt: 0,
  };
}

const ADA = agent("a1", "Ada");
const ADAM = agent("a2", "Adam");
const BEA = agent("b1", "Bea");
const BEATRIX = agent("b2", "Beatrix");
const ODD = agent("Bea", "Someone");
const LIST = [ADA, ADAM, BEA, BEATRIX];

describe("findAgent", () => {
  it.each([
    ["an id", LIST, "b2", { agent: BEATRIX }],
    ["a name, ignoring case", LIST, "bEA", { agent: BEA }],
    ["a name before a longer one it starts", LIST, "ada", { agent: ADA }],
    ["a unique start of a name", LIST, "beat", { agent: BEATRIX }],
    ["a unique start, ignoring case", LIST, "ADAM", { agent: ADAM }],
    ["an id before a name", [...LIST, ODD], "Bea", { agent: ODD }],
    [
      "the text without the spaces around it",
      LIST,
      "  b2 ",
      { agent: BEATRIX },
    ],
  ] as const)("finds by %s", (_how, agents, text, expected) => {
    expect(findAgent(agents, text)).toEqual(expected);
  });

  it("is ambiguous when a start fits several names", () => {
    const list = [ADA, BEA, BEATRIX, agent("c", "Bertha")];
    expect(findAgent(list, "be")).toEqual({
      ambiguous: [BEA, BEATRIX, agent("c", "Bertha")],
    });
  });

  it("is ambiguous when two agents have the same name", () => {
    const twin = agent("a9", "ada");
    expect(findAgent([ADA, twin, BEA], "Ada")).toEqual({
      ambiguous: [ADA, twin],
    });
  });

  it.each([
    ["nothing fits", "zed"],
    ["the text is empty", ""],
    ["the text is blank", "   "],
  ])("finds none when %s", (_why, text) => {
    expect(findAgent(LIST, text)).toEqual({ none: true });
  });
});
