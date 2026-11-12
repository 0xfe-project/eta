/**
 * The components taken from Gemini CLI, on official Ink 8: the parts the transcript does not reach
 * through one item at a time.
 */
import type { Palette } from "../src/ui/gemini/colors";
import { stripVTControlCharacters } from "node:util";
import { renderToString } from "ink";
import stringWidth from "string-width";
import { describe, expect, it, vi } from "vitest";
import { DiffRenderer } from "../src/ui/gemini/diff-renderer";
import { parseInlineMarkdown } from "../src/ui/gemini/markdown-parsing";
import { spansWidth, wrapSpans } from "../src/ui/gemini/styled-spans";
import { TableRenderer } from "../src/ui/gemini/table-renderer";

vi.hoisted(() => {
  // chalk picks its colour level when it is first imported; without this the lines carry no SGR.
  globalThis.process.env.FORCE_COLOR = "1";
});

const palette: Palette = {
  text: undefined,
  muted: "gray",
  accent: "cyan",
  border: "gray",
  success: "green",
  error: "red",
};

function plainLines(node: React.ReactNode, width: number): string[] {
  return stripVTControlCharacters(renderToString(node, { columns: width }))
    .split("\n")
    .map((line) => line.trimEnd());
}

describe("the diff renderer", () => {
  it("draws a gap between hunks that are far apart", () => {
    const lines = plainLines(
      <DiffRenderer
        diff={"@@ -1 +1 @@\n-a\n+b\n@@ -40 +40 @@\n-c\n+d"}
        width={30}
        palette={palette}
      />,
      30,
    );
    expect(lines).toEqual([
      " 1 - a",
      " 1 + b",
      "═".repeat(30),
      "40 - c",
      "40 + d",
    ]);
  });

  it("keeps long diff lines within the width", () => {
    const lines = plainLines(
      <DiffRenderer
        diff={`@@ -1 +1 @@\n-${"x".repeat(50)}\n+中文${"y".repeat(50)}`}
        width={20}
        palette={palette}
      />,
      20,
    );
    for (const line of lines) expect(stringWidth(line)).toBeLessThanOrEqual(20);
    expect(lines.length).toBeGreaterThan(4);
  });
});

describe("the table renderer", () => {
  it("lists the cells under their headers when the columns cannot fit", () => {
    const headers = ["One", "Two", "Three", "Four", "Five", "Six", "Seven"];
    const rows = [["a", "b", "c", "d", "e", "f", "中文"]];
    const lines = plainLines(
      <TableRenderer
        headers={headers}
        rows={rows}
        width={20}
        palette={palette}
      />,
      20,
    );
    for (const line of lines) expect(stringWidth(line)).toBeLessThanOrEqual(20);
    expect(lines).toContain("One: a");
    expect(lines).toContain("Seven: 中文");
  });
});

describe("inline markdown spans", () => {
  it("turns LaTeX commands into Unicode outside code", () => {
    const spans = parseInlineMarkdown(
      "$\\alpha \\to \\beta$ and `$\\alpha$`",
      undefined,
      palette,
    );
    const text = spans.map((span) => span.text).join("");
    expect(text).toContain("α → β");
    expect(text).toContain("$\\alpha$");
  });

  it("wraps spans at spaces, breaking a word only when it is wider than the line", () => {
    const spans = parseInlineMarkdown(
      "**bold** words and averyveryverylongword 中文中文中文",
      undefined,
      palette,
    );
    const lines = wrapSpans(spans, 8);
    for (const line of lines) expect(spansWidth(line)).toBeLessThanOrEqual(8);
    expect(lines.map((line) => line.map((s) => s.text).join(""))).toEqual([
      "bold",
      "words",
      "and",
      "averyver",
      "yverylon",
      "gword",
      "中文中文",
      "中文",
    ]);
    expect(lines[0]?.[0]?.bold).toBe(true);
  });
});
