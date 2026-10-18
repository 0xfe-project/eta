/**
 * The cache discipline, checked where it is actually paid for: the request.
 *
 * A provider caches a prompt *prefix*. So what matters is not that the composer
 * puts the blocks in a nice order, but that the bytes a provider sees at the
 * front of the prompt are the same from one turn to the next while the volatile
 * parts change. This test drives a real run and compares the system prompt the
 * provider was handed on turn one with the one it was handed on turn two.
 */
import { Runner } from "@eta/core";
import { SessionLog } from "@eta/core/session";
import { MemoryStorage } from "@eta/core/storage";
import { assistantMessage, fakeModels } from "@eta/core/testing";
import { describe, expect, it } from "vitest";
import { DEFAULT_SYSTEM_PROMPT } from "../src/prompts";
import {
  composeEtaSystemPrompt,
  splitEtaPromptSections,
} from "../src/prompts/composer";
import { formatSkillsForSystemPrompt } from "../src/prompts/skills-block";
import { journaledKernel } from "../src/testing";

const userMsg = (text: string) => ({
  role: "user" as const,
  content: [{ type: "text" as const, text }],
  timestamp: 0,
});

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

  it("is what the provider is actually handed, turn after turn", async () => {
    const { kernel, journaling } = journaledKernel(
      SessionLog.create(new MemoryStorage()),
    );
    const fake = fakeModels([
      assistantMessage({ content: [{ type: "text", text: "first" }] }),
      assistantMessage({ content: [{ type: "text", text: "second" }] }),
    ]);
    // The deployment's resolver: stable blocks are fixed, memory is re-read every
    // generation (that is what a memory file is for).
    let memory =
      "<memory>\n- [1] decided: the composer goes in the harness\n</memory>";
    const runner = new Runner(kernel, {
      models: fake,
      systemPrompt: () =>
        composeEtaSystemPrompt(DEFAULT_SYSTEM_PROMPT, {
          persona: "PERSONA",
          skills: skillsBlock,
          platform: "<platform>paths</platform>",
          memory,
        }),
      journal: journaling,
    });

    kernel.inject(userMsg("first turn"));
    await runner.run();
    memory =
      "<memory>\n- [1] decided: the composer goes in the harness\n- [2] and the cache is the reason\n</memory>";
    kernel.inject(userMsg("second turn"));
    await runner.run();

    const prompts = fake.calls.map((call) => call.context.systemPrompt ?? "");
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).not.toBe(prompts[1]);
    // The same bytes at the front: the cacheable prefix survived the new note,
    // and the note that changed landed after it.
    const { stable } = splitEtaPromptSections(DEFAULT_SYSTEM_PROMPT, {
      persona: "PERSONA",
      skills: skillsBlock,
      platform: "<platform>paths</platform>",
    });
    const prefix = stable.join("\n\n");
    expect(prompts[0]!.startsWith(prefix)).toBe(true);
    expect(prompts[1]!.startsWith(prefix)).toBe(true);
    expect(prefix).toContain("PERSONA");
    expect(prefix).toContain("<available_skills>");
    expect(prefix).toContain("<platform>");
    expect(
      prompts[1]!.indexOf("[2] and the cache is the reason"),
    ).toBeGreaterThan(prefix.length);
  });
});
