/**
 * How what an agent said is drawn: its markdown, through the components taken from Gemini CLI.
 */
import type {
  RenderedItem,
  RenderOptions,
} from "../../src/ext/conversation/contract";
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

const CYAN = "\u001B[36m";
const BOLD = "\u001B[1m";
const ESC = String.fromCharCode(27);
const MAGENTA = `${ESC}[35m`;
const YELLOW = `${ESC}[33m`;

function markdown(
  text: string,
  overrides: Partial<RenderOptions> & { streaming?: boolean } = {},
): RenderedItem {
  const { streaming = false, ...rest } = overrides;
  const options: RenderOptions = {
    width: 80,
    previewLines: 3,
    expanded: false,
    theme: testConfig().theme,
    locale: "en",
    ...rest,
  };
  const drawn = renderItem(
    { kind: "text", key: "t", text, streaming },
    options,
  );
  expect(drawn.plain).toHaveLength(drawn.lines.length);
  drawn.lines.forEach((line, index) =>
    expect(stripVTControlCharacters(line)).toBe(drawn.plain[index]),
  );
  for (const line of drawn.plain) {
    expect(
      stringWidth(line),
      `too wide at ${options.width}: ${JSON.stringify(line)}`,
    ).toBeLessThanOrEqual(options.width);
    expect(line).toBe(line.trimEnd());
  }
  expect(drawn.plain[0]).not.toBe("");
  expect(drawn.plain.at(-1)).not.toBe("");
  return drawn;
}

describe("text", () => {
  it("copies the markdown as written and does not fold", () => {
    const text = "# Title\n\nSome **bold** words.";
    const drawn = markdown(text);
    expect(drawn.source).toBe(text);
    expect(drawn.foldable).toBe(false);
    expect(markdown(text, { expanded: true }).plain).toEqual(drawn.plain);
  });

  it("draws headings bold in the accent colour, without the hashes", () => {
    const drawn = markdown("# Top\n## Second\n### Third");
    expect(drawn.plain).toEqual(["Top", "Second", "Third"]);
    expect(drawn.lines[0]).toContain(BOLD);
    expect(drawn.lines[0]).toContain(CYAN);
  });

  it("keeps one blank line between paragraphs and none at either end", () => {
    expect(markdown("\n\nfirst\n\n\n\nsecond\n\n").plain).toEqual([
      "first",
      "",
      "second",
    ]);
  });

  it("draws bullet and numbered lists with their markers", () => {
    expect(
      markdown("- one\n- two\n  - nested\n1. first\n2. second").plain,
    ).toEqual([" - one", " - two", "   - nested", " 1. first", " 2. second"]);
  });

  it("wraps a list item under its text", () => {
    const drawn = markdown("- alpha beta gamma delta epsilon zeta eta", {
      width: 20,
    });
    expect(drawn.plain[0]?.startsWith(" - alpha")).toBe(true);
    for (const line of drawn.plain.slice(1))
      expect(line.startsWith("   ")).toBe(true);
  });

  it("draws bold, inline code and links without their markers", () => {
    const drawn = markdown(
      "Use **care** with `rm -rf` and read [the docs](https://example.com/docs).",
    );
    expect(drawn.plain).toEqual([
      "Use care with rm -rf and read the docs (https://example.com/docs).",
    ]);
    expect(drawn.lines[0]).toContain(`${BOLD}care`);
    expect(drawn.lines[0]).toContain(`${CYAN}rm -rf`);
    expect(drawn.lines[0]).toContain(`${CYAN}https://example.com/docs`);
  });

  it("draws a code block indented, highlighted by its language", () => {
    const drawn = markdown("```ts\nconst a = 1;\nreturn a;\n```\nafter");
    expect(drawn.plain).toEqual([" const a = 1;", " return a;", "after"]);
    expect(drawn.lines[0]).toContain(`${MAGENTA}const`);
    expect(drawn.lines[0]).toContain(`${YELLOW}1`);
  });

  it("draws a code block that is not closed yet, while the text streams", () => {
    const drawn = markdown("Here:\n```python\nprint('x')\nfor i in", {
      streaming: true,
    });
    expect(drawn.plain).toEqual(["Here:", " print('x')", " for i in"]);
    expect(drawn.lines.join("|")).toContain(`${CYAN}print`);
  });

  it("draws a table with borders, the header in the accent colour", () => {
    const drawn = markdown(
      "| Name | Size |\n|---|---|\n| a.txt | 12 |\n| 中文名 | 3 |",
    );
    expect(drawn.plain[0]).toMatch(/^┌─+┬─+┐$/);
    expect(drawn.plain[1]).toMatch(/^│ Name +│ Size +│$/);
    expect(drawn.plain[2]).toMatch(/^├─+┼─+┤$/);
    expect(drawn.plain[3]).toMatch(/^│ a\.txt +│ 12 +│$/);
    expect(drawn.plain[4]).toMatch(/^│ 中文名 +│ 3 +│$/);
    expect(drawn.plain[5]).toMatch(/^└─+┴─+┘$/);
    // Every row of a table is as wide as its border.
    const widths = new Set(drawn.plain.map((line) => stringWidth(line)));
    expect(widths.size).toBe(1);
    expect(drawn.lines[1]).toContain(CYAN);
  });

  it("wraps a table's cells to fit a narrow width", () => {
    const table = [
      "| Column one | Column two | Column three |",
      "|---|---|---|",
      "| some long words in here | 这里是比较长的中文单元格内容 | /a/long/path/to/somewhere.ts |",
    ].join("\n");
    // The width check runs inside `markdown` at every width. A column narrower than its longest
    // word breaks the word across lines, and the next column's lines sit between the halves, so
    // the words read whole only where the columns hold them.
    for (const width of [20, 40]) markdown(table, { width });
    const wide = markdown(table, { width: 80 }).plain.join("\n");
    for (const word of [
      "Column three",
      "words",
      "这里是比较长的中文单元格内容",
      "/a/long/path/to/somewhere.ts",
    ])
      expect(wide).toContain(word);
  });

  it("keeps a heading, a paragraph and a list of Chinese and long paths within 20 columns", () => {
    const drawn = markdown(
      [
        "# 一个很长很长的中文标题需要折行",
        "",
        "这是一段很长的中文段落，混着 English words 与 `inline code`，需要正确折行。",
        "",
        "- /home/someone/projects/eta/apps/tui/src/ext/conversation/render/index.ts",
        "",
        "```",
        "a-very-long-code-line-that-has-no-spaces-at-all-and-must-still-fit",
        "```",
      ].join("\n"),
      { width: 20 },
    );
    expect(drawn.plain.length).toBeGreaterThan(10);
  });

  it("draws a horizontal rule", () => {
    expect(markdown("above\n\n---\n\nbelow").plain).toEqual([
      "above",
      "",
      "---",
      "",
      "below",
    ]);
  });
});

describe("markdown built to be slow", () => {
  /** Draws `text` once to load the renderer, then again on the clock. */
  function timed(text: string, width = 80) {
    markdown(text.slice(0, 200), { width });
    const started = performance.now();
    const drawn = markdown(text, { width });
    return { drawn, ms: performance.now() - started };
  }

  // Each is 40 KB or so on one line; the bound is loose against a busy machine, the aim is far under.
  const BOUND_MS = 3000;
  const n = 20_000;
  const cases: [string, string][] = [
    ["link openers that never close", `${"[".repeat(n)}${"](".repeat(n)}`],
    ["underline tags that never close", "<u>a".repeat(n / 2)],
    ["emphasis openers", `${"*a".repeat(n)}`],
    ["underscores between words", "a_b ".repeat(n / 2)],
    ["backticks between words", "`a ".repeat(n / 2)],
    ["strikethrough openers", "~~a".repeat(n / 2)],
    ["links with nested brackets", "[a[b](c(d)".repeat(n / 8)],
  ];

  it.each(cases)("draws %s within the bound, losing nothing", (_name, text) => {
    const { drawn, ms } = timed(text);
    expect(ms).toBeLessThan(BOUND_MS);
    expect(drawn.plain.length).toBeGreaterThan(1);
  });

  /** Draws `text` once to load the renderer, then again, counting the CPU time this process spent. */
  function timedCpu(text: string) {
    markdown(text.slice(0, 200));
    const before = process.cpuUsage();
    const drawn = markdown(text);
    const spent = process.cpuUsage(before);
    return { drawn, ms: (spent.user + spent.system) / 1000 };
  }

  // 160 KB on one line, each drawn in about 200 ms. Work that grows with the square of the length
  // takes seconds already at 40 KB, and ten seconds and more here. CPU time rather than the clock,
  // so test files running alongside slow the count down little.
  const LONG_BOUND_MS = 1000;
  const long = 160_000;
  // Each with the line's last words, which a parse that gave up would not reach.
  const longCases: [string, string, string][] = [
    ["underline tags that never close", "<u>a".repeat(long / 4), "<u>a"],
    [
      "spaces before a letter, which a table separator never has",
      `x\n${" ".repeat(long)}a`,
      "a",
    ],
    [
      "a table separator followed by spaces and a letter",
      `| a |\n|-|-${" ".repeat(long)}x`,
      "x",
    ],
    [
      "a code fence followed by spaces and a sign",
      `${"`".repeat(3)}${" ".repeat(long)}!`,
      "!",
    ],
    [
      "a run of backticks that never closes, before words",
      `x ${"`".repeat(long)}a b`,
      "a b",
    ],
  ];

  it.each(longCases)(
    "draws 160 KB of %s within a second, to its end",
    (_name, text, end) => {
      const { drawn, ms } = timedCpu(text);
      expect(ms).toBeLessThan(LONG_BOUND_MS);
      expect(drawn.plain.join("\n").trimEnd().endsWith(end)).toBe(true);
    },
  );

  it("draws the 40 KB of link openers as the characters it was written with", () => {
    const text = `${"[".repeat(n)}${"](".repeat(n)}`;
    const { drawn } = timed(text);
    expect(drawn.plain.join("")).toBe(text);
  });
});

describe("lines that would not fit", () => {
  it("keeps a list nested deeper than the width within the width", () => {
    const nested = Array.from(
      { length: 50 },
      (_, i) => `${"  ".repeat(i)}- item ${i}`,
    ).join("\n");
    for (const width of [20, 40, 80]) {
      const drawn = markdown(nested, { width });
      // Every item's words are still there.
      expect(drawn.plain.join(" ")).toContain("item 49");
    }
  });

  it("keeps numbered lists nested fifteen deep within 40 columns", () => {
    const nested = Array.from(
      { length: 15 },
      (_, i) => `${"   ".repeat(i)}${i + 1}. step ${i + 1}`,
    ).join("\n");
    const drawn = markdown(nested, { width: 40 });
    expect(drawn.plain.join(" ")).toContain("step 15");
  });

  it("draws a line of nothing but backticks rather than nothing", () => {
    const fence = "`".repeat(40);
    const drawn = markdown(`before\n\n${fence}`, { width: 20 });
    expect(drawn.plain.join("")).toContain(fence);
  });

  it("draws a long line of backticks that the text ends on", () => {
    const fence = "`".repeat(2001);
    const drawn = markdown(fence, { width: 80 });
    expect(drawn.plain.join("")).toBe(fence);
  });
});
