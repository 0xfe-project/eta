/**
 * Runs of text that share one style, and how to measure and wrap them by terminal columns. Gemini
 * CLI's table measures through styled-character functions that only its fork of Ink has; these do
 * the same job on official Ink, measuring with `string-width` (wide characters take two columns).
 *
 * This file is eta's own, not taken from Gemini CLI.
 */
import stringWidth from "string-width";

/** A run of text drawn in one style. */
export interface InlineSpan {
  text: string;
  /** An Ink colour; `undefined` leaves the terminal's own. */
  color: string | undefined;
  bold?: boolean | undefined;
  italic?: boolean | undefined;
  strikethrough?: boolean | undefined;
  underline?: boolean | undefined;
}

/** A word: the spans between two runs of white space, which may change style midway. */
interface Word {
  pieces: InlineSpan[];
  width: number;
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const SPACE: InlineSpan = { text: " ", color: undefined };

export function spansWidth(spans: readonly InlineSpan[]): number {
  return spans.reduce((sum, span) => sum + stringWidth(span.text), 0);
}

/** The columns the widest word takes: the narrowest a wrapped line can be without breaking a word. */
export function widestWord(spans: readonly InlineSpan[]): number {
  return Math.max(0, ...wordsOf(spans).map((word) => word.width));
}

/**
 * The spans as lines of at most `width` columns. Lines break at white space, which collapses to
 * one space; a word wider than a line starts a line of its own and breaks between characters.
 * A character wider than `width` still takes a line by itself.
 */
export function wrapSpans(
  spans: readonly InlineSpan[],
  width: number,
): InlineSpan[][] {
  const lines: InlineSpan[][] = [];
  let line: InlineSpan[] = [];
  let lineWidth = 0;
  const endLine = () => {
    lines.push(line);
    line = [];
    lineWidth = 0;
  };
  for (const word of wordsOf(spans)) {
    if (word.width > width) {
      if (lineWidth > 0) endLine();
      const chunks = breakWord(word.pieces, width);
      const last = chunks.pop() ?? [];
      for (const chunk of chunks) lines.push(chunk);
      line = last;
      lineWidth = spansWidth(last);
      continue;
    }
    if (lineWidth > 0 && lineWidth + 1 + word.width > width) endLine();
    if (lineWidth > 0) {
      line.push(SPACE);
      lineWidth += 1;
    }
    line.push(...word.pieces);
    lineWidth += word.width;
  }
  if (lineWidth > 0 || lines.length === 0) lines.push(line);
  return lines;
}

function wordsOf(spans: readonly InlineSpan[]): Word[] {
  const words: Word[] = [];
  let pieces: InlineSpan[] = [];
  const endWord = () => {
    if (pieces.length === 0) return;
    words.push({ pieces, width: spansWidth(pieces) });
    pieces = [];
  };
  for (const span of spans) {
    const parts = span.text.split(/(\s+)/);
    parts.forEach((part, index) => {
      // `split` with a capture puts the white space at the odd indexes.
      if (index % 2 === 1) endWord();
      else if (part !== "") pieces.push({ ...span, text: part });
    });
  }
  endWord();
  return words;
}

function breakWord(
  pieces: readonly InlineSpan[],
  width: number,
): InlineSpan[][] {
  const chunks: InlineSpan[][] = [];
  let chunk: InlineSpan[] = [];
  let chunkWidth = 0;
  for (const piece of pieces) {
    let text = "";
    for (const { segment } of graphemes.segment(piece.text)) {
      const next = stringWidth(segment);
      if (chunkWidth > 0 && chunkWidth + next > width) {
        if (text !== "") chunk.push({ ...piece, text });
        chunks.push(chunk);
        chunk = [];
        chunkWidth = 0;
        text = "";
      }
      text += segment;
      chunkWidth += next;
    }
    if (text !== "") chunk.push({ ...piece, text });
  }
  chunks.push(chunk);
  return chunks;
}
