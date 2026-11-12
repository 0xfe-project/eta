/** The lines of a reply's frame: the edges drawn around a line's content, coloured. */
import type { FrameStyle } from "../contract";
import stringWidth from "string-width";
import { truncateToWidth } from "../../../ui/text-width";

/** Which line of a frame a line is: the top edge with the name, a line of content, the bottom edge. */
export type FrameEdge = "top" | "side" | "bottom";

/** How one line of the transcript is framed. */
export interface LineFrame {
  edge: FrameEdge;
  style: FrameStyle;
  /** Columns of `fill` between the content and the closing corner or bar. */
  fill: number;
}

interface EdgeParts {
  start: string;
  /** Between the content and the fill. */
  gap: string;
  fill: string;
  end: string;
}

// The top edge is `╭─ name ─…─╮`, a line of content `│ content … │`, the bottom edge `╰─…─╯`;
// each is `start`, the content, `gap`, `fill` repeated, `end`.
const EDGES: Record<FrameEdge, EdgeParts> = {
  top: { start: "╭─ ", gap: " ", fill: "─", end: "╮" },
  side: { start: "│ ", gap: "", fill: " ", end: " │" },
  bottom: { start: "╰─", gap: "", fill: "─", end: "─╯" },
};

/** Columns the top edge takes besides the name: `╭─ `, the gap and at least one `─`, `╮`. */
const TOP_CHROME = 6;

/** The name as the top edge of a frame `width` wide shows it, cut to fit. */
export function frameName(style: FrameStyle, width: number): string {
  return truncateToWidth(style.name, Math.max(1, width - TOP_CHROME));
}

/** The frame of a line whose content (without colours) is `plain`, in a frame `width` wide. */
export function lineFrame(
  edge: FrameEdge,
  style: FrameStyle,
  plain: string,
  width: number,
): LineFrame {
  const parts = EDGES[edge];
  const chrome = stringWidth(parts.start + parts.gap + parts.end);
  return {
    edge,
    style,
    fill: Math.max(0, width - chrome - stringWidth(plain)),
  };
}

/** The line around `content` (coloured, its plain text not empty), as the terminal shows it. */
export function framedLine(frame: LineFrame, content: string): string {
  return frameStart(frame) + content + frameEnd(frame);
}

/** A framed line without content, as one coloured run. */
export function emptyFramedLine(frame: LineFrame): string {
  const parts = EDGES[frame.edge];
  return painted(frame, parts.start + afterContent(frame));
}

/** The frame in front of the content, coloured. */
export function frameStart(frame: LineFrame): string {
  return painted(frame, EDGES[frame.edge].start);
}

/** The frame after the content, coloured. */
export function frameEnd(frame: LineFrame): string {
  return painted(frame, afterContent(frame));
}

/**
 * The frame after a line without content, split into its first cell (where a selection marks the
 * line) and the rest, both coloured.
 */
export function frameEndCells(frame: LineFrame): {
  first: string;
  rest: string;
} {
  const after = afterContent(frame);
  return {
    first: painted(frame, after.slice(0, 1)),
    rest: painted(frame, after.slice(1)),
  };
}

/** The name in its own colour and weight. */
export function paintedName(frame: LineFrame, name: string): string {
  const { open, close } = frame.style.nameStyle;
  return open + name + close;
}

function afterContent(frame: LineFrame): string {
  const parts = EDGES[frame.edge];
  return parts.gap + parts.fill.repeat(frame.fill) + parts.end;
}

function painted(frame: LineFrame, text: string): string {
  const { open, close } = frame.style.border;
  return open + text + close;
}
