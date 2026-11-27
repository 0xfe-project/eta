/**
 * The `omp` preset: oh-my-pi's 27 rules, loaded as stream rules.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { OMP_PRESET } from "../src/omp-preset.gen";
import { ompRule, ompRules, splitScope } from "../src/preset";
import { RuleSet } from "../src/rules";

const dir = join(import.meta.dirname, "..", "presets", "omp");

describe("the embedded preset", () => {
  it("is exactly the Markdown files next to it (run `bun run embed` after changing them)", () => {
    const files = readdirSync(dir)
      .filter((file) => file.endsWith(".md") && file !== "README.md")
      .map((file) => file.slice(0, -3))
      .sort();
    expect(Object.keys(OMP_PRESET)).toEqual(files);
    for (const name of files)
      expect(OMP_PRESET[name]).toBe(
        readFileSync(join(dir, `${name}.md`), "utf8"),
      );
  });

  it("has the 22 rules that still have a check, all kept as soft reminders", () => {
    const rules = ompRules();
    expect(rules).toHaveLength(22);
    expect(rules.every((rule) => rule.id.startsWith("omp/"))).toBe(true);
    expect(rules.every((rule) => rule.on === "stream")).toBe(true);
    expect(rules.every((rule) => rule.checks.length > 0)).toBe(true);
    expect(rules.every((rule) => rule.interrupt_mode === "never")).toBe(true);
  });

  it("leaves out the five rules that were built on astCondition", () => {
    const packed = new Set(ompRules().map((rule) => rule.id));
    for (const name of [
      "go-bench-loop",
      "go-new-expr",
      "go-range-int",
      "ts-no-inline-cast-access",
      "ts-redundant-clear-guard",
    ])
      expect(packed.has(`omp/${name}`)).toBe(false);
  });

  it("compiles: every condition, scope and pattern is valid", () => {
    const set = new RuleSet({
      root: "/project",
      rules: ompRules(),
      shellTools: {},
      files: [],
    });
    expect(set.streamRules).toHaveLength(22);
  });

  it("reads a rule's condition, scope, language and body", () => {
    const rule = ompRule("rs-box-leak", OMP_PRESET["rs-box-leak"]!);
    expect(rule).toMatchObject({
      id: "omp/rs-box-leak",
      scope: ["tool:edit(*.rs)", "tool:write(*.rs)"],
      checks: [{ regex: "Box::leak" }],
    });
    expect(rule.message).toMatch(/^Never use `Box::leak`/);
  });

  it("rejects a rule with no frontmatter or no checks", () => {
    expect(() => ompRule("x", "no frontmatter")).toThrow(/frontmatter/);
    expect(() => ompRule("x", "---\nscope: text\n---\nbody")).toThrow(
      /no checks/,
    );
  });
});

describe("scope strings", () => {
  it("split at commas outside braces and parentheses", () => {
    expect(
      splitScope("tool:edit(*.{ts,tsx}), tool:write(*.{ts,tsx}), text"),
    ).toEqual(["tool:edit(*.{ts,tsx})", "tool:write(*.{ts,tsx})", "text"]);
    expect(splitScope("")).toEqual([]);
  });
});
