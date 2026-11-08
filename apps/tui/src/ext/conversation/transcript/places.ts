import type { TranscriptLayout } from "./layout";
import type { LineScroll } from "./scroll";
import type { LinePlace, ScrollState } from "./ui";

const FOLLOW = { follow: true } as const;

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}

/**
 * The place of line `line`: the item it belongs to and how far into it. A blank line between two
 * items is offset -1 of the item under it.
 */
export function placeOfLine(layout: TranscriptLayout, line: number): LinePlace {
  const total = layout.lines.length;
  if (total === 0) return { key: "", offset: 0, line: 0 };
  const at = clamp(line, 0, total - 1);
  const owner = layout.owner[at]!;
  if (owner >= 0)
    return {
      key: layout.keys[owner]!,
      offset: at - layout.starts[owner]!,
      line: at,
    };
  const below = layout.owner[at + 1] ?? -1;
  return below < 0
    ? { key: "", offset: 0, line: at }
    : { key: layout.keys[below]!, offset: -1, line: at };
}

/**
 * The line a place names in this layout. An offset past the item's lines is its last line. An item
 * no longer there hands over to the item of its row nearest the place's `line`, as far into it; with
 * no item of its row left, the place's `line` stands.
 */
export function lineOfPlace(
  layout: TranscriptLayout,
  place: LinePlace,
): number {
  const total = layout.lines.length;
  if (total === 0) return 0;
  const index = layout.indexOf.get(place.key) ?? nearestOfRow(layout, place);
  if (index === undefined) return clamp(place.line, 0, total - 1);
  return lineInItem(layout, index, place.offset);
}

/**
 * `place` named in this layout. While its item is there only `line` follows it, so `line` is always
 * from the latest layout that had the item. Once the item is gone, the place becomes the line
 * `lineOfPlace` gives, named by the item there now.
 */
export function placeIn(layout: TranscriptLayout, place: LinePlace): LinePlace {
  if (layout.lines.length === 0) return place;
  const line = lineOfPlace(layout, place);
  if (!layout.indexOf.has(place.key)) return placeOfLine(layout, line);
  return line === place.line ? place : { ...place, line };
}

/** `offset` lines into item `index`, kept between the blank line over it and its last line. */
function lineInItem(
  layout: TranscriptLayout,
  index: number,
  offset: number,
): number {
  const start = layout.starts[index]!;
  const blankAbove = layout.owner[start - 1] === -1;
  const first = blankAbove ? start - 1 : start;
  const last = start + Math.max(1, layout.counts[index]!) - 1;
  return clamp(clamp(start + offset, first, last), 0, layout.lines.length - 1);
}

/**
 * The row an item comes from, as `model/items.ts` keys items: the row id alone, or the row id
 * before a colon and what the item is in the row.
 */
function rowOfKey(key: string): string {
  const colon = key.indexOf(":");
  return colon < 0 ? key : key.slice(0, colon);
}

/** The index of the item of `place`'s row whose lines are nearest the place's `line`. */
function nearestOfRow(
  layout: TranscriptLayout,
  place: LinePlace,
): number | undefined {
  const row = rowOfKey(place.key);
  let nearest: number | undefined;
  let nearestDistance = Infinity;
  layout.keys.forEach((key, index) => {
    if (rowOfKey(key) !== row) return;
    const start = layout.starts[index]!;
    const last = start + Math.max(1, layout.counts[index]!) - 1;
    const distance = Math.max(start - place.line, place.line - last, 0);
    if (distance < nearestDistance) {
      nearest = index;
      nearestDistance = distance;
    }
  });
  return nearest;
}

/** The scroll as a line number in this layout. */
export function scrollLine(
  layout: TranscriptLayout,
  scroll: ScrollState,
): LineScroll {
  return scroll.follow
    ? FOLLOW
    : { follow: false, top: lineOfPlace(layout, scroll.top) };
}

/** A line-number scroll named by the line it shows first, to keep across changes to the layout. */
export function scrollPlace(
  layout: TranscriptLayout,
  scroll: LineScroll,
): ScrollState {
  return scroll.follow
    ? FOLLOW
    : { follow: false, top: placeOfLine(layout, scroll.top) };
}

/** The scroll with its top named in this layout (`placeIn`); the same object when nothing moved. */
export function scrollIn(
  layout: TranscriptLayout,
  scroll: ScrollState,
): ScrollState {
  if (scroll.follow) return scroll;
  const top = placeIn(layout, scroll.top);
  return top === scroll.top ? scroll : { follow: false, top };
}
