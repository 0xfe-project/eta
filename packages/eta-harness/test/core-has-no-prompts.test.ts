/**
 * Core holds no model-visible words.
 *
 * This is a boundary, not a style rule: the kernel is the floor a session is
 * built on, and text a model reads is policy — what the agent says about itself,
 * what a persona is, what the goal rules are. Leaving it out of core is what
 * makes the harness (and a deployment) able to own it.
 *
 * The check is deliberately crude — read every source file in core and look for
 * the strings the harness ships — because it must fail loudly the day someone
 * pastes a prompt back in, not pass quietly because it did not know where to
 * look.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  builtinPersonas,
  DEFAULT_SYSTEM_PROMPT,
  STEP_REVIEW_PROMPT,
  STEP_UPDATE_SUCCESS,
} from "../src/prompts";

const CORE_SOURCE = join(import.meta.dirname, "..", "..", "eta-core", "src");

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await sourceFiles(path)));
    else if (entry.name.endsWith(".ts")) files.push(path);
  }
  return files;
}

describe("core", () => {
  it("contains no model-visible prompt text", async () => {
    const files = await sourceFiles(CORE_SOURCE);
    expect(files.length).toBeGreaterThan(20);
    const corpus = (
      await Promise.all(files.map((file) => readFile(file, "utf8")))
    ).join("\n");

    const markers: [string, string][] = [
      ["the base prompt", "You came here to help the person you're talking to"],
      [
        "the base prompt's tool guide",
        "Your tools — the ones a session has by default",
      ],
      ["the task review prompt", STEP_REVIEW_PROMPT.slice(0, 60)],
      ["the task update reply", STEP_UPDATE_SUCCESS],
      ["a builtin persona card", builtinPersonas().Executor.slice(0, 60)],
      ["the goal continuation", "[goal] keep going"],
      ["a system reminder", "<system-reminder>"],
    ];
    for (const [what, marker] of markers) {
      expect(corpus.includes(marker), `core must not contain ${what}`).toBe(
        false,
      );
    }
    // And the shipped texts really do hold those markers, so the check above is
    // testing something rather than passing because everything is empty.
    expect(DEFAULT_SYSTEM_PROMPT.length).toBeGreaterThan(500);
  });
});
