/**
 * The one matcher of paths, for the machine that ranks what it found and the client that filters
 * what it remembers.
 *
 * Adapted from Paseo (`packages/protocol/src/search/text-match.ts`, commit `b24eab7`,
 * Copyright (c) 2025-present Mohamed Boudra, Apache License 2.0; see `./LICENSE`). Kept: the
 * exact tiers and the compact-path fallback of `scorePathMatch`. Left out: the typo tier and the
 * multi-field scoring, which a path picker does not use.
 *
 * A match is a tier and the offset it was found at; lower is better on both, so a caller sorts
 * ascending and never has to invent a scale.
 */

export interface MatchScore {
  tier: number;
  offset: number;
  /** How far apart the characters of a scattered match are; absent for a contiguous one. */
  spread?: number;
}

/** The tiers, best to worst. */
export const MATCH_TIER = {
  exact: 0,
  wholeWord: 1,
  prefix: 2,
  wordStart: 3,
  substring: 4,
  subsequence: 5,
} as const;

function isWordBoundary(ch: string | undefined): boolean {
  if (ch === undefined) return true;
  return !/[a-z0-9]/.test(ch);
}

function scoreSubstring(query: string, text: string): MatchScore | null {
  let best: MatchScore | null = null;
  let from = 0;
  while (from <= text.length - query.length) {
    const found = text.indexOf(query, from);
    if (found === -1) break;
    const startsAtBoundary = found === 0 || isWordBoundary(text[found - 1]);
    const endsAtBoundary = isWordBoundary(text[found + query.length]);
    const tier =
      startsAtBoundary && endsAtBoundary
        ? MATCH_TIER.wholeWord
        : found === 0
          ? MATCH_TIER.prefix
          : startsAtBoundary
            ? MATCH_TIER.wordStart
            : MATCH_TIER.substring;
    if (
      best === null ||
      tier < best.tier ||
      (tier === best.tier && found < best.offset)
    )
      best = { tier, offset: found };
    from = found + 1;
  }
  return best;
}

/** The query's characters in order within one whitespace-free run: `pasbab` finds `paseo-babysit`. */
function scoreSubsequence(query: string, text: string): MatchScore | null {
  let at = 0;
  let first = -1;
  let last = -1;
  for (let index = 0; index < text.length && at < query.length; index += 1) {
    if (/\s/u.test(text[index]!)) {
      at = 0;
      first = -1;
      last = -1;
      continue;
    }
    if (text[index] !== query[at]) continue;
    if (first === -1) first = index;
    last = index;
    at += 1;
  }
  if (at !== query.length || first === -1) return null;
  return {
    tier: MATCH_TIER.subsequence,
    offset: first,
    spread: last - first + 1,
  };
}

/** How `query` matches `text`, whatever the case; null when it does not. An empty query matches. */
export function scoreMatch(query: string, text: string): MatchScore | null {
  if (query === "") return { tier: MATCH_TIER.exact, offset: 0 };
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (t === q) return { tier: MATCH_TIER.exact, offset: 0 };
  return scoreSubstring(q, t) ?? scoreSubsequence(q, t);
}

interface Compact {
  value: string;
  offsets: number[];
}

/** Letters and digits only, with where each came from. */
function compact(value: string): Compact {
  let text = "";
  const offsets: number[] = [];
  for (let index = 0; index < value.length; index += 1) {
    if (!/[a-z0-9]/i.test(value[index]!)) continue;
    text += value[index]!.toLowerCase();
    offsets.push(index);
  }
  return { value: text, offsets };
}

/**
 * Match a query against a whole displayed path, separators and all. When the text does not
 * match as typed, it is tried again with only letters and digits on both sides, so `eta web`
 * still finds `eta/apps/web`.
 */
export function scorePathMatch(query: string, path: string): MatchScore | null {
  const direct = scoreMatch(query, path);
  if (direct !== null) return direct;
  const q = compact(query);
  const p = compact(path);
  if (q.value === "" || p.value === "") return null;
  const score = scoreMatch(q.value, p.value);
  if (score === null) return null;
  return { ...score, offset: p.offsets[score.offset] ?? score.offset };
}

/** Better first: the tier, then the offset, then how spread out it is. */
export function compareMatchScores(a: MatchScore, b: MatchScore): number {
  if (a.tier !== b.tier) return a.tier - b.tier;
  if (a.offset !== b.offset) return a.offset - b.offset;
  return (a.spread ?? 0) - (b.spread ?? 0);
}
