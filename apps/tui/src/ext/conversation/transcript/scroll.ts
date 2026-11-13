// `height` throughout is the rows the transcript's lines share with the hint back to the bottom: while
// the view follows the newest line every row is a line, otherwise the last row is the hint.

/** Pinned to the newest line, or showing from line `top` (0 is the oldest line loaded). */
export type LineScroll = { follow: true } | { follow: false; top: number };

/** What is on screen. */
export interface Viewport {
  /** The first line shown. */
  top: number;
  /** How many lines are shown. */
  rows: number;
  /** How many lines are under the last one shown. */
  below: number;
  following: boolean;
}

const FOLLOW: LineScroll = { follow: true };

/** Rows left for lines while the view does not follow. */
function rowsAway(height: number): number {
  return Math.max(0, height - 1);
}

/** The top of a view that follows. */
function followTop(total: number, height: number): number {
  return Math.max(0, total - height);
}

/**
 * The scroll with its top inside the lines. A top at or under the one a following view has follows
 * again: there the following view shows every line the view away would, and the last line too,
 * which the hint row would cover.
 */
export function normalized(
  scroll: LineScroll,
  total: number,
  height: number,
): LineScroll {
  if (scroll.follow) return scroll;
  const top = Math.max(0, scroll.top);
  if (top >= followTop(total, height)) return FOLLOW;
  return top === scroll.top ? scroll : { follow: false, top };
}

export function viewportOf(
  scroll: LineScroll,
  total: number,
  height: number,
): Viewport {
  const settled = normalized(scroll, total, height);
  if (settled.follow) {
    const top = followTop(total, height);
    return {
      top,
      rows: Math.min(height, total - top),
      below: 0,
      following: true,
    };
  }
  const rows = rowsAway(height);
  return {
    top: settled.top,
    rows,
    below: total - settled.top - rows,
    following: false,
  };
}

/** One page: the view less one line, so the line at the edge stays in sight. */
export function pageSize(height: number): number {
  return Math.max(1, height - 1);
}

/** The view showing from line `top`. */
export function scrolledTo(
  top: number,
  total: number,
  height: number,
): LineScroll {
  return normalized({ follow: false, top }, total, height);
}

/** Moved `delta` lines (negative is up). A view that cannot move stays as it is. */
export function scrolledBy(
  scroll: LineScroll,
  delta: number,
  total: number,
  height: number,
): LineScroll {
  const { top } = viewportOf(scroll, total, height);
  const next = Math.max(0, top + delta);
  if (next === top) return scroll;
  return scrolledTo(next, total, height);
}

/** The least scrolling that puts `line` on screen. */
export function revealLine(
  scroll: LineScroll,
  line: number,
  total: number,
  height: number,
): LineScroll {
  const view = viewportOf(scroll, total, height);
  if (line >= view.top && line < view.top + view.rows) return scroll;
  const rows = rowsAway(height);
  const top = line < view.top ? line : line - rows + 1;
  return scrolledTo(top, total, height);
}
