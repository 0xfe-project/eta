/** Keeping an item's object while it stays the same, so the drawing cache can keep its drawing. */
import type { TranscriptItem } from "./contract";
import { isDeepStrictEqual } from "node:util";

/**
 * A function that hands its items back with each one replaced by the object it gave last time
 * under the same key, when the two are equal in every field. The transcript is rebuilt from the
 * rows on every change, so without this every item would be a new object each time.
 */
export function createItemKeeper(): (
  items: readonly TranscriptItem[],
) => readonly TranscriptItem[] {
  let kept = new Map<string, TranscriptItem>();
  return (items) => {
    const next = items.map((item) => {
      const before = kept.get(item.key);
      return before !== undefined && isDeepStrictEqual(before, item)
        ? before
        : item;
    });
    kept = new Map(next.map((item) => [item.key, item]));
    return next;
  };
}
