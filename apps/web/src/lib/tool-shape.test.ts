import type { ToolBlock } from "./run";
import { describe, expect, it } from "@rstest/core";
import {
  childrenOf,
  exitCodeOf,
  fullOutputOf,
  patchCounts,
  shapeOf,
  withoutAnsi,
} from "./tool-shape";

const block = (name: string, input: unknown, details?: unknown): ToolBlock => ({
  type: "tool",
  id: "c1",
  name,
  input,
  details,
  status: "completed",
});

describe("what a tool call was", () => {
  it("is a command when it ran one, whatever the runtime calls the tool", () => {
    expect(shapeOf(block("Bash", { command: "ls -la" }))).toEqual({
      kind: "command",
      command: "ls -la",
    });
    expect(shapeOf(block("commandExecution", { input: "git status" }))).toEqual(
      { kind: "command", command: "git status" },
    );
  });

  it("is the lines an edit changed, from Claude Code's Edit", () => {
    const shape = shapeOf(
      block("Edit", {
        file_path: "/a/b.ts",
        old_string: "const a = 1;\nconst b = 2;",
        new_string: "const a = 1;\nconst b = 3;",
      }),
    );
    expect(shape.kind).toBe("patch");
    if (shape.kind !== "patch") return;
    expect(shape.files[0]?.path).toBe("/a/b.ts");
    expect(shape.files[0]?.patch).toContain("-const b = 2;");
    expect(shape.files[0]?.patch).toContain("+const b = 3;");
    expect(shape.files[0]?.patch.startsWith("@@")).toBe(true);
    expect(patchCounts(shape.files)).toEqual({ added: 1, removed: 1 });
  });

  it("is the patch eta's own edit kept", () => {
    const patch = "--- a\n+++ b\n@@ -1 +1 @@\n-x\n+y\n+z";
    const shape = shapeOf(
      block(
        "edit",
        { path: "f", edits: [{ oldText: "x", newText: "y" }] },
        {
          patch,
        },
      ),
    );
    expect(shape).toEqual({ kind: "patch", files: [{ path: "f", patch }] });
    if (shape.kind === "patch")
      expect(patchCounts(shape.files)).toEqual({ added: 2, removed: 1 });
  });

  it("is each file a Codex change touched", () => {
    const changes = [
      { path: "new.ts", kind: { type: "add" }, diff: "+hello" },
      { path: "old.ts", kind: "update", diff: "@@ -1 +1 @@\n-a\n+b" },
    ];
    expect(
      shapeOf(block("fileChange", { input: JSON.stringify(changes) })),
    ).toEqual({
      kind: "patch",
      files: [
        { path: "new.ts", change: "add", patch: "+hello" },
        { path: "old.ts", change: "update", patch: "@@ -1 +1 @@\n-a\n+b" },
      ],
    });
  });

  it("is the file a write wrote", () => {
    expect(
      shapeOf(block("Write", { file_path: "x.md", content: "# hi" })),
    ).toEqual({ kind: "write", path: "x.md", content: "# hi" });
  });

  it("is a plan from a to-do list or a step tool's answer", () => {
    expect(
      shapeOf(
        block("TodoWrite", {
          todos: [
            { content: "read", status: "completed" },
            { content: "write", status: "in_progress" },
          ],
        }),
      ),
    ).toEqual({
      kind: "plan",
      items: [
        { content: "read", status: "completed" },
        { content: "write", status: "in_progress" },
      ],
    });
    expect(
      shapeOf(
        block(
          "update_step",
          { id: "t1", status: "completed" },
          {
            task: { id: "t1", content: "ship it", status: "completed" },
          },
        ),
      ),
    ).toEqual({
      kind: "plan",
      items: [{ content: "ship it", status: "completed" }],
    });
  });

  it("is nothing in particular otherwise", () => {
    expect(shapeOf(block("mcp__eta__reply", { body: "hi" }))).toEqual({
      kind: "other",
    });
    expect(shapeOf(block("x", "plain text"))).toEqual({ kind: "other" });
  });
});

describe("what a result says beyond its text", () => {
  it("reads the exit code, and where a cut output went", () => {
    expect(exitCodeOf(block("Bash", {}, { exitCode: 2 }))).toBe(2);
    expect(exitCodeOf(block("Bash", {}, { exitCode: null }))).toBeNull();
    expect(exitCodeOf(block("Bash", {}))).toBeUndefined();
    expect(
      fullOutputOf(
        block(
          "bash",
          {},
          {
            truncation: { truncated: true },
            fullOutputPath: "/tmp/out.txt",
          },
        ),
      ),
    ).toBe("/tmp/out.txt");
    expect(fullOutputOf(block("bash", {}, {}))).toBeUndefined();
  });

  it("keeps only the subagent steps it can draw", () => {
    expect(
      childrenOf(
        block(
          "Agent",
          {},
          {
            children: [
              { kind: "tool", id: "s1", name: "Read", status: "completed" },
              { kind: "text", text: "found it" },
              { kind: "tool", id: "s2" },
              "rubbish",
            ],
          },
        ),
      ),
    ).toEqual([
      { kind: "tool", id: "s1", name: "Read", status: "completed" },
      { kind: "text", text: "found it" },
    ]);
  });

  it("drops a terminal's colour codes", () => {
    expect(
      withoutAnsi("\u001B[31mred\u001B[0m and \u001B[1;32mgreen\u001B[m"),
    ).toBe("red and green");
  });
});
