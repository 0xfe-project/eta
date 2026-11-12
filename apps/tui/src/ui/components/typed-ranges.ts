/** A stretch of a name, `[start, end)` in UTF-16 offsets. */
export type TextRange = readonly [start: number, end: number];

/**
 * The ranges of `name` to draw bold for what was typed: the leading sigil (`/`, `@`) and the first
 * place, ignoring case, where `typed` shows after it. Only the sigil when `typed` is empty or does
 * not show.
 */
export function typedRanges(name: string, typed: string): TextRange[] {
  const sigil: TextRange = [0, 1];
  if (typed === "") return [sigil];
  const at = name.slice(1).toLowerCase().indexOf(typed.toLowerCase());
  if (at === -1) return [sigil];
  const start = at + 1;
  const end = start + typed.length;
  return start === 1 ? [[0, end]] : [sigil, [start, end]];
}
