// Ported from pi-mcp-adapter/search-ranking.ts (MIT, see ../NOTICE); ranks plain entries instead of reading the session state, and has one tool name instead of a prefixed and an original one.
/**
 * Weighted search over tool names, server names, descriptions and configured keywords.
 *
 * Each field has a weight; a query matches a field as a whole phrase (exact, prefix, substring) and
 * by its words (exact token, stem, substring). A query must cover its words well enough or the tool
 * is not a match at all, so "open file" does not return every tool that mentions "file".
 */
import type { ToolMeta } from "./types";
import { matchesToolPattern } from "./names";

/**
 * Shortest field token allowed to stem-match a longer query token.
 * Real descriptions tokenize possessives into single letters ("project's" -> ["project", "s"]),
 * which would otherwise make every query starting with that letter a match.
 */
const MIN_STEM_LENGTH = 4;

// ASCII tokens are kept whole; a non-ASCII run (CJK, say) becomes bounded adjacent bigrams, because
// it has no spaces to split on. Whole-run fallbacks keep single characters searchable.
const MAX_UNICODE_BIGRAMS_PER_RUN = 64;
const SEARCH_RUN = /[a-z0-9]+|(?:(?![a-z0-9])[\p{L}\p{N}\p{M}])+/gu;
const ASCII_RUN = /^[a-z0-9]+$/;

const FIELD_WEIGHTS = {
  name: 12,
  server: 8,
  description: 5,
  serverDescription: 5,
  keywords: 5,
} as const;

/** One tool as search sees it. */
export interface SearchEntry {
  server: string;
  tool: ToolMeta;
  serverDescription?: string | undefined;
  /** The `searchKeywords` that apply to this tool. */
  keywords?: readonly string[] | undefined;
}

export interface RankedMatch {
  server: string;
  tool: ToolMeta;
  score: number;
}

type SearchField = Exclude<keyof typeof FIELD_WEIGHTS, "keywords">;

interface PreparedEntry {
  entry: SearchEntry;
  fields: Array<[SearchField, string, string[]]>;
  nameTokens: string[];
  keywordPhrases: string[];
  keywordTokens: string[];
}

/**
 * The configured `searchKeywords` that apply to a tool. Keys name a tool or a glob; every entry
 * that matches is unioned.
 */
export function resolveSearchKeywords(
  map: Record<string, string[]> | undefined,
  server: string,
  tool: string,
): string[] {
  if (!map || typeof map !== "object" || Array.isArray(map)) return [];
  const keywords: string[] = [];
  const seen = new Set<string>();
  for (const [pattern, values] of Object.entries(map)) {
    if (!Array.isArray(values) || !matchesToolPattern(server, tool, [pattern]))
      continue;
    for (const value of values) {
      if (typeof value !== "string") continue;
      const trimmed = value.trim();
      if (!trimmed || seen.has(trimmed)) continue;
      seen.add(trimmed);
      keywords.push(trimmed);
    }
  }
  return keywords;
}

export function normalizeSearchText(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_./:-]+/g, " ")
    .toLowerCase();
}

export function tokenize(value: string): string[] {
  const tokens: string[] = [];
  for (const run of normalizeSearchText(value).match(SEARCH_RUN) ?? []) {
    if (ASCII_RUN.test(run)) {
      tokens.push(run);
      continue;
    }
    const characters = [...run];
    if (
      characters.length === 1 ||
      characters.length > MAX_UNICODE_BIGRAMS_PER_RUN + 1
    ) {
      tokens.push(run);
      continue;
    }
    let previous = "";
    for (const character of characters) {
      if (previous) tokens.push(previous + character);
      previous = character;
    }
  }
  return [...new Set(tokens)];
}

function matchesAsciiStem(fieldToken: string, queryToken: string): boolean {
  return (
    ASCII_RUN.test(fieldToken) &&
    ASCII_RUN.test(queryToken) &&
    (fieldToken.startsWith(queryToken) ||
      (fieldToken.length >= MIN_STEM_LENGTH &&
        queryToken.startsWith(fieldToken)))
  );
}

function prepare(entry: SearchEntry): PreparedEntry {
  const values: Record<SearchField, string> = {
    name: normalizeSearchText(entry.tool.name),
    server: normalizeSearchText(entry.server),
    description: normalizeSearchText(entry.tool.description),
    serverDescription: normalizeSearchText(entry.serverDescription ?? ""),
  };
  const fields = (Object.entries(values) as Array<[SearchField, string]>).map(
    ([field, value]): [SearchField, string, string[]] => [
      field,
      value,
      tokenize(value),
    ],
  );
  const keywordPhrases =
    entry.keywords
      ?.map((keyword) => normalizeSearchText(keyword).trim())
      .filter(Boolean) ?? [];
  return {
    entry,
    fields,
    nameTokens: fields[0]?.[2] ?? [],
    keywordPhrases,
    keywordTokens: keywordPhrases.flatMap(tokenize),
  };
}

function score(
  prepared: PreparedEntry,
  normalizedQuery: string,
  queryTokens: string[],
): number | null {
  let total = 0;
  let phraseMatched = false;
  let wholeFieldExact = false;
  const matchedTokens = new Set<string>();

  for (const [field, value, fieldTokens] of prepared.fields) {
    const weight = FIELD_WEIGHTS[field];
    if (value === normalizedQuery) {
      total += weight * 14;
      phraseMatched = true;
      wholeFieldExact = true;
    } else if (value.startsWith(normalizedQuery)) {
      total += weight * 9;
      phraseMatched = true;
    } else if (value.includes(normalizedQuery)) {
      total += weight * 6;
      phraseMatched = true;
    }

    for (const token of queryTokens) {
      if (fieldTokens.includes(token)) {
        total += weight * 4;
        matchedTokens.add(token);
      } else if (
        fieldTokens.some((fieldToken) => matchesAsciiStem(fieldToken, token))
      ) {
        total += weight * 2;
        matchedTokens.add(token);
      } else if (value.includes(token)) {
        total += weight;
        matchedTokens.add(token);
      }
    }
  }

  // Keywords are discrete phrases, so the phrase bonus is computed per phrase (best one wins)
  // rather than on a joined string, which would phrase-match a query spanning two unrelated ones.
  if (prepared.keywordPhrases.length > 0) {
    const weight = FIELD_WEIGHTS.keywords;
    let phraseScore = 0;
    for (const phrase of prepared.keywordPhrases) {
      if (phrase === normalizedQuery) {
        phraseScore = Math.max(phraseScore, weight * 14);
        phraseMatched = true;
        wholeFieldExact = true;
      } else if (phrase.startsWith(normalizedQuery)) {
        phraseScore = Math.max(phraseScore, weight * 9);
        phraseMatched = true;
      } else if (phrase.includes(normalizedQuery)) {
        phraseScore = Math.max(phraseScore, weight * 6);
        phraseMatched = true;
      }
    }
    total += phraseScore;

    for (const token of queryTokens) {
      if (prepared.keywordTokens.includes(token)) {
        total += weight * 4;
        matchedTokens.add(token);
      } else if (
        prepared.keywordTokens.some((keywordToken) =>
          matchesAsciiStem(keywordToken, token),
        )
      ) {
        total += weight * 2;
        matchedTokens.add(token);
      } else if (
        prepared.keywordPhrases.some((phrase) => phrase.includes(token))
      ) {
        total += weight;
        matchedTokens.add(token);
      }
    }
  }

  const coverage = matchedTokens.size / queryTokens.length;
  if (
    !phraseMatched &&
    (queryTokens.length <= 2 ? coverage !== 1 : coverage < 0.6)
  )
    return null;

  total += coverage === 1 ? 25 : Math.round(coverage * 10);
  const first = queryTokens[0];
  if (first !== undefined && prepared.nameTokens.includes(first)) total += 8;
  if (wholeFieldExact) total += 20;
  return total;
}

/** Entries that match, best first; ties by name. */
export function rankTools(
  entries: readonly SearchEntry[],
  query: string,
): RankedMatch[] {
  const normalizedQuery = normalizeSearchText(query).trim();
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return [];
  const matches: RankedMatch[] = [];
  for (const entry of entries) {
    const value = score(prepare(entry), normalizedQuery, queryTokens);
    if (value !== null)
      matches.push({ server: entry.server, tool: entry.tool, score: value });
  }
  return matches.sort(
    (a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name),
  );
}

export function paginate<T>(
  items: T[],
  offset: number,
  limit: number,
): { items: T[]; total: number; hasMore: boolean; nextOffset: number | null } {
  const safeOffset = Number.isFinite(offset)
    ? Math.max(0, Math.trunc(offset))
    : 0;
  const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.trunc(limit)) : 1;
  const total = items.length;
  const page = items.slice(safeOffset, safeOffset + safeLimit);
  const nextOffset = safeOffset + page.length;
  return {
    items: page,
    total,
    hasMore: nextOffset < total,
    nextOffset: nextOffset < total ? nextOffset : null,
  };
}

/** Tool names close to what the model asked for, for the "did you mean" line. */
export function suggest(
  entries: readonly SearchEntry[],
  requested: string,
  limit: number,
): string[] {
  // A qualified or server-prefixed name is searched by its tool part (longest server name first,
  // so `a_b` wins over `a`).
  let bare = requested;
  const servers = [...new Set(entries.map((entry) => entry.server))].sort(
    (a, b) => b.length - a.length,
  );
  for (const server of servers) {
    const prefix = [`mcp__${server}__`, `${server}__`, `${server}_`].find(
      (candidate) => requested.startsWith(candidate),
    );
    if (prefix) {
      bare = requested.slice(prefix.length);
      break;
    }
  }
  const names = rankTools(
    entries.map((entry) => ({ ...entry, keywords: undefined })),
    bare,
  ).map((match) => match.tool.name);
  // A typo shares no word with the right name, so ranking finds nothing: add the names that are a
  // few edits away.
  const folded = bare.toLowerCase().replace(/-/g, "_");
  const allowed = Math.max(1, Math.min(3, Math.floor(folded.length / 4)));
  const near = entries
    .map((entry) => ({
      name: entry.tool.name,
      distance: editDistance(
        folded,
        entry.tool.name.toLowerCase().replace(/-/g, "_"),
        allowed,
      ),
    }))
    .filter((candidate) => candidate.distance <= allowed)
    .sort((a, b) => a.distance - b.distance)
    .map((candidate) => candidate.name);
  return [...new Set([...near, ...names])].slice(0, limit);
}

/** Levenshtein distance, giving up (returning `max + 1`) once it must exceed `max`. */
function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let smallest = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const value = Math.min(
        previous[j]! + 1,
        row[j - 1]! + 1,
        previous[j - 1]! + cost,
      );
      row.push(value);
      smallest = Math.min(smallest, value);
    }
    if (smallest > max) return max + 1;
    previous = row;
  }
  return previous[b.length]!;
}
