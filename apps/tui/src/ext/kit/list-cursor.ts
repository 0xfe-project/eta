// The marker and the visible window shared by PickList and CheckList.

import type { Key } from "ink";
import { useRef, useState } from "react";

/** One row of a list. */
export interface PickItem {
  key: string;
  label: string;
  /** Drawn after the label, dimmed. */
  hint?: string;
  /** Shown but cannot be picked or ticked. */
  disabled?: boolean;
  /** A short mark at the end of the row, such as "current". */
  tag?: string;
}

export const DEFAULT_HEIGHT = 10;

/** Two or more Spaces and Enters and nothing else: keys Ink read together as one input. */
const SPACES_AND_ENTERS = /^[ \r]{2,}$/;

/**
 * The keys in one input of Ink's. Ink hands a run of plain characters read together as one input
 * (two quick Spaces arrive as "  ", Space then Enter as " \r"); a run of only Spaces and Enters
 * is split into one key per character, in order. Any other input is one key, as it came.
 */
export function separateKeys(input: string, key: Key): [string, Key][] {
  if (!SPACES_AND_ENTERS.test(input)) return [[input, key]];
  return [...input].map((char) => [char, { ...key, return: char === "\r" }]);
}

/**
 * The first visible row: the previous one, moved just enough to show `index`, and never past the
 * point where the last page would be short.
 */
export function windowStart(
  previous: number,
  index: number,
  height: number,
  count: number,
): number {
  let start = previous;
  if (index < start) start = index;
  if (index >= start + height) start = index - height + 1;
  return Math.max(0, Math.min(start, count - height));
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

interface CursorState {
  key: string | undefined;
  /** Where the marked item was: where the marker stays when that item leaves the list. */
  index: number;
  start: number;
}

export interface ListCursor {
  /** The marked row; -1 when the list is empty. */
  index: number;
  markedKey: string | undefined;
  /** The first visible row. */
  start: number;
  /** Moves the marker for ↑ ↓ PageUp PageDown Home End; false for any other key. */
  move: (key: Key) => boolean;
  /**
   * The marker as of the last move, also one made since the last render: what a key read in the
   * same input as a move (Enter after ↓) must act on.
   */
  current: () => { index: number; markedKey: string | undefined };
}

/** Where the marker is and which rows show. The marker follows its item when the list changes. */
export function useListCursor(
  items: readonly PickItem[],
  height: number,
  initialKey: string | undefined,
): ListCursor {
  const [state, setState] = useState<CursorState>(() => {
    const found = items.findIndex((item) => item.key === initialKey);
    const index = Math.max(0, found);
    // An initial item not in the list yet (a live list still arriving) is looked for again on
    // each render until the user moves.
    const key =
      found >= 0 || initialKey === undefined ? items[index]?.key : undefined;
    return { key, index, start: windowStart(0, index, height, items.length) };
  });
  const count = items.length;
  const wantedKey = state.key ?? initialKey;
  const found = items.findIndex((item) => item.key === wantedKey);
  const index =
    count === 0 ? -1 : found >= 0 ? found : clamp(state.index, 0, count - 1);
  const start = windowStart(state.start, Math.max(0, index), height, count);
  // Ink hands every key of one read to the handlers before React renders again, so a later key
  // of the same read must see the moves before it here, not in this render's values.
  const latestRef = useRef<CursorState>({
    key: items[index]?.key,
    index,
    start,
  });
  latestRef.current = { key: items[index]?.key, index, start };

  const target = (key: Key, from: number): number | undefined => {
    if (key.upArrow) return from - 1;
    if (key.downArrow) return from + 1;
    if (key.pageUp) return from - height;
    if (key.pageDown) return from + height;
    if (key.home) return 0;
    if (key.end) return count - 1;
    return undefined;
  };

  const move = (key: Key): boolean => {
    const from = latestRef.current;
    const wanted = target(key, from.index);
    if (wanted === undefined) return false;
    if (count === 0) return true;
    const next = clamp(wanted, 0, count - 1);
    const moved: CursorState = {
      key: items[next]?.key,
      index: next,
      start: windowStart(from.start, next, height, count),
    };
    latestRef.current = moved;
    setState(moved);
    return true;
  };

  const current = () => ({
    index: latestRef.current.index,
    markedKey: latestRef.current.key,
  });

  return { index, markedKey: items[index]?.key, start, move, current };
}
