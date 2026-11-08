/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 * Modified for eta: measures and wraps cells as styled spans with string-width instead of the Ink fork's styled characters, draws each line as one `<Text>`, lists the cells under their headers when the columns cannot fit, and takes its colours from a palette.
 */
import type { ReactNode } from "react";
import type { Palette } from "./colors";
import type { InlineSpan } from "./styled-spans";
import { Box, Text } from "ink";
import { Spans } from "./inline-markdown-renderer";
import { parseInlineMarkdown, stripUnsafeCharacters } from "./markdown-parsing";
import { spansWidth, widestWord, wrapSpans } from "./styled-spans";

interface TableRendererProps {
  headers: string[];
  rows: string[][];
  width: number;
  palette: Palette;
}

const MIN_COLUMN_WIDTH = 5;
const COLUMN_PADDING = 2;
const TABLE_MARGIN = 2;
// A wide character takes two columns, so a cell narrower than that cannot hold one.
const NARROWEST_CELL = 2;

const BORDERS = {
  top: { left: "┌", middle: "┬", right: "┐", horizontal: "─" },
  middle: { left: "├", middle: "┼", right: "┤", horizontal: "─" },
  bottom: { left: "└", middle: "┴", right: "┘", horizontal: "─" },
} as const;

type WrappedRow = InlineSpan[][][];

const withHeaderStyle = (spans: InlineSpan[]): InlineSpan[] =>
  spans.map((span) => ({ ...span, bold: true }));

/**
 * A markdown table drawn with box borders, its cells wrapped so that no line is wider than
 * `width`. When even the narrowest columns cannot fit, each row is drawn as `header: cell` lines.
 */
export function TableRenderer({
  headers,
  rows,
  width,
  palette,
}: TableRendererProps) {
  const headerSpans = headers.map((header) =>
    withHeaderStyle(
      parseInlineMarkdown(
        stripUnsafeCharacters(header),
        palette.accent,
        palette,
      ),
    ),
  );
  const rowSpans = rows.map((row) =>
    row.map((cell) =>
      parseInlineMarkdown(stripUnsafeCharacters(cell), palette.text, palette),
    ),
  );
  const numColumns = rowSpans.reduce(
    (max, row) => Math.max(max, row.length),
    headerSpans.length,
  );
  const contentWidths = allocateWidths(
    [headerSpans, ...rowSpans],
    numColumns,
    width,
  );

  const wrapRow = (row: InlineSpan[][]): WrappedRow =>
    contentWidths.map((columnWidth, column) =>
      wrapSpans(row[column] ?? [], columnWidth),
    );
  const wrappedHeaders = wrapRow(headerSpans);
  const wrappedRows = rowSpans.map(wrapRow);

  // The tightest widths that hold the wrapped content, plus padding.
  const adjustedWidths = contentWidths.map(
    (_, column) =>
      Math.max(
        0,
        ...[wrappedHeaders, ...wrappedRows].flatMap((row) =>
          (row[column] ?? []).map(spansWidth),
        ),
      ) + COLUMN_PADDING,
  );
  const tableWidth =
    adjustedWidths.reduce((sum, w) => sum + w, 0) + numColumns + 1;
  if (tableWidth > width)
    return (
      <CellList
        headers={headerSpans}
        rows={rowSpans}
        width={width}
        palette={palette}
      />
    );

  const border = (type: keyof typeof BORDERS): ReactNode => {
    const chars = BORDERS[type];
    const parts = adjustedWidths.map((w) => chars.horizontal.repeat(w));
    return (
      <Text color={palette.border}>
        {chars.left + parts.join(chars.middle) + chars.right}
      </Text>
    );
  };

  const visualRow = (cells: InlineSpan[][], key: string): ReactNode => (
    <Text key={key}>
      <Text color={palette.border}>│</Text>
      {cells.map((cell, column) => {
        const padding = (adjustedWidths[column] ?? 0) - COLUMN_PADDING;
        const fill = " ".repeat(Math.max(0, padding - spansWidth(cell)));
        return (
          // Columns never reorder, so the index names each.
          // eslint-disable-next-line react/no-array-index-key
          <Text key={column}>
            {" "}
            <Spans spans={cell} />
            {fill} <Text color={palette.border}>│</Text>
          </Text>
        );
      })}
    </Text>
  );

  const dataRow = (wrapped: WrappedRow, key: string): ReactNode[] => {
    const height = Math.max(1, ...wrapped.map((lines) => lines.length));
    return Array.from({ length: height }, (_, line) =>
      visualRow(
        wrapped.map((lines) => lines[line] ?? []),
        `${key}-${line}`,
      ),
    );
  };

  return (
    <Box flexDirection="column">
      {border("top")}
      {dataRow(wrappedHeaders, "header")}
      {border("middle")}
      {wrappedRows.flatMap((row, index) => dataRow(row, `row-${index}`))}
      {border("bottom")}
    </Box>
  );
}

/** The content width of each column, before wrapping tightens it. */
function allocateWidths(
  table: InlineSpan[][][],
  numColumns: number,
  width: number,
): number[] {
  const constraints = Array.from({ length: numColumns }, (_, column) => {
    let minWidth = 0;
    let maxWidth = 0;
    for (const row of table) {
      const cell = row[column] ?? [];
      minWidth = Math.max(minWidth, widestWord(cell));
      maxWidth = Math.max(maxWidth, spansWidth(cell));
    }
    return { minWidth, maxWidth: Math.max(minWidth, maxWidth) };
  });

  // Fixed overhead: borders (n+1) + padding (2n)
  const fixedOverhead = numColumns + 1 + numColumns * COLUMN_PADDING;
  const availableWidth = Math.max(0, width - fixedOverhead - TABLE_MARGIN);
  const totalMinWidth = constraints.reduce((sum, c) => sum + c.minWidth, 0);
  let widths: number[];

  if (totalMinWidth > availableWidth) {
    // Every column but the very short ones (at most MIN_COLUMN_WIDTH) shrinks in proportion.
    const totalShortColumnWidth = constraints
      .filter((c) => c.maxWidth <= MIN_COLUMN_WIDTH)
      .reduce((sum, c) => sum + c.minWidth, 0);
    const finalTotalShortColumnWidth =
      totalShortColumnWidth >= availableWidth ? 0 : totalShortColumnWidth;
    const scale =
      (availableWidth - finalTotalShortColumnWidth) /
        (totalMinWidth - finalTotalShortColumnWidth) || 0;
    widths = constraints.map((c) =>
      c.maxWidth <= MIN_COLUMN_WIDTH && finalTotalShortColumnWidth > 0
        ? c.minWidth
        : Math.floor(c.minWidth * scale),
    );
  } else {
    const surplus = availableWidth - totalMinWidth;
    const totalGrowthNeed = constraints.reduce(
      (sum, c) => sum + (c.maxWidth - c.minWidth),
      0,
    );
    widths =
      totalGrowthNeed === 0
        ? constraints.map((c) => c.minWidth)
        : constraints.map((c) => {
            const growthNeed = c.maxWidth - c.minWidth;
            const extra = Math.floor(surplus * (growthNeed / totalGrowthNeed));
            return Math.min(c.maxWidth, c.minWidth + extra);
          });
  }
  return widths.map((w) => Math.max(NARROWEST_CELL, w));
}

interface CellListProps {
  headers: InlineSpan[][];
  rows: InlineSpan[][][];
  width: number;
  palette: Palette;
}

/** Each row as one `header: cell` line per column, rows apart by a blank line. */
function CellList({ headers, rows, width, palette }: CellListProps) {
  const lines: ReactNode[] = [];
  rows.forEach((row, rowIndex) => {
    if (rowIndex > 0) lines.push(<Text key={`gap-${rowIndex}`}> </Text>);
    row.forEach((cell, column) => {
      const label = headers[column] ?? [];
      const spans: InlineSpan[] = [
        ...label,
        { text: ":", color: palette.accent, bold: true },
        { text: " ", color: undefined },
        ...cell,
      ];
      wrapSpans(spans, width).forEach((line, lineIndex) =>
        lines.push(
          <Text key={`${rowIndex}-${column}-${lineIndex}`}>
            <Spans spans={line} />
          </Text>,
        ),
      );
    });
  });
  return <Box flexDirection="column">{lines}</Box>;
}
