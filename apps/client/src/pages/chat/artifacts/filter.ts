import type { ArtifactView } from "@eta/client-contracts";

/**
 * What the Artifacts tab does to a group's artifacts before it draws them, as the web app's
 * tab does: search the titles, keep one publisher's, keep the ones tied to a task or revised,
 * order them, cut them into pages of 15. All of it on the list the host already sent.
 */

export type ArtifactSort = "updated" | "created" | "title";

export interface ArtifactFilters {
  query: string;
  /** An agent's id, `NO_PUBLISHER` for those whose publisher is unknown, or null for all. */
  publisher: string | null;
  sort: ArtifactSort;
  withTask: boolean;
  revised: boolean;
  /** From 1. */
  page: number;
}

export const NO_PUBLISHER = "";
const PAGE_SIZE = 15;
/** How many the context tab lists before "View all". */
export const RECENT = 5;
export const sorts: readonly ArtifactSort[] = ["updated", "created", "title"];

export const defaultFilters: ArtifactFilters = {
  query: "",
  publisher: null,
  sort: "updated",
  withTask: false,
  revised: false,
  page: 1,
};

/** Anything that narrows the list; the order does not. */
export const isFiltered = (f: ArtifactFilters) =>
  f.query.trim() !== "" || f.publisher !== null || f.withTask || f.revised;

/** The filters with one change; anything but turning the page starts again from the first. */
export const withFilter = (
  f: ArtifactFilters,
  patch: Partial<ArtifactFilters>,
): ArtifactFilters => ({ ...f, page: 1, ...patch });

/** The filters with everything that narrows the list dropped; the order stays. */
export const cleared = (f: ArtifactFilters): ArtifactFilters =>
  withFilter(f, {
    query: "",
    publisher: null,
    withTask: false,
    revised: false,
  });

// NFKC folds full-width letters, digits and punctuation into their ASCII forms (Ａ → A, ＃ → #);
// lower case after it, so case does not matter either.
const fold = (text: string) => text.normalize("NFKC").toLowerCase();

/**
 * Where the query is in the title, as [start, end) offsets into the title itself. The fold can
 * change a character's length (ﬁ → fi), so it is done one code point at a time with a map back.
 */
function matchRanges(title: string, query: string): [number, number][] {
  const needle = fold(query.trim());
  if (!needle) return [];
  let folded = "";
  // For each UTF-16 unit of `folded`, the offset in `title` of the code point it came from.
  const from: number[] = [];
  let at = 0;
  for (const char of title) {
    const piece = fold(char);
    folded += piece;
    for (let i = 0; i < piece.length; i++) from.push(at);
    at += char.length;
  }
  from.push(title.length);
  const ranges: [number, number][] = [];
  let index = folded.indexOf(needle);
  while (index !== -1) {
    const start = from[index]!;
    let end = from[index + needle.length]!;
    if (end <= start) end = start + 1;
    ranges.push([start, end]);
    index = folded.indexOf(needle, index + needle.length);
  }
  return ranges;
}

/** The title cut into runs, each marked when the query matched it. */
export function highlightParts(title: string, query: string) {
  const parts: { text: string; match: boolean }[] = [];
  let at = 0;
  for (const [start, end] of matchRanges(title, query)) {
    if (start > at) parts.push({ text: title.slice(at, start), match: false });
    parts.push({ text: title.slice(start, end), match: true });
    at = end;
  }
  if (at < title.length) parts.push({ text: title.slice(at), match: false });
  return parts;
}

const matches = (title: string, query: string) =>
  query.trim() === "" || fold(title).includes(fold(query.trim()));

const publisherOf = (a: ArtifactView) => a.publisherAgentId ?? NO_PUBLISHER;

/** Everything but the publisher: what the publisher counts count. */
function narrow(artifacts: readonly ArtifactView[], f: ArtifactFilters) {
  return artifacts.filter(
    (a) =>
      matches(a.title, f.query) &&
      (!f.withTask || a.taskId !== null) &&
      (!f.revised || a.versions.length > 1),
  );
}

/** Each publisher with how many of theirs pass the search and the extra filters, most first. */
export function publisherCounts(
  artifacts: readonly ArtifactView[],
  f: ArtifactFilters,
) {
  // Every publisher in the group keeps a row, at 0 when the search leaves them none, so the
  // list does not reshuffle under the finger as the user types.
  const totals = new Map<string, number>();
  for (const a of artifacts)
    totals.set(publisherOf(a), (totals.get(publisherOf(a)) ?? 0) + 1);
  const counts = new Map<string, number>([...totals.keys()].map((k) => [k, 0]));
  const kept = narrow(artifacts, f);
  for (const a of kept)
    counts.set(publisherOf(a), (counts.get(publisherOf(a)) ?? 0) + 1);
  const publishers = [...counts.keys()].sort(
    (a, b) => totals.get(b)! - totals.get(a)!,
  );
  return {
    all: kept.length,
    publishers: publishers.map((id) => ({ id, count: counts.get(id)! })),
  };
}

/** How many of the group's are tied to a task, for the menu's count. */
export const withTaskCount = (artifacts: readonly ArtifactView[]) =>
  artifacts.filter((a) => a.taskId !== null).length;

export const timeOf = (a: ArtifactView, sort: ArtifactSort) =>
  sort === "created" ? a.createdAt : a.updatedAt;

/**
 * Titles in reading order: case and letter width do not count, and a run of digits counts as the
 * number it spells, so "Plan 2" comes before "Plan 10". (The client's runtime has no
 * `Intl.Collator`; this is the part of `{ numeric: true }` the web's sort relies on.)
 */
function naturalCompare(a: string, b: string) {
  const runs = (text: string) => fold(text).match(/\d+|\D+/g) ?? [];
  const left = runs(a);
  const right = runs(b);
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    const x = left[i]!;
    const y = right[i]!;
    const numbers = /^\d/.test(x) && /^\d/.test(y);
    const order = numbers
      ? Number(x) - Number(y) || x.length - y.length
      : x < y
        ? -1
        : x > y
          ? 1
          : 0;
    if (order) return order;
  }
  return left.length - right.length;
}

/** The list as the tab draws it, before it is cut into pages. */
export function applyFilters(
  artifacts: readonly ArtifactView[],
  f: ArtifactFilters,
) {
  const kept = narrow(artifacts, f).filter(
    (a) => f.publisher === null || publisherOf(a) === f.publisher,
  );
  if (f.sort === "title")
    return kept.sort(
      (a, b) => naturalCompare(a.title, b.title) || b.updatedAt - a.updatedAt,
    );
  return kept.sort((a, b) => timeOf(b, f.sort) - timeOf(a, f.sort));
}

export type DayGroup = "today" | "yesterday" | "earlier";

const startOfDay = (at: number) => {
  const date = new Date(at);
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
  ).getTime();
};

function dayGroup(at: number, now = Date.now()): DayGroup {
  const today = startOfDay(now);
  if (at >= today) return "today";
  // The day before today's start, not 24 hours: a daylight saving day is 23 or 25.
  if (at >= startOfDay(today - 1)) return "yesterday";
  return "earlier";
}

/**
 * One page's rows, each with the day heading it sits under when the order is by time (none when
 * by title). Each page starts its own headings.
 */
export function pageRows(
  list: readonly ArtifactView[],
  f: ArtifactFilters,
  now = Date.now(),
) {
  const pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
  const page = Math.min(Math.max(1, f.page), pages);
  const start = (page - 1) * PAGE_SIZE;
  const items = list.slice(start, start + PAGE_SIZE);
  const grouped = f.sort !== "title";
  const rows = items.map((artifact, index) => {
    const group = grouped ? dayGroup(timeOf(artifact, f.sort), now) : null;
    const previous = items[index - 1];
    const heading =
      group !== null &&
      (!previous || dayGroup(timeOf(previous, f.sort), now) !== group);
    return { artifact, group, heading };
  });
  return {
    page,
    pages,
    first: list.length === 0 ? 0 : start + 1,
    last: start + items.length,
    rows,
  };
}

/** The page buttons: the first two, the last two, the current one and its neighbours; gaps are "…". */
export function pageWindow(page: number, pages: number): (number | null)[] {
  if (pages <= 7) return Array.from({ length: pages }, (_, i) => i + 1);
  const shown = new Set([1, 2, page - 1, page, page + 1, pages - 1, pages]);
  const out: (number | null)[] = [];
  let previous = 0;
  for (let p = 1; p <= pages; p++) {
    if (!shown.has(p)) continue;
    if (p - previous > 1) out.push(null);
    out.push(p);
    previous = p;
  }
  return out;
}

/** The most recently updated few, for the context tab: the same order whatever the tab's filters. */
export const recentArtifacts = (
  artifacts: readonly ArtifactView[],
  count = RECENT,
) => [...artifacts].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, count);
