/**
 * What a plugin's `config` may declare and what values fit it. The host and the web client import
 * this one module, so what passes here passes in both; the web's form has a test of its own that
 * it shows these same answers.
 */
import { describe, expect, it } from "vitest";
import {
  agentLevel,
  agentLevels,
  configIssues,
  fieldIssue,
  parseConfigFields,
  PLUGIN_FIELD_LIMITS,
} from "../src/plugin-fields";

const field = (spec: Record<string, unknown>) => {
  const { fields, problems } = parseConfigFields({ f: spec });
  expect(problems).toEqual([]);
  return fields[0]!;
};

const problemsOf = (spec: Record<string, unknown>): string =>
  parseConfigFields({ f: spec }).problems.join("\n");

describe("what a config may declare", () => {
  it("keeps the declared order and the defaults of a level", () => {
    const { fields } = parseConfigFields({
      b: { type: "string", title: "B", secret: true },
      a: { type: "number" },
    });
    expect(fields.map((entry) => entry.name)).toEqual(["b", "a"]);
    expect(fields[0]).toMatchObject({ title: "B", agent: "none" });
    expect(fields[1]).toMatchObject({ title: "a", agent: "read" });
  });

  it("has no fields and no problems when there is no config", () => {
    expect(parseConfigFields(undefined)).toEqual({ fields: [], problems: [] });
  });

  it("makes the whole config invalid on an unknown key", () => {
    const { fields, problems } = parseConfigFields({
      good: { type: "string" },
      bad: { type: "string", placeholder: "x" },
    });
    expect(fields).toEqual([]);
    expect(problems[0]).toContain("unknown key placeholder");
  });

  it("refuses a key of another type", () => {
    expect(problemsOf({ type: "boolean", pattern: "x" })).toContain(
      "unknown key pattern",
    );
    expect(problemsOf({ type: "string", int: true })).toContain(
      "unknown key int",
    );
  });

  it("refuses an unknown type, a bad field name and too many fields", () => {
    expect(problemsOf({ type: "directory" })).toContain("unknown type");
    expect(
      parseConfigFields({ "not valid": { type: "string" } }).problems[0],
    ).toContain("not a valid field name");
    expect(parseConfigFields([]).problems).toEqual([
      "config must be an object",
    ]);
    const many = Object.fromEntries(
      Array.from({ length: PLUGIN_FIELD_LIMITS.fields + 1 }, (_, index) => [
        `f${index}`,
        { type: "boolean" },
      ]),
    );
    expect(parseConfigFields(many).problems[0]).toContain("more than");
  });

  it("allows secret only on a string, and with no default", () => {
    expect(problemsOf({ type: "number", secret: true })).toContain(
      "secret is only for a string",
    );
    expect(problemsOf({ type: "select", secret: true, options: [] })).toContain(
      "secret is only for a string",
    );
    expect(
      problemsOf({ type: "string", secret: true, default: "x" }),
    ).toContain("cannot have a default");
  });

  it("ties a level to the kind of field", () => {
    expect(problemsOf({ type: "string", agent: "file" })).toContain(
      "agent must be one of none, read",
    );
    expect(problemsOf({ type: "string", agent: "value" })).toContain(
      "agent must be one of none, read",
    );
    expect(
      problemsOf({ type: "string", secret: true, agent: "read" }),
    ).toContain("agent must be one of none, file, value");
    expect(problemsOf({ type: "string", agent: "everything" })).toContain(
      "agent must be one of",
    );
  });

  it("refuses bounds that contradict each other", () => {
    expect(problemsOf({ type: "number", min: 2, max: 1 })).toContain(
      "min is greater than max",
    );
    expect(
      problemsOf({ type: "string", minLength: 2, maxLength: 1 }),
    ).toContain("minLength is greater than maxLength");
    expect(problemsOf({ type: "string", minLength: -1 })).toContain(
      "whole number",
    );
  });

  it("refuses a default that does not fit its own field", () => {
    expect(problemsOf({ type: "number", int: true, default: 1.5 })).toContain(
      "default does not fit: int",
    );
    expect(
      problemsOf({
        type: "select",
        options: [{ value: "a", label: "A" }],
        default: "b",
      }),
    ).toContain("default does not fit: option");
  });

  it("checks a select's options", () => {
    expect(problemsOf({ type: "select" })).toContain("options must be a list");
    expect(problemsOf({ type: "select", options: [{ value: "a" }] })).toContain(
      "{ value, label }",
    );
    expect(
      problemsOf({
        type: "select",
        options: [
          { value: "a", label: "A" },
          { value: "a", label: "B" },
        ],
      }),
    ).toContain("listed twice");
    expect(
      problemsOf({
        type: "select",
        minItems: 1,
        options: [{ value: "a", label: "A" }],
      }),
    ).toContain("need multiple");
  });

  it("refuses a pattern RE2 cannot run, or one too long to accept", () => {
    expect(problemsOf({ type: "string", pattern: "(?=a)b" })).toContain(
      "pattern is not a regular expression RE2 can run",
    );
    expect(problemsOf({ type: "string", pattern: "(a)\\1" })).toContain(
      "pattern is not a regular expression RE2 can run",
    );
    expect(problemsOf({ type: "string", pattern: "[" })).toContain(
      "pattern is not",
    );
    expect(
      problemsOf({
        type: "string",
        pattern: "a".repeat(PLUGIN_FIELD_LIMITS.patternLength + 1),
      }),
    ).toContain("pattern is longer");
  });
});

describe("what a value may be", () => {
  it("wants a required field filled, and its empty forms do not count", () => {
    const required = field({ type: "string", required: true });
    expect(fieldIssue(required, undefined)?.code).toBe("required");
    expect(fieldIssue(required, null)?.code).toBe("required");
    expect(fieldIssue(required, "")?.code).toBe("required");
    expect(fieldIssue(required, "x")).toBeUndefined();
    const list = field({
      type: "select",
      required: true,
      multiple: true,
      options: [{ value: "a", label: "A" }],
    });
    expect(fieldIssue(list, [])?.code).toBe("required");
  });

  it("takes false for an answer, and a default for a value", () => {
    const flag = field({ type: "boolean", required: true });
    expect(fieldIssue(flag, false)).toBeUndefined();
    const withDefault = field({ type: "string", required: true, default: "d" });
    expect(fieldIssue(withDefault, undefined)).toBeUndefined();
  });

  it("leaves an optional field alone when it is empty", () => {
    const optional = field({ type: "string", pattern: "^x$", minLength: 3 });
    expect(fieldIssue(optional, "")).toBeUndefined();
    expect(fieldIssue(optional, undefined)).toBeUndefined();
  });

  it("checks a string's pattern and length", () => {
    const key = field({
      type: "string",
      pattern: "^sk-[A-Za-z0-9]{8,}$",
      minLength: 11,
      maxLength: 20,
    });
    expect(fieldIssue(key, "sk-abcdefgh")).toBeUndefined();
    expect(fieldIssue(key, "sk-abc")).toEqual({
      field: "f",
      code: "minLength",
      limit: 11,
    });
    expect(fieldIssue(key, `sk-${"a".repeat(30)}`)).toEqual({
      field: "f",
      code: "maxLength",
      limit: 20,
    });
    expect(fieldIssue(key, "xx-abcdefgh")?.code).toBe("pattern");
    expect(fieldIssue(key, 5)?.code).toBe("type");
  });

  it("does not take the regular expression's time from its input", () => {
    const evil = field({ type: "string", pattern: "^(a+)+$" });
    const started = performance.now();
    const issue = fieldIssue(
      evil,
      `${"a".repeat(PLUGIN_FIELD_LIMITS.valueLength - 1)}!`,
    );
    expect(issue?.code).toBe("pattern");
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it("caps every string, whatever the manifest says", () => {
    const long = field({ type: "string", maxLength: 10_000_000 });
    expect(
      fieldIssue(long, "a".repeat(PLUGIN_FIELD_LIMITS.valueLength + 1)),
    ).toEqual({
      field: "f",
      code: "maxLength",
      limit: PLUGIN_FIELD_LIMITS.valueLength,
    });
  });

  it("checks a number's range, whole numbers, and that it is one", () => {
    const count = field({ type: "number", int: true, min: 1, max: 10 });
    expect(fieldIssue(count, 4)).toBeUndefined();
    expect(fieldIssue(count, 2.5)?.code).toBe("int");
    expect(fieldIssue(count, 0)).toEqual({ field: "f", code: "min", limit: 1 });
    expect(fieldIssue(count, 11)).toEqual({
      field: "f",
      code: "max",
      limit: 10,
    });
    expect(fieldIssue(count, "4")?.code).toBe("type");
    expect(fieldIssue(count, Number.NaN)?.code).toBe("type");
    expect(fieldIssue(field({ type: "number" }), 2.5)).toBeUndefined();
  });

  it("checks a boolean is one", () => {
    expect(fieldIssue(field({ type: "boolean" }), "yes")?.code).toBe("type");
  });

  it("takes one option, or a list of them under multiple", () => {
    const options = [
      { value: "a", label: "A" },
      { value: "b", label: "B" },
      { value: "c", label: "C" },
    ];
    const one = field({ type: "select", options });
    expect(fieldIssue(one, "a")).toBeUndefined();
    expect(fieldIssue(one, "z")?.code).toBe("option");
    expect(fieldIssue(one, ["a"])?.code).toBe("type");
    const many = field({
      type: "select",
      options,
      multiple: true,
      minItems: 2,
      maxItems: 2,
    });
    expect(fieldIssue(many, ["a", "b"])).toBeUndefined();
    expect(fieldIssue(many, "a")?.code).toBe("type");
    expect(fieldIssue(many, ["a"])).toEqual({
      field: "f",
      code: "minItems",
      limit: 2,
    });
    expect(fieldIssue(many, ["a", "b", "c"])).toEqual({
      field: "f",
      code: "maxItems",
      limit: 2,
    });
    expect(fieldIssue(many, ["a", "a"])?.code).toBe("type");
    expect(fieldIssue(many, ["a", "z"])?.code).toBe("option");
  });
});

describe("a set of values", () => {
  it("is every field's complaint, and ignores what the fields do not name", () => {
    const { fields } = parseConfigFields({
      key: { type: "string", required: true },
      count: { type: "number", max: 5 },
    });
    expect(configIssues(fields, { count: 9, gone: "old" })).toEqual([
      { field: "key", code: "required" },
      { field: "count", code: "max", limit: 5 },
    ]);
    expect(configIssues(fields, { key: "x", count: 1 })).toEqual([]);
  });
});

describe("levels", () => {
  const secret = (agent: string) =>
    field({ type: "string", secret: true, agent });

  it("offers what the kind allows, up to what was declared", () => {
    expect(agentLevels(secret("value"))).toEqual(["none", "file", "value"]);
    expect(agentLevels(secret("file"))).toEqual(["none", "file"]);
    expect(agentLevels(secret("none"))).toEqual(["none"]);
    expect(agentLevels(field({ type: "string" }))).toEqual(["none", "read"]);
  });

  it("follows the manifest until the user chooses, and never goes above it", () => {
    expect(agentLevel(secret("value"), undefined)).toBe("value");
    expect(agentLevel(secret("value"), "file")).toBe("file");
    expect(agentLevel(secret("file"), "value")).toBe("none");
    expect(agentLevel(field({ type: "string" }), "file")).toBe("none");
  });
});
