/**
 * The cache discipline: the bytes at the front of the prompt.
 *
 * A provider caches a prompt *prefix*. So what matters is not that the composer
 * puts the blocks in a nice order, but that the bytes a provider sees at the
 * front of the prompt are the same from one turn to the next while the volatile
 * parts change. That the assembled session hands the provider this prefix turn
 * after turn is open-prompt.test.ts's "re-reads the adaptive blocks every
 * generation, and leaves the prefix alone".
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_SYSTEM_PROMPT } from "../src/prompts";
import {
  composeEtaSystemPrompt,
  splitEtaPromptSections,
} from "../src/prompts/composer";
import { formatSkillsForSystemPrompt } from "../src/prompts/skills-block";

const skillsBlock = formatSkillsForSystemPrompt([
  {
    name: "porting",
    description: "How to port a file faithfully",
    filePath: "/skills/porting/SKILL.md",
  },
]);

describe("the stable prefix", () => {
  it("is byte-identical while the volatile blocks change", () => {
    const stable = {
      persona: "PERSONA",
      skills: skillsBlock,
      platform: "<platform>paths</platform>",
    };
    const first = composeEtaSystemPrompt(DEFAULT_SYSTEM_PROMPT, {
      ...stable,
      goal: { objective: "port the harness", status: "active" },
      tasks: [{ id: "t1", content: "the composer", status: "pending" }],
      memory: "<memory>\n- [1] a decision\n</memory>",
    });
    const second = composeEtaSystemPrompt(DEFAULT_SYSTEM_PROMPT, {
      ...stable,
      goal: { objective: "port the harness", status: "active" },
      tasks: [
        { id: "t1", content: "the composer", status: "completed" },
        { id: "t2", content: "the tools", status: "in_progress" },
      ],
      memory: "<memory>\n- [1] a decision\n- [2] another\n</memory>",
    });
    expect(first).not.toBe(second);

    const { stable: stableParts } = splitEtaPromptSections(
      DEFAULT_SYSTEM_PROMPT,
      stable,
    );
    const prefix = stableParts.join("\n\n");
    expect(first.startsWith(prefix)).toBe(true);
    expect(second.startsWith(prefix)).toBe(true);
    // The volatile blocks never creep in front of the stable ones.
    expect(first.indexOf("Leave goal active if unfinished.")).toBeGreaterThan(
      prefix.length,
    );
    expect(second.indexOf("t2: the tools")).toBeGreaterThan(prefix.length);
  });
});
