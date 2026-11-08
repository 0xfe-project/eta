import { windowStart } from "./list-window";

/** The most rows a completion menu draws, the lines for more included. */
export const MENU_ROWS = 8;

/** Fewer rows than this leave no room for a line for more beside the selected entry. */
const ROWS_FOR_MORE_LINES = 3;

/** Which entries a menu shows, and the counts its lines for more say; 0 where it draws no such line. */
export interface MenuWindow {
  /** The first entry shown. */
  start: number;
  /** One past the last entry shown. */
  end: number;
  above: number;
  below: number;
}

/**
 * The window of a menu of `count` entries drawn in at most `rows` rows. When the entries do not
 * all fit, a line above and a line below say how many entries they hide, each taking one of the
 * rows; the selected entry stays in the middle of the rest once the list scrolls. Under three
 * rows there are no such lines.
 */
export function menuWindow({
  count,
  selected,
  rows,
}: {
  count: number;
  selected: number;
  rows: number;
}): MenuWindow {
  const height = Math.max(1, rows);
  if (count <= height) return { start: 0, end: count, above: 0, below: 0 };
  if (height < ROWS_FOR_MORE_LINES) {
    const start = windowStart(selected, count, height);
    return { start, end: start + height, above: 0, below: 0 };
  }
  // A page at either end has one line for more; a page between them has two.
  const endPage = height - 1;
  const middlePage = height - 2;
  const start = selected - Math.floor(middlePage / 2);
  if (start < 1)
    return { start: 0, end: endPage, above: 0, below: count - endPage };
  if (start + middlePage > count - 1) {
    const bottom = count - endPage;
    return { start: bottom, end: count, above: bottom, below: 0 };
  }
  const end = start + middlePage;
  return { start, end, above: start, below: count - end };
}
