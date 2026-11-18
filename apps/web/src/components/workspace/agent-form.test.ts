import { describe, expect, it } from "vitest";
import { agentDraft, agentFormSchema, agentNameProblem } from "./agent-form";

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

describe("an agent's runtime", () => {
  const form = (runtime: string) => ({
    name: "Demo",
    description: "",
    persona: "",
    runtime,
    model: "",
    thinkingLevel: "",
    machineId: "",
    plugins: [],
  });
  it("takes eta, the built-in runtimes, and any ACP agent the host names", () => {
    for (const runtime of [
      "eta",
      "claude",
      "codex",
      "opencode",
      "pi",
      "acp.demo",
      "acp.my-agent2",
    ])
      expect(agentFormSchema.safeParse(form(runtime)).success).toBe(true);
  });
  it("refuses what no runtime is called", () => {
    for (const runtime of [
      "",
      "gemini",
      "acp.",
      "acp.Demo",
      "acp.-x",
      "acp.a_b",
    ])
      expect(agentFormSchema.safeParse(form(runtime)).success).toBe(false);
  });
  it("sends an ACP runtime as it is, and no model as the runtime's own default", () => {
    expect(agentDraft(agentFormSchema.parse(form("acp.demo")))).toMatchObject({
      runtime: "acp.demo",
      model: null,
    });
  });
});
