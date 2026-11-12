import stringWidth from "string-width";

const ELLIPSIS = "…";
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Cuts text to at most `columns` terminal columns, ending a cut text with `…`. Wide characters count as two. */
export function truncateToWidth(text: string, columns: number): string {
  if (stringWidth(text) <= columns) return text;
  let kept = "";
  let width = 0;
  for (const { segment } of graphemes.segment(text)) {
    const next = stringWidth(segment);
    if (width + next + 1 > columns) break;
    kept += segment;
    width += next;
  }
  return kept + ELLIPSIS;
}

const SPACES = / /g;
const NO_BREAK_SPACE = " ";

/**
 * A name to put into a sentence that may wrap: its spaces become no-break spaces, which look the
 * same, so a wrapping line breaks before or after the whole name instead of inside it. A name
 * wider than the whole line still breaks where the line ends.
 */
export function keepTogether(name: string): string {
  return name.replace(SPACES, NO_BREAK_SPACE);
}
