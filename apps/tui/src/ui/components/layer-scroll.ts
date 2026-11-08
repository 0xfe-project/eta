/**
 * The first content row a layer shows after scrolling `delta` rows (negative is up) from `top`,
 * when `hidden` rows of its content do not fit: never above the first row, never past the point
 * where the last row reaches the bottom. A `top` past the end, left by content that got shorter,
 * comes back to the end.
 */
export function scrolledTop(
  top: number,
  delta: number,
  hidden: number,
): number {
  const end = Math.max(0, hidden);
  return Math.max(0, Math.min(Math.min(top, end) + delta, end));
}
