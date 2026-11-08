/**
 * The composer's text as the terminal shows it: graphemes, display rows of a given column count,
 * and the mapping between UTF-16 offsets and cells. Wide characters take two columns.
 */
import stringWidth from "string-width";

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** One display row: `[start, end)` of the text, without the line break that may follow it. */
export interface DisplayRow {
  start: number;
  end: number;
}

/** Where an offset is drawn: the row index and the display column within the row. */
export interface Cell {
  row: number;
  column: number;
}

/** Start offsets of the graphemes of `text`, in order. */
function graphemeStarts(text: string): number[] {
  return [...graphemes.segment(text)].map((part) => part.index);
}

/** The start of the grapheme that ends at or contains the position just before `offset`. */
export function previousGraphemeStart(text: string, offset: number): number {
  let previous = 0;
  for (const start of graphemeStarts(text)) {
    if (start >= offset) break;
    previous = start;
  }
  return Math.min(previous, offset);
}

/** The end of the grapheme that starts at `offset`. */
export function nextGraphemeEnd(text: string, offset: number): number {
  for (const start of graphemeStarts(text)) if (start > offset) return start;
  return text.length;
}

/** Rows of one logical line `[lineStart, lineEnd)`. */
function wrapLine(
  text: string,
  lineStart: number,
  lineEnd: number,
  columns: number,
): DisplayRow[] {
  const rows: DisplayRow[] = [];
  let rowStart = lineStart;
  let width = 0;
  for (const { segment, index } of graphemes.segment(
    text.slice(lineStart, lineEnd),
  )) {
    const at = lineStart + index;
    const cells = stringWidth(segment);
    // A row always takes its first grapheme, even one wider than the row.
    if (at > rowStart && width + cells > columns) {
      rows.push({ start: rowStart, end: at });
      rowStart = at;
      width = 0;
    }
    width += cells;
  }
  rows.push({ start: rowStart, end: lineEnd });
  // A full last row leaves no cell for a cursor at the line's end: give it an empty row.
  if (width >= columns && lineEnd > lineStart)
    rows.push({ start: lineEnd, end: lineEnd });
  return rows;
}

/** The text cut into display rows of at most `columns` columns; at least one row. */
export function layoutRows(text: string, columns: number): DisplayRow[] {
  const rows: DisplayRow[] = [];
  let lineStart = 0;
  for (const line of text.split("\n")) {
    rows.push(...wrapLine(text, lineStart, lineStart + line.length, columns));
    lineStart += line.length + 1;
  }
  return rows;
}

/**
 * Whether the row is the last one of its logical line, so its end offset is drawn on it. The next
 * row of the same line starts where this one ends; the next line starts after a line break.
 */
function endsLine(rows: readonly DisplayRow[], row: number): boolean {
  const next = rows[row + 1];
  return next === undefined || next.start > (rows[row]?.end ?? 0);
}

/** The row an offset is drawn on. An offset on a wrap boundary is drawn at the next row's head. */
export function rowOf(
  text: string,
  rows: readonly DisplayRow[],
  offset: number,
): number {
  const found = rows.findIndex(
    (row, i) =>
      row.start <= offset &&
      (offset < row.end || (offset === row.end && endsLine(rows, i))),
  );
  return found === -1 ? rows.length - 1 : found;
}

export function cursorCell(
  text: string,
  rows: readonly DisplayRow[],
  offset: number,
): Cell {
  const row = rowOf(text, rows, offset);
  const start = rows[row]?.start ?? 0;
  return { row, column: stringWidth(text.slice(start, offset)) };
}

/**
 * The offset drawn at or just before `column` on `row`. A column inside a wide character gives
 * the offset before it. A wrapped row's end is drawn on the next row, so on such a row the last
 * reachable offset is the start of its last grapheme.
 */
export function offsetAtColumn(
  text: string,
  rows: readonly DisplayRow[],
  row: number,
  column: number,
): number {
  const { start, end } = rows[row] ?? { start: 0, end: 0 };
  let width = 0;
  let last = start;
  for (const { segment, index } of graphemes.segment(text.slice(start, end))) {
    const cells = stringWidth(segment);
    if (width + cells > column) return start + index;
    width += cells;
    last = start + index;
  }
  return endsLine(rows, row) ? end : last;
}
