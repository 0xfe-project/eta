/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 * Modified for eta: drops MaxSizedBox, the screen-reader and new-file branches, settings and the diff background colours, takes its colours from a palette, and draws a diff of a new file like any other.
 */
import type { ReactNode } from "react";
import type { Palette } from "./colors";
import type { DiffLine } from "./diff-parsing";
import { Box, Text } from "ink";
import { colorizeLine, languageForPath } from "./code-colorizer";
import { parseDiffWithLineNumbers } from "./diff-parsing";

interface DiffRendererProps {
  diff: string;
  /** Picks the highlighting language. */
  filename?: string | undefined;
  tabWidth?: number;
  width: number;
  palette: Palette;
}

const DEFAULT_TAB_WIDTH = 4; // Spaces per tab for normalization
const MAX_CONTEXT_LINES_WITHOUT_GAP = 5;

/**
 * A unified diff as numbered lines: removed lines by their old number, the rest by their new one,
 * the code highlighted by the file's language, and a rule where two hunks are far apart. Draws
 * nothing for a diff without hunk lines.
 */
export function DiffRenderer({
  diff,
  filename,
  tabWidth = DEFAULT_TAB_WIDTH,
  width,
  palette,
}: DiffRendererProps) {
  const safeWidth = Math.max(0, Math.floor(width));
  const displayableLines = parseDiffWithLineNumbers(diff)
    .filter((l) => l.type !== "hunk" && l.type !== "other")
    .map((line) => ({
      ...line,
      content: line.content.replaceAll("\t", " ".repeat(tabWidth)),
    }));
  if (displayableLines.length === 0) return null;

  const maxLineNumber = Math.max(
    0,
    ...displayableLines.map((l) => l.oldLine ?? 0),
    ...displayableLines.map((l) => l.newLine ?? 0),
  );
  const gutterWidth = Math.max(1, maxLineNumber.toString().length);
  const language = languageForPath(filename);
  const baseIndentation = commonIndentation(displayableLines);

  let lastLineNumber: number | null = null;
  const content: ReactNode[] = [];
  displayableLines.forEach((line, index) => {
    const relevantLineNumber =
      line.type === "del" ? (line.oldLine ?? null) : (line.newLine ?? null);
    if (
      lastLineNumber !== null &&
      relevantLineNumber !== null &&
      relevantLineNumber > lastLineNumber + MAX_CONTEXT_LINES_WITHOUT_GAP + 1
    ) {
      content.push(
        <Box
          key={`gap-${index}`}
          borderStyle="double"
          borderLeft={false}
          borderRight={false}
          borderBottom={false}
          width={safeWidth}
          borderColor={palette.muted}
        />,
      );
    }

    let gutterNumber = "";
    let prefixSymbol = " ";
    if (line.type === "add") {
      gutterNumber = String(line.newLine ?? "");
      prefixSymbol = "+";
      lastLineNumber = line.newLine ?? null;
    } else if (line.type === "del") {
      gutterNumber = String(line.oldLine ?? "");
      prefixSymbol = "-";
      // A deletion moves on by the old file's numbers.
      if (line.oldLine !== undefined) lastLineNumber = line.oldLine;
    } else {
      gutterNumber = String(line.newLine ?? "");
      lastLineNumber = line.newLine ?? null;
    }

    const symbolColor =
      line.type === "add"
        ? palette.success
        : line.type === "del"
          ? palette.error
          : undefined;

    content.push(
      <Box key={`diff-line-${index}`} flexDirection="row">
        <Box
          width={gutterWidth + 1}
          paddingRight={1}
          flexShrink={0}
          justifyContent="flex-end"
        >
          <Text color={palette.muted}>{gutterNumber}</Text>
        </Box>
        <Box width={2} flexShrink={0}>
          <Text color={symbolColor}>{prefixSymbol}</Text>
        </Box>
        <Box flexGrow={1}>
          <Text wrap="wrap">
            {colorizeLine(
              line.content.substring(baseIndentation),
              language,
              palette.text,
            )}
          </Text>
        </Box>
      </Box>,
    );
  });

  return (
    <Box flexDirection="column" width={safeWidth}>
      {content}
    </Box>
  );
}

/** The fewest leading spaces among the lines with any content, so the diff need not start far right. */
function commonIndentation(lines: readonly DiffLine[]): number {
  let baseIndentation = Infinity;
  for (const line of lines) {
    if (line.content.trim() === "") continue;
    const firstCharIndex = line.content.search(/\S/);
    baseIndentation = Math.min(
      baseIndentation,
      firstCharIndex === -1 ? 0 : firstCharIndex,
    );
  }
  return Number.isFinite(baseIndentation) ? baseIndentation : 0;
}
