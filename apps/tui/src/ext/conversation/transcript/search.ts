/** One occurrence of the query: `[start, end)` in UTF-16 offsets of a plain line. */
export interface Match {
  line: number;
  start: number;
  end: number;
}

/** Every occurrence of `query` in the lines, ignoring case, oldest first; none for an empty query. */
export function findMatches(plain: readonly string[], query: string): Match[] {
  if (query === "") return [];
  const wanted = query.toLowerCase();
  const matches: Match[] = [];
  plain.forEach((text, line) => {
    const lower = text.toLowerCase();
    let from = lower.indexOf(wanted);
    while (from >= 0) {
      matches.push({ line, start: from, end: from + wanted.length });
      from = lower.indexOf(wanted, from + wanted.length);
    }
  });
  return matches;
}

/**
 * The index of the newest match on `line` or above it; when every match is below, the newest of
 * all (the search goes round). Undefined without matches.
 */
export function matchAtOrAbove(
  matches: readonly Match[],
  line: number,
): number | undefined {
  if (matches.length === 0) return undefined;
  let found = matches.length - 1;
  matches.forEach((match, index) => {
    if (match.line <= line) found = index;
  });
  return matches[found]!.line <= line ? found : matches.length - 1;
}

/**
 * The match after `current` toward older (-1) or newer (1) lines, going round at either end. With
 * no current match it is the newest one; undefined without matches.
 */
export function stepMatch(
  current: number | undefined,
  count: number,
  direction: -1 | 1,
): number | undefined {
  if (count === 0) return undefined;
  if (current === undefined) return count - 1;
  return (current + direction + count) % count;
}
