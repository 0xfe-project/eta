/**
 * The file `/agent` hands the editor: what it writes for an agent, and what it makes of the
 * file the user saved — the fields, every problem with the key it is about, and what changed.
 */
import type { AgentFields } from "../../src/ext/agent/agent-file";
import { describe, expect, it } from "vitest";
import { parseDocument } from "yaml";
import {
  changedFields,
  readAgentFile,
  writeAgentFile,
} from "../../src/ext/agent/agent-file";

const ADA: AgentFields = {
  name: "Ada",
  persona: "",
  runtime: "eta",
  model: "a:m1",
  thinkingLevel: "low",
  machineId: null,
  plugins: ["notes"],
  instructions: "Be brief.\nAnswer in English.",
};

/** ADA with one-line instructions, so that only the plugins take more than one line. */
const BASE: AgentFields = { ...ADA, instructions: "Be brief." };

/**
 * BASE's file with the lines of the given keys replaced, or removed when the value is "". A
 * replaced key's indented continuation lines (the plugins' `- name` items) go with it.
 */
function edited(lines: Record<string, string>): string {
  const out: string[] = [];
  let replacing = false;
  for (const line of writeAgentFile(BASE, []).split("\n")) {
    if (replacing && /^\s/.test(line)) continue;
    const key = line.split(":")[0] ?? "";
    replacing = key in lines;
    const next = replacing ? lines[key] : line;
    if (next !== undefined && next !== "") out.push(next);
  }
  return out.join("\n");
}

describe("writing the agent's file", () => {
  it("reads back as exactly the fields it was written from", () => {
    const awkward: AgentFields = {
      ...ADA,
      name: "null",
      persona: "",
      model: null,
      thinkingLevel: null,
      machineId: "m-1",
      plugins: [],
      instructions:
        "  leading spaces\nkey: value\n# not a comment\n\ntrailing\n",
    };
    expect(parseDocument(writeAgentFile(awkward, ["x"])).toJS()).toEqual(
      awkward,
    );
    expect(readAgentFile(writeAgentFile(awkward, ["x"]), awkward)).toEqual({
      fields: awkward,
    });
  });
});

describe("reading the saved file", () => {
  it("takes Windows line ends and a byte-order mark", () => {
    const text = `\uFEFF${writeAgentFile(ADA, ["guide"]).replaceAll("\n", "\r\n")}`;
    expect(readAgentFile(text, ADA)).toEqual({ fields: ADA });
  });

  it("leaves a key that was removed out of the fields", () => {
    const result = readAgentFile(edited({ thinkingLevel: "" }), BASE);
    expect(result).toEqual({
      fields: { ...BASE, thinkingLevel: undefined },
    });
    expect("fields" in result && "thinkingLevel" in result.fields).toBe(false);
  });

  it("names a key that appears twice, with where", () => {
    const result = readAgentFile("name: Ada\nruntime: eta\nname: Bea\n", BASE);
    expect(result).toEqual({
      problems: [{ kind: "duplicate-key", key: "name", line: 3, column: 1 }],
    });
  });

  it("refuses a file that is not a mapping", () => {
    expect(readAgentFile("- Ada\n", BASE)).toEqual({
      problems: [{ kind: "not-a-mapping" }],
    });
    expect(readAgentFile("# only comments\n", BASE)).toEqual({
      problems: [{ kind: "not-a-mapping" }],
    });
  });

  it("lists every invalid field, each with its key", () => {
    const result = readAgentFile(
      edited({
        name: 'name: ""',
        thinkingLevel: "thinkingLevel: hgh",
        model: "model: gpt4",
        runtime: "runtime: bash",
        persona: "persona: 3",
        machineId: "machineId: [a]",
        plugins: "plugins: notes",
        instructions: "colour: red",
      }),
      BASE,
    );
    expect(result).toEqual({
      problems: expect.arrayContaining([
        { kind: "blank-name" },
        { kind: "unknown-thinking-level", value: "hgh" },
        { kind: "model-format", value: "gpt4" },
        { kind: "unknown-runtime", value: "bash" },
        { kind: "wrong-type", key: "persona", expected: "text" },
        { kind: "wrong-type", key: "machineId", expected: "text-or-null" },
        { kind: "wrong-type", key: "plugins", expected: "list-of-text" },
        { kind: "unknown-key", key: "colour" },
      ]),
    });
    expect("problems" in result && result.problems).toHaveLength(8);
  });

  it("says when the name is missing", () => {
    expect(readAgentFile(edited({ name: "" }), BASE)).toEqual({
      problems: [{ kind: "missing-name" }],
    });
  });

  it("needs an external runtime's model to start with that runtime", () => {
    expect(
      readAgentFile(
        edited({ runtime: "runtime: claude", model: "model: a:m1" }),
        BASE,
      ),
    ).toEqual({
      problems: [{ kind: "model-runtime", value: "a:m1", runtime: "claude" }],
    });
    expect(
      readAgentFile(
        edited({ runtime: "runtime: claude", model: "model: claude:opus" }),
        BASE,
      ),
    ).toEqual({
      fields: { ...BASE, runtime: "claude", model: "claude:opus" },
    });
  });

  it("checks the model against the agent's runtime when the runtime key is gone", () => {
    const onClaude: AgentFields = {
      ...BASE,
      runtime: "claude",
      model: "claude:opus",
    };
    const text = writeAgentFile(onClaude, [])
      .split("\n")
      .filter((line) => !line.startsWith("runtime:"))
      .join("\n")
      .replace("model: claude:opus", "model: codex:x");
    expect(readAgentFile(text, onClaude)).toEqual({
      problems: [
        { kind: "model-runtime", value: "codex:x", runtime: "claude" },
      ],
    });
  });

  it("lets an eta agent name any provider's model, and null clear it", () => {
    expect(
      readAgentFile(edited({ model: "model: claude:opus" }), BASE),
    ).toEqual({
      fields: { ...BASE, model: "claude:opus" },
    });
    expect(
      readAgentFile(
        edited({
          model: "model: null",
          thinkingLevel: "thinkingLevel: null",
          machineId: "machineId: null",
        }),
        BASE,
      ),
    ).toEqual({
      fields: { ...BASE, model: null, thinkingLevel: null, machineId: null },
    });
  });
});

describe("what changed", () => {
  it("leaves out a key the file did not have", () => {
    const { model: _gone, ...rest } = ADA;
    expect(changedFields({ ...rest, name: "Bea" }, ADA)).toEqual({
      name: "Bea",
    });
  });

  it("counts null against a value as a change", () => {
    expect(changedFields({ ...ADA, model: null }, ADA)).toEqual({
      model: null,
    });
    expect(
      changedFields({ ...ADA, machineId: "m-1" }, { ...ADA, machineId: null }),
    ).toEqual({ machineId: "m-1" });
  });

  it("sends the model with a new runtime, so the host does not clear it", () => {
    const onClaude: AgentFields = {
      ...ADA,
      runtime: "claude",
      model: "claude:opus",
    };
    expect(changedFields({ ...onClaude, runtime: "eta" }, onClaude)).toEqual({
      runtime: "eta",
      model: "claude:opus",
    });
    expect(
      changedFields({ ...onClaude, runtime: "eta", model: null }, onClaude),
    ).toEqual({ runtime: "eta", model: null });
    expect(changedFields({ ...ADA, thinkingLevel: "high" }, ADA)).toEqual({
      thinkingLevel: "high",
    });
  });

  it("compares plugins as a set of names", () => {
    const two = { ...ADA, plugins: ["notes", "web"] };
    expect(changedFields({ ...two, plugins: ["web", "notes"] }, two)).toEqual(
      {},
    );
    expect(changedFields({ ...two, plugins: ["web"] }, two)).toEqual({
      plugins: ["web"],
    });
    expect(changedFields({ ...two, plugins: [] }, two)).toEqual({
      plugins: [],
    });
  });
});
