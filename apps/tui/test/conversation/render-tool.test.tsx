/**
 * How a tool call is drawn: the title by the shape of the call, the body under it, how a long body
 * folds to `previewLines`, and what copying the call gives.
 */
import type {
  RenderedItem,
  RenderOptions,
  TranscriptItem,
} from "../../src/ext/conversation/contract";
import type { ToolBlock } from "../../src/ext/conversation/model/run";
import process from "node:process";
import { stripVTControlCharacters } from "node:util";
import stringWidth from "string-width";
import { describe, expect, it, vi } from "vitest";
import { renderItem } from "../../src/ext/conversation/render";
import { testConfig } from "../ui-support/config";

vi.hoisted(() => {
  // chalk picks its colour level when it is first imported; without this the lines carry no SGR.
  globalThis.process.env.FORCE_COLOR = "1";
});

const RED = "\u001B[31m";
const GREEN = "\u001B[32m";
const GRAY = "\u001B[90m";
const ESC = String.fromCharCode(27);
const MAGENTA = `${ESC}[35m`;

function options(overrides: Partial<RenderOptions> = {}): RenderOptions {
  return {
    width: 80,
    previewLines: 3,
    expanded: false,
    theme: testConfig().theme,
    locale: "en",
    ...overrides,
  };
}

function block(input: unknown, extra: Partial<ToolBlock> = {}): ToolBlock {
  return {
    type: "tool",
    id: "call-1",
    name: "bash",
    input,
    status: "completed",
    ...extra,
  };
}

function toolItem(
  tool: ToolBlock,
  progress: string | undefined = undefined,
): TranscriptItem {
  return { kind: "tool", key: "k", tool, progress };
}

function draw(
  item: TranscriptItem,
  overrides: Partial<RenderOptions> = {},
): RenderedItem {
  const width = overrides.width ?? 80;
  const drawn = renderItem(item, options(overrides));
  expect(drawn.plain).toHaveLength(drawn.lines.length);
  drawn.lines.forEach((line, index) =>
    expect(stripVTControlCharacters(line)).toBe(drawn.plain[index]),
  );
  for (const line of drawn.plain) {
    expect(
      stringWidth(line),
      `too wide at ${width}: ${JSON.stringify(line)}`,
    ).toBeLessThanOrEqual(width);
    expect(line).toBe(line.trimEnd());
  }
  expect(drawn.plain[0]).not.toBe("");
  expect(drawn.plain.at(-1)).not.toBe("");
  return drawn;
}

const numbered = (count: number, from = 1) =>
  Array.from({ length: count }, (_, i) => `out ${i + from}`).join("\n");

describe("command", () => {
  it("titles a finished command with a check and shows its output indented", () => {
    const drawn = draw(
      toolItem(block({ command: "ls -la" }, { output: "a.txt\nb.txt" })),
    );
    expect(drawn.plain).toEqual(["✓ $ ls -la", "  a.txt", "  b.txt"]);
    expect(drawn.lines[0]).toContain(GREEN);
    expect(drawn.foldable).toBe(false);
    expect(drawn.source).toBe("ls -la\na.txt\nb.txt");
  });

  it("shows the first line of a multi-line command, marked as cut", () => {
    const drawn = draw(
      toolItem(block({ command: "cd x\nmake all" }, { output: "" })),
    );
    expect(drawn.plain).toEqual(["✓ $ cd x …"]);
    expect(drawn.source).toBe("cd x\nmake all\n");
  });

  it("adds a non-zero exit code to the title, in the error colour", () => {
    const drawn = draw(
      toolItem(
        block(
          { command: "false" },
          { status: "failed", output: "nope", details: { exitCode: 2 } },
        ),
      ),
    );
    expect(drawn.plain).toEqual(["✗ $ false (exit 2)", "  nope"]);
    expect(drawn.lines[0]).toContain(RED);
  });

  it("does not add an exit code of 0 or one that is not a number", () => {
    expect(
      draw(
        toolItem(
          block({ command: "true" }, { output: "", details: { exitCode: 0 } }),
        ),
      ).plain,
    ).toEqual(["✓ $ true"]);
    expect(
      draw(
        toolItem(
          block(
            { command: "true" },
            { output: "", details: { exitCode: null } },
          ),
        ),
      ).plain,
    ).toEqual(["✓ $ true"]);
  });

  it("shows what a running command has printed so far, with the running mark", () => {
    const drawn = draw(
      toolItem(
        block({ command: "build" }, { status: "running", output: "stale" }),
        "compiling\nlinking",
      ),
    );
    expect(drawn.plain).toEqual(["… $ build", "  compiling", "  linking"]);
    expect(drawn.source).toBe("build\ncompiling\nlinking");
  });

  it("strips terminal colours from the output", () => {
    const drawn = draw(
      toolItem(
        block({ command: "x" }, { output: "\u001B[31mred\u001B[0m plain" }),
      ),
    );
    expect(drawn.plain).toEqual(["✓ $ x", "  red plain"]);
    expect(drawn.source).toBe("x\nred plain");
  });

  it("folds a long finished output to its first previewLines lines and counts the rest", () => {
    const drawn = draw(
      toolItem(block({ command: "seq" }, { output: numbered(10) })),
    );
    expect(drawn.plain).toEqual([
      "✓ $ seq",
      "  out 1",
      "  out 2",
      "  out 3",
      "  … 7 more lines",
    ]);
    expect(drawn.lines[4]).toContain(GRAY);
    expect(drawn.foldable).toBe(true);
    expect(drawn.source).toBe(`seq\n${numbered(10)}`);
  });

  it("folds a running command to its last lines, the newest output", () => {
    const drawn = draw(
      toolItem(block({ command: "tail" }, { status: "running" }), numbered(10)),
    );
    expect(drawn.plain).toEqual([
      "… $ tail",
      "  … 7 more lines",
      "  out 8",
      "  out 9",
      "  out 10",
    ]);
    expect(drawn.foldable).toBe(true);
  });

  it("shows the whole output when unfolded, and still says it folds", () => {
    const drawn = draw(
      toolItem(block({ command: "seq" }, { output: numbered(10) })),
      { expanded: true },
    );
    expect(drawn.plain).toEqual([
      "✓ $ seq",
      ...numbered(10)
        .split("\n")
        .map((line) => `  ${line}`),
    ]);
    expect(drawn.foldable).toBe(true);
  });

  it("does not fold an output of exactly previewLines lines", () => {
    const drawn = draw(
      toolItem(block({ command: "seq" }, { output: numbered(3) })),
    );
    expect(drawn.plain).toHaveLength(4);
    expect(drawn.foldable).toBe(false);
  });

  it("names where the whole output went when the host cut it", () => {
    const drawn = draw(
      toolItem(
        block(
          { command: "big" },
          {
            output: "head",
            details: {
              truncation: { truncated: true },
              fullOutputPath: "/tmp/out.txt",
            },
          },
        ),
      ),
    );
    expect(drawn.plain).toEqual([
      "✓ $ big",
      "  head",
      "  full output: /tmp/out.txt",
    ]);
    expect(drawn.lines[2]).toContain(GRAY);
  });

  it("speaks Chinese under zh", () => {
    const drawn = draw(
      toolItem(
        block(
          { command: "seq" },
          {
            output: numbered(5),
            details: { fullOutputPath: "/tmp/o" },
          },
        ),
      ),
      { locale: "zh" },
    );
    expect(drawn.plain.slice(-2)).toEqual([
      "  … 还有 2 行",
      "  完整输出：/tmp/o",
    ]);
  });

  it("keeps a long command and long output lines within 20 and 40 columns", () => {
    for (const width of [20, 40]) {
      const drawn = draw(
        toolItem(
          block(
            {
              command:
                "grep -rn something /a/very/long/path/that/does/not/break/anywhere/at/all",
            },
            {
              output:
                "/a/very/long/path/that/does/not/break/anywhere/at/all/file.ts:12: 中文输出也要折行才行",
            },
          ),
        ),
        { width, expanded: true },
      );
      expect(drawn.plain.length).toBeGreaterThan(2);
    }
  });
});

describe("patch", () => {
  const edit = block(
    {
      file_path: "src/a.ts",
      old_string: "const a = 1;\nconst b = 2;",
      new_string: "const a = 1;\nconst b = 3;\nconst c = 4;",
    },
    { name: "Edit" },
  );

  it("titles the file with what it adds and removes and draws the diff with line numbers", () => {
    const drawn = draw(toolItem(edit), { expanded: true });
    expect(drawn.plain[0]).toBe("✓ ± src/a.ts +2 −1");
    const body = drawn.plain.slice(1);
    expect(body).toContain("  1   const a = 1;");
    expect(body).toContain("  2 - const b = 2;");
    expect(body).toContain("  2 + const b = 3;");
    expect(body).toContain("  3 + const c = 4;");
    const removed = drawn.lines[drawn.plain.indexOf("  2 - const b = 2;")];
    const added = drawn.lines[drawn.plain.indexOf("  2 + const b = 3;")];
    expect(removed).toContain(RED);
    expect(added).toContain(GREEN);
  });

  it("copies the diff as written", () => {
    const drawn = draw(toolItem(edit));
    expect(drawn.source).toContain("@@ -1,2 +1,3 @@");
    expect(drawn.source).toContain("-const b = 2;");
    expect(drawn.source).toContain("+const c = 4;");
  });

  it("folds a long diff", () => {
    const drawn = draw(toolItem(edit));
    expect(drawn.plain).toHaveLength(1 + 3 + 1);
    // Four lines of diff, three shown.
    expect(drawn.plain.at(-1)).toBe("  … 1 more line");
    expect(drawn.foldable).toBe(true);
  });

  it("titles every file of a change to several files", () => {
    const drawn = draw(
      toolItem(
        block(
          {
            changes: [
              {
                path: "one.ts",
                kind: "update",
                diff: "@@ -1 +1 @@\n-x\n+y",
              },
              {
                path: "two.ts",
                kind: "add",
                diff: "@@ -0,0 +1,2 @@\n+new\n+lines",
              },
            ],
          },
          { name: "fileChange" },
        ),
      ),
      { expanded: true },
    );
    expect(drawn.plain[0]).toBe("✓ ± one.ts +1 −1");
    expect(drawn.plain).toContain("  ± two.ts +2 −0");
    expect(drawn.plain).toContain("  1 - x");
    expect(drawn.plain).toContain("  1 + y");
    expect(drawn.plain).toContain("  2 + lines");
    expect(drawn.plain.indexOf("  ± two.ts +2 −0")).toBeGreaterThan(
      drawn.plain.indexOf("  1 + y"),
    );
    expect(drawn.source).toBe(
      "@@ -1 +1 @@\n-x\n+y\n@@ -0,0 +1,2 @@\n+new\n+lines",
    );
  });

  it("shows the output of a failed edit in the error colour", () => {
    const drawn = draw(
      toolItem({
        ...edit,
        status: "failed",
        output: "old_string not found",
      }),
    );
    expect(drawn.plain[0]?.startsWith("✗ ± src/a.ts")).toBe(true);
    const line = drawn.plain.indexOf("  old_string not found");
    expect(line).toBeGreaterThan(0);
    expect(drawn.lines[line]).toContain(RED);
  });
});

describe("write", () => {
  const write = block(
    {
      file_path: "src/new.ts",
      content: 'const x = "hi";\n// note\nexport { x };\n',
    },
    { name: "Write" },
  );

  it("titles the file with its line count and shows the content highlighted", () => {
    const drawn = draw(toolItem(write), { expanded: true });
    expect(drawn.plain).toEqual([
      "✓ ✎ src/new.ts · 3 lines",
      '  const x = "hi";',
      "  // note",
      "  export { x };",
    ]);
    // A keyword and a string get colours of their own.
    expect(drawn.lines[1]).toContain(`${MAGENTA}const`);
    expect(drawn.lines[1]).toContain(`${GREEN}"hi"`);
    expect(drawn.source).toBe('const x = "hi";\n// note\nexport { x };\n');
  });
});

describe("plan", () => {
  it("draws each step with a box saying how far it is", () => {
    const drawn = draw(
      toolItem(
        block(
          {
            todos: [
              { content: "read", status: "completed" },
              { content: "write", status: "in_progress" },
              { content: "test", status: "pending" },
            ],
          },
          { name: "TodoWrite" },
        ),
      ),
    );
    expect(drawn.plain).toEqual([
      "✓ ☰ Plan",
      "  [x] read",
      "  [~] write",
      "  [ ] test",
    ]);
    expect(drawn.source).toBe("read\nwrite\ntest");
    expect(drawn.foldable).toBe(false);
  });

  it("is titled in Chinese under zh", () => {
    const drawn = draw(
      toolItem(
        block(
          { todos: [{ content: "a", status: "pending" }] },
          {
            name: "TodoWrite",
          },
        ),
      ),
      { locale: "zh" },
    );
    expect(drawn.plain[0]).toBe("✓ ☰ 计划");
  });
});

describe("other", () => {
  it("titles the call with its name and the value that says most, and shows its output", () => {
    const drawn = draw(
      toolItem(
        block(
          { pattern: "unique key", path: "src" },
          { name: "grep", output: "src/a.ts:1" },
        ),
      ),
    );
    expect(drawn.plain).toEqual(["✓ grep src", "  src/a.ts:1"]);
    expect(drawn.source).toBe(
      `grep\n${JSON.stringify({ pattern: "unique key", path: "src" }, null, 2)}\nsrc/a.ts:1`,
    );
  });

  it("lists the pictures a result carried, with the path the call named", () => {
    const drawn = draw(
      toolItem(
        block(
          { file_path: "shot.png" },
          {
            name: "Read",
            output: "",
            images: [
              {
                mimeType: "image/png",
                data: "",
                bytes: 3 * 1024 * 1024,
                entryId: "e",
                index: 0,
              },
            ],
          },
        ),
      ),
    );
    expect(drawn.plain).toEqual([
      "✓ Read shot.png",
      "  [image] image/png · 3 MB · shot.png",
    ]);
  });

  it("titles a call with no arguments by its name alone", () => {
    expect(
      draw(toolItem(block({}, { name: "ping", output: "pong" }))).plain,
    ).toEqual(["✓ ping", "  pong"]);
  });
});

describe("long outputs, folded", () => {
  const lines = (count: number) =>
    Array.from({ length: count }, (_, i) => `line ${i + 1}`).join("\n");

  it("draws a folded card of 20 000 lines in tens of milliseconds", () => {
    const item = toolItem(block({ command: "big" }, { output: lines(20_000) }));
    draw(item); // the first draw also loads Ink's renderer
    const started = performance.now();
    const drawn = draw(item);
    const ms = performance.now() - started;
    expect(drawn.plain).toEqual([
      "✓ $ big",
      "  line 1",
      "  line 2",
      "  line 3",
      "  … 19997 more lines",
    ]);
    // Drawing every line took over a second and a half; 50 ms is the aim, the bound leaves room.
    expect(ms).toBeLessThan(250);
  });

  it("draws the last lines of a running command of 20 000 lines as fast", () => {
    const item = toolItem(
      block({ command: "big" }, { status: "running" }),
      lines(20_000),
    );
    draw(item);
    const started = performance.now();
    const drawn = draw(item);
    const ms = performance.now() - started;
    expect(drawn.plain).toEqual([
      "… $ big",
      "  … 19997 more lines",
      "  line 19998",
      "  line 19999",
      "  line 20000",
    ]);
    expect(ms).toBeLessThan(250);
  });

  it("counts the lines the output wraps to, not the lines it printed", () => {
    // 10 lines of 50 columns in a body 18 wide (20 less the mark): 3 rows each, 30 in all.
    const wide = Array.from({ length: 10 }, () => "x".repeat(50)).join("\n");
    const drawn = draw(toolItem(block({ command: "w" }, { output: wide })), {
      width: 20,
    });
    expect(drawn.plain.slice(1)).toEqual([
      `  ${"x".repeat(18)}`,
      `  ${"x".repeat(18)}`,
      `  ${"x".repeat(14)}`,
      "  … 27 more lines",
    ]);
  });

  it("counts wide characters as two columns when it counts the rows", () => {
    // 30 Chinese characters are 60 columns: 2 rows of a 38-column body each.
    const chinese = Array.from({ length: 4 }, () => "中".repeat(30)).join("\n");
    const drawn = draw(toolItem(block({ command: "c" }, { output: chinese })), {
      width: 40,
    });
    expect(drawn.plain.at(-1)).toBe("  … 5 more lines");
    expect(drawn.foldable).toBe(true);
  });

  it("drops blank lines at either end of the output before it counts", () => {
    const drawn = draw(
      toolItem(block({ command: "b" }, { output: `\n\n${lines(5)}\n  \n` })),
    );
    expect(drawn.plain).toEqual([
      "✓ $ b",
      "  line 1",
      "  line 2",
      "  line 3",
      "  … 2 more lines",
    ]);
  });
});

describe("what a program printed, as text", () => {
  const ESC_ = "\u001B";
  const BEL = "\u0007";
  const ST = `${ESC_}\\`;

  it("drops a sequence ended by ST without the words after it", () => {
    const output = `A${ESC_}]52;c;Zm9v${ST}B${ESC_}cC middle E${ESC_}]52;c;YmFy${BEL}F`;
    const drawn = draw(toolItem(block({ command: "x" }, { output })));
    expect(drawn.plain).toEqual(["✓ $ x", "  ABC middle EF"]);
    expect(drawn.source).toBe("x\nABC middle EF");
  });

  it("keeps a link's words and drops the link codes around them", () => {
    const output = `see ${ESC_}]8;;https://x.dev${ST}the docs${ESC_}]8;;${ST} now`;
    const drawn = draw(toolItem(block({ command: "x" }, { output })));
    expect(drawn.plain).toEqual(["✓ $ x", "  see the docs now"]);
  });

  it("drops C1 controls and the sequences they start, keeping the words", () => {
    const output = `F\u009B31mG\u009D0;title\u009CH\u0085I`;
    const drawn = draw(toolItem(block({ command: "x" }, { output })));
    expect(drawn.plain).toEqual(["✓ $ x", "  FGHI"]);
    expect(drawn.lines.join("")).not.toContain("\u001B[31m");
  });

  it("drops a sequence that is never ended, keeping the words after its opening", () => {
    const output = `ok ${ESC_}]0;half`;
    const drawn = draw(toolItem(block({ command: "x" }, { output })));
    expect(drawn.plain).toEqual(["✓ $ x", "  ok 0;half"]);
  });

  it("keeps the lines after a sequence that is never ended, past colour codes, up to a later BEL", () => {
    const output = `A${ESC_}]8;;http://x${ESC_}[31m red ${ESC_}[0m\nline2 important\nline3${BEL}B`;
    const drawn = draw(toolItem(block({ command: "x" }, { output })));
    expect(drawn.plain).toEqual([
      "✓ $ x",
      "  A8;;http://x red",
      "  line2 important",
      "  line3B",
    ]);
    expect(drawn.source).toBe("x\nA8;;http://x red \nline2 important\nline3B");
  });

  it("keeps the lines after a sequence that is never ended on its line, up to a later BEL", () => {
    const output = `A${ESC_}]8;;http://x\nline2\nline3${BEL}B`;
    const drawn = draw(toolItem(block({ command: "x" }, { output })));
    expect(drawn.plain).toEqual([
      "✓ $ x",
      "  A8;;http://x",
      "  line2",
      "  line3B",
    ]);
  });

  it("drops lone control characters from the lines and from what is copied", () => {
    const output = `a${BEL}b\u0008c\u0085d\u007Fe\u000Bf\u000Cg\u0000h`;
    const drawn = draw(toolItem(block({ command: "x" }, { output })));
    expect(drawn.plain).toEqual(["✓ $ x", "  abcdefgh"]);
    expect(drawn.source).toBe("x\nabcdefgh");
  });

  describe("built to be slow", () => {
    // 160 KB on one line. Linear work draws it in a few hundred milliseconds; work that grows with
    // the square of the length takes seconds already at 40 KB. CPU time rather than the clock, so
    // test files running alongside slow the count down little.
    const BOUND_MS = 1000;
    const n = 80_000;
    const timed = (output: string) => {
      draw(toolItem(block({ command: "x" }, { output: output.slice(0, 100) })));
      const before = process.cpuUsage();
      const drawn = draw(toolItem(block({ command: "x" }, { output })));
      const spent = process.cpuUsage(before);
      return { drawn, ms: (spent.user + spent.system) / 1000 };
    };

    it.each([
      ["DCS openers that never end", "\u0090a"],
      ["OSC openers that never end", "\u009Da"],
      ["ESC ] openers that never end", `${ESC_}]a`],
    ])("draws %s within the bound, keeping the words", (_name, unit) => {
      const { drawn, ms } = timed(unit.repeat(n));
      expect(ms).toBeLessThan(BOUND_MS);
      expect(drawn.source).toBe(`x\n${"a".repeat(n)}`);
    });
  });
});
