/**
 * Edits of the composer's text and moves of its cursor. Moves step by grapheme, and over a
 * placeholder as one piece; deletions take a placeholder whole. `columns` is how many columns the
 * text has on screen, which display rows and up and down depend on.
 */
import type { ComposerState } from "./state";
import { placeCursor, replaceRange } from "./state";
import {
  cursorCell,
  layoutRows,
  nextGraphemeEnd,
  offsetAtColumn,
  previousGraphemeStart,
  rowOf,
} from "./text-layout";

const WHITESPACE = /\s/;

export function insertText(state: ComposerState, text: string): ComposerState {
  return replaceRange(state, state.cursor, state.cursor, text);
}

/** The placeholder ending at the cursor, or the grapheme before it. */
export function deleteBackward(state: ComposerState): ComposerState {
  if (state.cursor === 0) return state;
  return replaceRange(
    state,
    previousGraphemeStart(state.text, state.cursor),
    state.cursor,
    "",
  );
}

/** The placeholder starting at the cursor, or the grapheme after it. */
export function deleteForward(state: ComposerState): ComposerState {
  if (state.cursor === state.text.length) return state;
  return replaceRange(
    state,
    state.cursor,
    nextGraphemeEnd(state.text, state.cursor),
    "",
  );
}

function lineStart(text: string, offset: number): number {
  return text.lastIndexOf("\n", offset - 1) + 1;
}

function lineEnd(text: string, offset: number): number {
  const next = text.indexOf("\n", offset);
  return next === -1 ? text.length : next;
}

export function deleteToLineStart(state: ComposerState): ComposerState {
  const start = lineStart(state.text, state.cursor);
  if (start === state.cursor) return state;
  return replaceRange(state, start, state.cursor, "");
}

export function deleteToLineEnd(state: ComposerState): ComposerState {
  const end = lineEnd(state.text, state.cursor);
  if (end === state.cursor) return state;
  return replaceRange(state, state.cursor, end, "");
}

/** Ctrl+W: the spaces before the cursor, then the run of non-spaces before them. */
export function deleteWordBefore(state: ComposerState): ComposerState {
  const { text, cursor } = state;
  let start = cursor;
  while (start > 0 && WHITESPACE.test(text[start - 1] ?? "")) start -= 1;
  while (start > 0 && !WHITESPACE.test(text[start - 1] ?? "")) start -= 1;
  if (start === cursor) return state;
  return replaceRange(state, start, cursor, "");
}

export function moveLeft(state: ComposerState): ComposerState {
  return placeCursor(state, previousGraphemeStart(state.text, state.cursor));
}

export function moveRight(state: ComposerState): ComposerState {
  return placeCursor(state, nextGraphemeEnd(state.text, state.cursor), true);
}

export function moveToLineStart(state: ComposerState): ComposerState {
  return placeCursor(state, lineStart(state.text, state.cursor));
}

export function moveToLineEnd(state: ComposerState): ComposerState {
  return placeCursor(state, lineEnd(state.text, state.cursor), true);
}

export function moveToRowStart(
  state: ComposerState,
  columns: number,
): ComposerState {
  const rows = layoutRows(state.text, columns);
  const row = rows[rowOf(state.text, rows, state.cursor)];
  return placeCursor(state, row?.start ?? 0);
}

export function moveToRowEnd(
  state: ComposerState,
  columns: number,
): ComposerState {
  const rows = layoutRows(state.text, columns);
  const row = rowOf(state.text, rows, state.cursor);
  return placeCursor(
    state,
    offsetAtColumn(state.text, rows, row, Number.POSITIVE_INFINITY),
    true,
  );
}

/**
 * The cursor one display row up (`-1`) or down (`1`), at the same display column or the nearest
 * one before it. Undefined when there is no row in that direction.
 */
export function moveVertically(
  state: ComposerState,
  columns: number,
  direction: -1 | 1,
): ComposerState | undefined {
  const rows = layoutRows(state.text, columns);
  const { row, column } = cursorCell(state.text, rows, state.cursor);
  const target = row + direction;
  if (target < 0 || target >= rows.length) return undefined;
  return placeCursor(state, offsetAtColumn(state.text, rows, target, column));
}

/** Enter right after a `\`: the backslash becomes a line break. Undefined when there is none. */
export function breakLineAtBackslash(
  state: ComposerState,
): ComposerState | undefined {
  if (state.text[state.cursor - 1] !== "\\") return undefined;
  return replaceRange(state, state.cursor - 1, state.cursor, "\n");
}
