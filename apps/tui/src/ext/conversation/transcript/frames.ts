/**
 * Which items a group reply's frame holds, and the width they are drawn at inside it. A frame
 * starts at an author item and holds the items of the same timeline row after it.
 */
import type { TranscriptItem } from "../contract";
import { rowOfKey } from "../model/items";

/** Below this many columns no reply is framed. */
export const FRAME_MIN_WIDTH = 40;
/** Columns a frame takes from its items: a bar and a space on either side. */
export const FRAME_INSET = 4;

export function framesShown(width: number): boolean {
  return width >= FRAME_MIN_WIDTH;
}

/**
 * For each item, the index of the author item whose frame it is in (the author's own index for
 * the author), or -1 for an item in no frame.
 */
export function frameOwners(items: readonly TranscriptItem[]): number[] {
  let owner = -1;
  let row = "";
  return items.map((item, index) => {
    if (item.kind === "author") {
      owner = index;
      row = rowOfKey(item.key);
    } else if (owner >= 0 && rowOfKey(item.key) !== row) owner = -1;
    return owner;
  });
}

/** `frameOwners` where the transcript is `width` wide: every item in no frame below 40 columns. */
export function framedOwners(
  items: readonly TranscriptItem[],
  width: number,
): readonly number[] {
  return shownOwners(frameOwners(items), width);
}

/** `owners` (as `frameOwners` gives them) as they show at `width`. */
export function shownOwners(
  owners: readonly number[],
  width: number,
): readonly number[] {
  return framesShown(width) ? owners : owners.map(() => -1);
}

/**
 * The columns each item is drawn in when the transcript is `width` wide: an item inside a frame
 * gets the width inside it, an author and an item in no frame the whole width.
 */
export function drawWidths(
  items: readonly TranscriptItem[],
  width: number,
): number[] {
  const owners = framedOwners(items, width);
  return items.map((item, index) =>
    owners[index]! >= 0 && item.kind !== "author" ? width - FRAME_INSET : width,
  );
}
