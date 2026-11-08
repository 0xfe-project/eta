import type { RenderedItem, TranscriptItem } from "../contract";

/** The transcript as one column of lines. */
export interface TranscriptLayout {
  /** As the terminal shows them, colours included. */
  lines: string[];
  /** Without colours; same length as `lines`. */
  plain: string[];
  /** For each line, the index of the item it belongs to; -1 for a blank line between items. */
  owner: number[];
  /** For each item, the index of its first line. */
  starts: number[];
  /** For each item, how many lines it draws. */
  counts: number[];
  /** For each item, its key. */
  keys: string[];
  /** Each item's index by its key. */
  indexOf: ReadonlyMap<string, number>;
}

/**
 * The items' drawn lines one after another, a blank line between neighbours. An author's name sits
 * right on top of the reply it names, so no blank line follows an author.
 */
export function layoutTranscript(
  items: readonly TranscriptItem[],
  rendered: readonly RenderedItem[],
): TranscriptLayout {
  const indexOf = new Map<string, number>();
  const layout: TranscriptLayout = {
    lines: [],
    plain: [],
    owner: [],
    starts: [],
    counts: [],
    keys: [],
    indexOf,
  };
  items.forEach((item, index) => {
    const previous = items[index - 1];
    if (previous !== undefined && previous.kind !== "author") {
      layout.lines.push("");
      layout.plain.push("");
      layout.owner.push(-1);
    }
    const drawn = rendered[index];
    layout.starts.push(layout.lines.length);
    layout.counts.push(drawn?.lines.length ?? 0);
    layout.keys.push(item.key);
    indexOf.set(item.key, index);
    if (drawn === undefined) return;
    layout.lines.push(...drawn.lines);
    layout.plain.push(...drawn.plain);
    for (let line = 0; line < drawn.lines.length; line += 1)
      layout.owner.push(index);
  });
  return layout;
}
