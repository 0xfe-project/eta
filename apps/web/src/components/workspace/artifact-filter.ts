import type { ArtifactView } from "@eta/client-contracts";
import { useEffect } from "react";
import { create } from "zustand";
import { useArtifacts } from "@/queries/artifacts";

/**
 * What the Artifacts tab does to a group's artifacts before it draws them: search the titles,
 * keep one publisher's, keep the ones tied to a task or revised, order them, cut them into pages.
 * All of it on the list `useArtifacts` already holds — nothing here asks the host.
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
const defaultFilters: ArtifactFilters = {
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

// NFKC folds full-width letters, digits and punctuation into their ASCII forms (Ａ → A, ＃ → #);
// lower case after it, so case does not matter either.
const fold = (text: string) => text.normalize("NFKC").toLowerCase();

/**
 * Where the query is in the title, as [start, end) offsets into the title itself. The fold can
 * change a character's length (ﬁ → fi), so it is done one code point at a time with a map back.
 */
export function matchRanges(title: string, query: string): [number, number][] {
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
    // The end is where the code point after the match's last one starts.
    let end = from[index + needle.length]!;
    if (end <= start) end = start + 1;
    ranges.push([start, end]);
    index = folded.indexOf(needle, index + needle.length);
  }
  return ranges;
}

const matches = (title: string, query: string) =>
  query.trim() === "" || fold(title).includes(fold(query.trim()));

const publisherOf = (a: ArtifactView) => a.publisherAgentId ?? NO_PUBLISHER;

/** Everything but the publisher: what the publisher chips count. */
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
  // Every publisher in the group keeps a chip, at 0 when the search leaves them none, so the row
  // does not reshuffle under the cursor as the user types.
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

const collator = () => new Intl.Collator(undefined, { numeric: true });

/** The list as the tab draws it, before it is cut into pages. */
export function applyFilters(
  artifacts: readonly ArtifactView[],
  f: ArtifactFilters,
) {
  const kept = narrow(artifacts, f).filter(
    (a) => f.publisher === null || publisherOf(a) === f.publisher,
  );
  if (f.sort === "title") {
    const compare = collator();
    return kept.sort(
      (a, b) => compare.compare(a.title, b.title) || b.updatedAt - a.updatedAt,
    );
  }
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
 * One page's rows, with the day heading each run starts with when the order is by time. Each page
 * starts its own headings: page 2 opening on today's says 今天 again.
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
  const sections: { group: DayGroup | null; items: ArtifactView[] }[] = [];
  for (const a of items) {
    const group = grouped ? dayGroup(timeOf(a, f.sort), now) : null;
    const last = sections.at(-1);
    if (last && last.group === group) last.items.push(a);
    else sections.push({ group, items: [a] });
  }
  return {
    page,
    pages,
    first: list.length === 0 ? 0 : start + 1,
    last: start + items.length,
    sections,
  };
}

/** The page buttons: the first, the last, the current one and its neighbours; gaps become "…". */
export function pageWindow(
  page: number,
  pages: number,
): (number | `gap-${number}`)[] {
  if (pages <= 7) return Array.from({ length: pages }, (_, i) => i + 1);
  const shown = new Set([1, 2, page - 1, page, page + 1, pages - 1, pages]);
  const out: (number | `gap-${number}`)[] = [];
  let previous = 0;
  for (let p = 1; p <= pages; p++) {
    if (!shown.has(p)) continue;
    if (p - previous > 1) out.push(`gap-${previous}`);
    out.push(p);
    previous = p;
  }
  return out;
}

/**
 * The tab's filters and page, for one group at a time: they survive a trip to another tab (which
 * unmounts this one) and are dropped for another group. Not in the link, not in storage.
 */
const useFilterStore = create<{
  groupId: string | undefined;
  filters: ArtifactFilters;
  set: (groupId: string, patch: Partial<ArtifactFilters>) => void;
}>()((set) => ({
  groupId: undefined,
  filters: defaultFilters,
  set: (groupId, patch) =>
    set((state) => ({
      groupId,
      filters: {
        ...(state.groupId === groupId ? state.filters : defaultFilters),
        ...patch,
      },
    })),
}));

/** For tests: forget whatever the last group left. */
export const resetArtifactFilters = () =>
  useFilterStore.setState({ groupId: undefined, filters: defaultFilters });

export function useArtifactFilters(groupId: string) {
  const stored = useFilterStore((s) =>
    s.groupId === groupId ? s.filters : defaultFilters,
  );
  const set = useFilterStore((s) => s.set);
  // Anything but turning the page starts again from the first one.
  const update = (patch: Partial<ArtifactFilters>) =>
    set(groupId, { page: 1, ...patch });
  return [stored, update] as const;
}

/** A group's artifacts, newest version first, as every list of them starts. */
export function useGroupArtifacts(groupId: string | undefined) {
  const { artifacts, loaded } = useArtifacts();
  // Whoever lists the open group's artifacts (the panel's tab bar always does) is what notices the
  // group changed, so the Artifacts tab's filters are dropped even while that tab is closed.
  useEffect(() => {
    if (groupId === undefined) return;
    if (useFilterStore.getState().groupId !== groupId)
      useFilterStore.setState({ groupId, filters: defaultFilters });
  }, [groupId]);
  return {
    loaded,
    artifacts:
      groupId === undefined
        ? []
        : artifacts.filter((a) => a.conversationId === groupId),
  };
}

/** The most recently updated few, for the context tab: the same order whatever the tab's filters. */
export const recentArtifacts = (
  artifacts: readonly ArtifactView[],
  count: number,
) => [...artifacts].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, count);
