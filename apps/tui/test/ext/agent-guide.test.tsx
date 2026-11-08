/**
 * The comment lines at the top of the agent's file: how to apply it, what each key takes, and
 * what null means, in the interface language.
 */
import type { AgentChoices } from "../../src/ext/agent/guide";
import { describe, expect, it } from "vitest";
import { agentFileGuide, GUIDE_LIST_LIMIT } from "../../src/ext/agent/guide";

const CHOICES: AgentChoices = {
  models: ["a:m1", "a:m2"],
  runtimeModels: [{ runtime: "claude", models: ["claude:opus"] }],
  runtimeModelsError: undefined,
  machines: [{ id: "mach-1", name: "Laptop" }],
  plugins: [
    { name: "notes", needsConfig: false },
    { name: "mail", needsConfig: true },
  ],
  personas: [{ id: "coder", name: "Coder" }],
};

function guide(choices: AgentChoices, locale: "en" | "zh" = "en"): string {
  return agentFileGuide({ agentName: "Ada", choices, locale }).join("\n");
}

describe("the agent file's guide", () => {
  it("says that saving and closing the editor applies the file", () => {
    expect(guide(CHOICES)).toMatch(/save.*close.*apply/i);
    expect(guide(CHOICES, "zh")).toMatch(
      /保存[^\n\r\u2028\u2029\u5173]*\u5173.*应用/,
    );
  });

  it("lists the models, machines, plugins and personas to choose from", () => {
    const text = guide(CHOICES);
    for (const value of [
      "a:m1",
      "a:m2",
      "claude:opus",
      "mach-1",
      "Laptop",
      "notes",
      "mail",
      "coder",
    ])
      expect(text).toContain(value);
  });

  it("marks a plugin that needs configuring", () => {
    const line = agentFileGuide({
      agentName: "Ada",
      choices: CHOICES,
      locale: "en",
    }).find((l) => l.includes("mail"));
    expect(line).toMatch(/mail \(needs configuring\)/);
  });

  it("says what null means for the model, the thinking level and the machine", () => {
    const lines = agentFileGuide({
      agentName: "Ada",
      choices: CHOICES,
      locale: "en",
    });
    for (const key of ["model", "thinkingLevel", "machineId"])
      expect(
        lines.some((line) => line.includes(key) && line.includes("null")),
      ).toBe(true);
    expect(guide(CHOICES, "zh")).toMatch(/null/);
  });

  it("cuts a long list and says how many were left out", () => {
    const many = Array.from(
      { length: GUIDE_LIST_LIMIT + 3 },
      (_, i) => `p:m${i}`,
    );
    const en = guide({ ...CHOICES, models: many });
    expect(en).toContain(`p:m${GUIDE_LIST_LIMIT - 1}`);
    expect(en).not.toContain(`p:m${GUIDE_LIST_LIMIT},`);
    expect(en).not.toContain(`p:m${GUIDE_LIST_LIMIT + 2}`);
    expect(en).toMatch(/and 3 more/);
    expect(guide({ ...CHOICES, models: many }, "zh")).toMatch(/另有 3 项/);
  });

  it("names first where the user's version from before a conflict is kept", () => {
    for (const locale of ["en", "zh"] as const) {
      const lines = agentFileGuide({
        agentName: "Ada",
        choices: CHOICES,
        locale,
        savedEdit: "/tmp/eta-agent-a-1-yours.yaml",
      });
      expect(lines[0]).toContain("/tmp/eta-agent-a-1-yours.yaml");
    }
    expect(
      agentFileGuide({ agentName: "Ada", choices: CHOICES, locale: "en" }).join(
        "\n",
      ),
    ).not.toContain("yours");
  });

  it("says when a list is empty", () => {
    const text = guide({
      ...CHOICES,
      models: [],
      runtimeModels: [],
      machines: [],
      plugins: [],
      personas: [],
    });
    expect(text).toMatch(/none/i);
  });

  it("says why the external runtimes' models could not be listed", () => {
    const text = guide({
      ...CHOICES,
      runtimeModels: [],
      runtimeModelsError: "machine is offline",
    });
    expect(text).toContain("machine is offline");
  });

  it("writes no line that would end the comment", () => {
    for (const locale of ["en", "zh"] as const)
      for (const line of agentFileGuide({
        agentName: "Line\nbreak",
        choices: CHOICES,
        locale,
      }))
        expect(line).not.toContain("\n");
  });
});
