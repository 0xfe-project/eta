/**
 * The first row to show of `count` rows when `height` fit, keeping the row at `cursor` in view,
 * near the middle once the list scrolls.
 */
export function windowStart(
  cursor: number,
  count: number,
  height: number,
): number {
  if (count <= height) return 0;
  const centred = cursor - Math.floor(height / 2);
  return Math.max(0, Math.min(centred, count - height));
}
