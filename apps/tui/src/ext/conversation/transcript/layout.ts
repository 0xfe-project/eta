import type { FrameStyle, RenderedItem, TranscriptItem } from "../contract";
import type { LineFrame } from "./frame-lines";
import stringWidth from "string-width";
import { truncateToWidth } from "../../../ui/text-width";
import {
  emptyFramedLine,
  framedLine,
  frameName,
  lineFrame,
  paintedName,
} from "./frame-lines";
import { FRAME_INSET, frameOwners, shownOwners } from "./frames";

/** The transcript as one column of lines. */
export interface TranscriptLayout {
  /** As the terminal shows them, colours and frames included. */
  lines: string[];
  /**
   * Without colours and without frames, for search and for copying lines; same length as `lines`.
   * A frame's top edge is the author's name, its bottom edge an empty line.
   */
  plain: string[];
  /** For each line, how it is framed; undefined outside a frame. Same length as `lines`. */
  frames: (LineFrame | undefined)[];
  /** For each line, the index of the item it belongs to; -1 for a blank line between items. */
  owner: number[];
  /** For each item, the index of its first line. */
  starts: number[];
  /** For each item, how many lines it draws. */
  counts: number[];
  /** For each item, its key. */
  keys: string[];
  /**
   * Each item's index by its key. A step folded into a reply's steps line, and so not an item
   * here, has that line's index: a place in the step lands on the line.
   */
  indexOf: ReadonlyMap<string, number>;
}

/**
 * The items' drawn lines one after another, a blank line between neighbours. An author's name sits
 * right on top of the reply it names, so no blank line follows an author whose reply has items.
 *
 * `width` is the width the items were drawn for (`drawWidths`). From 40 columns each group reply is
 * framed (see `frames.ts`): the author's line becomes the frame's top edge, and the bottom edge is
 * one more line of the reply's last item. A line wider than the inside of the frame is cut to fit,
 * without its colours. Below 40 columns the author's own lines show and nothing is framed.
 * Throws when an author is drawn without a frame style, which `RenderItem` does not allow.
 */
export function layoutTranscript(
  items: readonly TranscriptItem[],
  rendered: readonly RenderedItem[],
  width: number,
): TranscriptLayout {
  const indexOf = new Map<string, number>();
  const layout: TranscriptLayout = {
    lines: [],
    plain: [],
    frames: [],
    owner: [],
    starts: [],
    counts: [],
    keys: [],
    indexOf,
  };
  const push = (
    line: string,
    plain: string,
    owner: number,
    frame?: LineFrame,
  ) => {
    layout.lines.push(line);
    layout.plain.push(plain);
    layout.frames.push(frame);
    layout.owner.push(owner);
  };
  const replies = frameOwners(items);
  const owners = shownOwners(replies, width);
  items.forEach((item, index) => {
    const owner = owners[index]!;
    const style = owner < 0 ? undefined : styleOf(rendered, owner);
    const previous = items[index - 1];
    const underItsAuthor =
      previous?.kind === "author" && replies[index] === index - 1;
    if (previous !== undefined && !underItsAuthor) {
      if (style !== undefined && owners[index - 1] === owner) {
        const frame = lineFrame("side", style, "", width);
        push(emptyFramedLine(frame), "", -1, frame);
      } else push("", "", -1);
    }
    const drawn = rendered[index];
    layout.starts.push(layout.lines.length);
    layout.keys.push(item.key);
    indexOf.set(item.key, index);
    if (style !== undefined && item.kind === "author") {
      const name = frameName(style, width);
      const frame = lineFrame("top", style, name, width);
      push(framedLine(frame, paintedName(frame, name)), name, index, frame);
    } else if (style !== undefined && drawn !== undefined) {
      const framed = framedLines(drawn, style, width);
      framed.lines.forEach((line, at) =>
        push(line, framed.plain[at]!, index, framed.frames[at]),
      );
    } else if (drawn !== undefined) {
      drawn.lines.forEach((line, at) => push(line, drawn.plain[at]!, index));
    }
    if (style !== undefined && owners[index + 1] !== owner) {
      const frame = lineFrame("bottom", style, "", width);
      push(emptyFramedLine(frame), "", index, frame);
    }
    layout.counts.push(layout.lines.length - layout.starts[index]!);
  });
  items.forEach((item, index) => {
    if (item.kind !== "steps") return;
    for (const step of item.steps)
      if (!indexOf.has(step.key)) indexOf.set(step.key, index);
  });
  return layout;
}

/** The frame style of the author at `owner`, which every author's drawing has (`AuthorDrawing`). */
function styleOf(rendered: readonly RenderedItem[], owner: number): FrameStyle {
  const style = rendered[owner]?.frame;
  if (style === undefined)
    throw new Error(`the author drawn at ${owner} has no frame style`);
  return style;
}

interface FramedLines {
  lines: string[];
  /** The content of each line as it shows, cut where it did not fit. */
  plain: string[];
  frames: LineFrame[];
}

// An item's framed lines, kept with its drawing: while the drawing is the same object, a new layout
// (another item streaming, the frame's bottom edge moving) frames it without measuring it again.
const framedCache = new WeakMap<
  RenderedItem,
  { style: FrameStyle; width: number; framed: FramedLines }
>();

function framedLines(
  drawn: RenderedItem,
  style: FrameStyle,
  width: number,
): FramedLines {
  const kept = framedCache.get(drawn);
  if (kept !== undefined && kept.style === style && kept.width === width)
    return kept.framed;
  const inside = width - FRAME_INSET;
  const lines: string[] = [];
  const plain: string[] = [];
  const frames: LineFrame[] = [];
  drawn.plain.forEach((text, at) => {
    const fits = stringWidth(text) <= inside;
    const shown = fits ? text : truncateToWidth(text, inside);
    const frame = lineFrame("side", style, shown, width);
    plain.push(shown);
    frames.push(frame);
    if (shown === "") lines.push(emptyFramedLine(frame));
    else lines.push(framedLine(frame, fits ? drawn.lines[at]! : shown));
  });
  const framed = { lines, plain, frames };
  framedCache.set(drawn, { style, width, framed });
  return framed;
}
