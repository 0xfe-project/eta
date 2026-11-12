// How tall a layer may be, for the parts of a layer that size themselves: the rows the shell
// gives the layer, and the rows a layer frame's content leaves free. And how a part with a
// cursor tells the frame where the cursor is.

import type { DOMElement } from "ink";
import type { RefObject } from "react";
import { createContext, use, useEffect, useRef } from "react";

/**
 * Rows of a `LayerFrame` that are not its content: the border above and below, the title, the
 * hint row under the title, the hint row above the footer, and the footer.
 */
export const FRAME_ROWS = 6;

/**
 * True inside the shell's layer area, where a `LayerFrame` is as tall as its content but never
 * taller than the room it is given, and scrolls content taller than that; elsewhere a frame is as
 * tall as its content.
 */
export const LayerAreaContext = createContext(false);

/**
 * The rows of the screen an open layer may take, as the shell laid them out; undefined outside a
 * layer and before the first layout.
 */
export const LayerRowsContext = createContext<number | undefined>(undefined);

/** The rows of the screen an open layer may take; undefined outside a layer and before layout. */
export function useLayerRows(): number | undefined {
  return use(LayerRowsContext);
}

/** Where a cursor is: `rows` rows starting `offset` rows below the top of `node`. */
export interface CursorPlace {
  node: DOMElement | null;
  offset: number;
  rows: number;
  /** Which item the cursor is on; a move to another item shows it even at the same place. */
  cursor: number;
}

/** What a layer frame tells the lists inside it. */
export interface LayerSpace {
  /**
   * Rows the frame's content, as last laid out, leaves free in the tallest frame the room allows;
   * negative when the content is that many rows taller. Undefined before the first layout.
   */
  spare: number | undefined;
  /** How many lists share `spare`. */
  lists: number;
  /** Counts a list among those sharing `spare` until the returned function is called. */
  join: () => () => void;
  /** Whether the frame's content is taller than the frame, so the frame scrolls. */
  scrolls: boolean;
  /**
   * Marks the frame as holding a cursor until the returned function is called: ↑ ↓ and the wheel
   * are the cursor's then, and the frame scrolls only on PageUp and PageDown.
   */
  holdCursor: () => () => void;
  /**
   * Scrolls the frame to show the cursor, when it moved or its rows did since the last time;
   * otherwise leaves the frame alone, so PageUp and PageDown can move away from it.
   */
  reveal: (place: CursorPlace) => void;
  /** Whether the cursor's first row shows, as of the last scroll. */
  cursorInView: () => boolean;
  /** Scrolls the frame to show the cursor. */
  showCursor: () => void;
}

export const LayerSpaceContext = createContext<LayerSpace | undefined>(
  undefined,
);

/** Rows a kit list draws above and below its window to say how many more there are. */
const KIT_HINT_ROWS = 2;

export interface ListFit {
  /** How many items the list shows at a time. */
  height: number;
  /** Tells the fit how many rows the list drew in this render, hint rows included. */
  drew: (rows: number) => void;
}

/**
 * How many of `count` items a list shows at a time: `preferred`, or fewer when the layer frame it
 * is in has not got the rows, so the frame's content fits without scrolling. `hintRows` is how
 * many rows the list adds when not every item shows. Outside a layer frame it is `preferred`.
 * The list reports each render's drawn rows through `drew`. Lists in one frame share its free
 * rows.
 */
export function useListFit(
  count: number,
  preferred: number,
  hintRows = KIT_HINT_ROWS,
): ListFit {
  const space = use(LayerSpaceContext);
  const drawnRef = useRef<number | undefined>(undefined);
  const join = space?.join;
  useEffect(() => join?.(), [join]);
  const drew = (rows: number) => {
    drawnRef.current = rows;
  };
  const drawn = drawnRef.current;
  if (space?.spare === undefined || drawn === undefined)
    return { height: preferred, drew };
  // Several lists in one frame share the free rows, rounding down so together they never take
  // more than there is.
  const room = drawn + Math.floor(space.spare / Math.max(1, space.lists));
  if (count <= room && count <= preferred) return { height: preferred, drew };
  return { height: Math.max(1, Math.min(preferred, room - hintRows)), drew };
}

export interface LayerCursor {
  /** Goes on the box the cursor's rows are counted from. */
  ref: RefObject<DOMElement | null>;
  /** True while PageUp and PageDown are the frame's: its content is taller than it. */
  framePages: boolean;
  /**
   * Called on Enter or Space before acting on it: true when the cursor shows and the key may act;
   * false when PageUp or PageDown took it out of view, after scrolling it back, and this key does
   * nothing.
   */
  takeAction: () => boolean;
}

/**
 * For a part of a layer that moves a cursor on ↑ ↓: the layer frame it is in leaves those keys and
 * the wheel to it, and scrolls to show the cursor each time it moves. `cursor` is the item the
 * cursor is on; its rows are `rows` rows starting `offset` rows below the top of the box `ref` goes
 * on. While `framePages` is true the part leaves PageUp and PageDown alone. On Enter or Space the
 * part acts only when `takeAction()` is true. Outside a layer frame it does nothing.
 */
export function useLayerCursor(
  cursor: number,
  offset: number,
  rows = 1,
): LayerCursor {
  const space = use(LayerSpaceContext);
  const ref = useRef<DOMElement>(null);
  const holdCursor = space?.holdCursor;
  useEffect(() => holdCursor?.(), [holdCursor]);
  const reveal = space?.reveal;
  // After every render: the cursor moves with the part's own state.
  useEffect(() => {
    reveal?.({ node: ref.current, offset, rows, cursor });
  });
  const takeAction = () => {
    if (space === undefined || space.cursorInView()) return true;
    space.showCursor();
    return false;
  };
  return { ref, framePages: space?.scrolls ?? false, takeAction };
}

/**
 * Where a part with a cursor puts its `takeAction`, for a layer that handles Enter or Space
 * outside the frame (the frame's context does not reach it) to ask before acting.
 */
export type ActionGate = RefObject<(() => boolean) | undefined>;

/** A gate for a layer to hand to its cursor part; empty until the part fills it. */
export function useActionGate(): ActionGate {
  return useRef<() => boolean>(undefined);
}

/** Whether an Enter or Space may act: true when nothing filled the gate. */
export function gateAllows(gate: ActionGate | undefined): boolean {
  return gate?.current?.() !== false;
}
