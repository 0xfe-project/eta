/** What the transcript remembers between visits: where it was scrolled, what is unfolded, the search. */

/**
 * A line named by the item it belongs to, so it stays in that item while lines come and go around
 * it (an older page on top, an item unfolding, a new width): `offset` lines below the item's first
 * line, -1 being the blank line over the item. At a new width the item wraps anew, so the same
 * offset may fall on other words of it. `line` is the line number in the latest layout that had the
 * item, which `lineOfPlace` falls back on once the item and its row are gone.
 */
export interface LinePlace {
  key: string;
  offset: number;
  line: number;
}

/** Pinned to the newest line, or showing from the line `top` names. */
export type ScrollState = { follow: true } | { follow: false; top: LinePlace };

/** A match of the search, by the line it is on and where it starts there (UTF-16). */
export interface MatchPlace {
  place: LinePlace;
  start: number;
}

export interface SearchState {
  query: string;
  /** The current match; undefined when there are none. */
  current: MatchPlace | undefined;
}

export interface TranscriptUi {
  scroll: ScrollState;
  /** Keys of the items whose fold differs from `expandAll`. */
  expanded: ReadonlySet<string>;
  expandAll: boolean;
  /** Undefined while the search bar is closed. */
  search: SearchState | undefined;
}

export const INITIAL_TRANSCRIPT_UI: TranscriptUi = {
  scroll: { follow: true },
  expanded: new Set(),
  expandAll: false,
  search: undefined,
};

/** An item is unfolded when exactly one of `expandAll` and its own toggle says so. */
export function isExpanded(
  ui: Pick<TranscriptUi, "expanded" | "expandAll">,
  key: string,
): boolean {
  return ui.expandAll !== ui.expanded.has(key);
}

/** `expanded` with one item's toggle flipped. */
export function toggledExpanded(
  expanded: ReadonlySet<string>,
  key: string,
): ReadonlySet<string> {
  const next = new Set(expanded);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}
