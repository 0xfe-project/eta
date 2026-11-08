import type { TranscriptLayout } from "./layout";

/** A cursor on one line, and where a range starts when one was marked. */
export interface Selection {
  cursor: number;
  anchor: number | undefined;
}

/** The cursor moved `delta` lines, kept inside the `total` lines. */
export function moveCursor(
  selection: Selection,
  delta: number,
  total: number,
): Selection {
  const cursor = Math.min(
    Math.max(0, selection.cursor + delta),
    Math.max(0, total - 1),
  );
  return { ...selection, cursor };
}

/** The first and last selected line: the range when one is marked, else the cursor line. */
export function selectionRange(selection: Selection): [number, number] {
  const anchor = selection.anchor ?? selection.cursor;
  return [
    Math.min(anchor, selection.cursor),
    Math.max(anchor, selection.cursor),
  ];
}

export function selectedLines(selection: Selection): number {
  const [from, to] = selectionRange(selection);
  return to - from + 1;
}

/** The selected lines as copied: each without its trailing blanks, one per line. */
export function selectedText(
  plain: readonly string[],
  selection: Selection,
): string {
  const [from, to] = selectionRange(selection);
  return plain
    .slice(from, to + 1)
    .map((line) => line.trimEnd())
    .join("\n");
}

/** The item under the cursor and its first line, where the cursor stays when it folds; none on a blank line. */
export function foldPlace(
  layout: TranscriptLayout,
  cursor: number,
): { item: number; line: number } | undefined {
  const item = layout.owner[cursor];
  if (item === undefined || item < 0) return undefined;
  return { item, line: layout.starts[item]! };
}
