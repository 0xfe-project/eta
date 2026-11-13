import type { DOMElement } from "ink";
import type { ReactNode, RefObject } from "react";
import type { CursorPlace, LayerSpace } from "./layer-space";
import { Box, measureElement, Text, useBoxMetrics, useInput } from "ink";
import { use, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  LINES_PER_WHEEL_STEP,
  useInputActive,
  useTheme,
  useWheel,
} from "../../extensions/react";
import { useMessages } from "../../i18n/react";
import { inkColor } from "../theme";
import { layerMessages } from "./layer-messages";
import { scrolledTop } from "./layer-scroll";
import { LayerAreaContext, LayerSpaceContext } from "./layer-space";

interface FrameProps {
  title: string;
  footer?: string;
  children: ReactNode;
}

/** One row that says how much content is out of view on its side, or stays empty. */
function HintRow({ text }: { text: string | undefined }) {
  const theme = useTheme();
  return (
    <Box height={1} flexShrink={0}>
      {text !== undefined && (
        <Text color={inkColor(theme.muted)} wrap="truncate-end">
          {text}
        </Text>
      )}
    </Box>
  );
}

/**
 * Where a frame's content is scrolled to, and the two ways to move it: `scrollBy` takes rows,
 * negative for up; `reveal` moves just enough to show `rows` rows starting at content row `at`.
 * Both stop at the ends. `currentTop` is the top as of the last move, also one since the last
 * render.
 */
function useContentScroll(hidden: number): {
  top: number;
  scrollBy: (rows: number) => void;
  reveal: (at: number, rows: number, viewRows: number, hidden: number) => void;
  currentTop: () => number;
} {
  const [wanted, setWanted] = useState(0);
  const top = scrolledTop(wanted, 0, hidden);
  // Ink hands every key of one read to the handlers before React renders again; each one must
  // move from where the one before it left the content.
  const latestRef = useRef(top);
  latestRef.current = top;
  const moveTo = useCallback((next: number) => {
    latestRef.current = next;
    setWanted(next);
  }, []);
  const scrollBy = useCallback(
    (rows: number) => moveTo(scrolledTop(latestRef.current, rows, hidden)),
    [hidden, moveTo],
  );
  const reveal = useCallback(
    (at: number, rows: number, viewRows: number, laidOutHidden: number) => {
      const now = latestRef.current;
      const wantedTop =
        at < now ? at : at + rows > now + viewRows ? at + rows - viewRows : now;
      moveTo(scrolledTop(wantedTop, 0, laidOutHidden));
    },
    [moveTo],
  );
  const currentTop = useCallback(() => latestRef.current, []);
  return { top, scrollBy, reveal, currentTop };
}

/** Where a cursor is in a frame's content, and the rows the frame shows and hides, as laid out. */
function measureCursor(
  place: CursorPlace,
  viewRef: RefObject<DOMElement | null>,
  contentRef: RefObject<DOMElement | null>,
): { at: number; viewRows: number; hidden: number } | undefined {
  const viewNode = viewRef.current;
  const contentNode = contentRef.current;
  if (place.node === null || viewNode === null || contentNode === null)
    return undefined;
  const viewRows = measureElement(viewNode).height;
  if (viewRows <= 0) return undefined;
  const contentBox = measureElement(contentNode);
  return {
    at: measureElement(place.node).y + place.offset - contentBox.y,
    viewRows,
    hidden: Math.max(0, contentBox.height - viewRows),
  };
}

/**
 * The cursor a frame keeps in view: `hold` counts a part with a cursor in, `follow` is told where
 * the cursor is after each of its renders and scrolls to it when it moved, `showAgain` scrolls to
 * it whatever, `inView` says whether its first row shows. The frame's own layouts check again too,
 * since the rows around the cursor change without its part drawing.
 */
function useCursorFollow(
  viewRef: RefObject<DOMElement | null>,
  contentRef: RefObject<DOMElement | null>,
  scroll: {
    reveal: (
      at: number,
      rows: number,
      viewRows: number,
      hidden: number,
    ) => void;
    currentTop: () => number;
  },
): {
  held: boolean;
  hold: () => () => void;
  follow: (place: CursorPlace) => void;
  showAgain: () => void;
  inView: () => boolean;
} {
  const { reveal, currentTop } = scroll;
  const [holders, setHolders] = useState(0);
  const hold = useCallback(() => {
    setHolders((n) => n + 1);
    return () => setHolders((n) => n - 1);
  }, []);
  const placeRef = useRef<CursorPlace | undefined>(undefined);
  const shownRef = useRef<string | undefined>(undefined);
  const follow = useCallback(
    (place: CursorPlace) => {
      placeRef.current = place;
      const where = measureCursor(place, viewRef, contentRef);
      if (where === undefined) return;
      const shown = `${place.cursor}:${where.at}:${place.rows}:${where.viewRows}`;
      if (shown === shownRef.current) return;
      shownRef.current = shown;
      // A cursor taller than the view shows from its first row.
      reveal(
        where.at,
        Math.min(place.rows, where.viewRows),
        where.viewRows,
        where.hidden,
      );
    },
    [viewRef, contentRef, reveal],
  );
  const showAgain = useCallback(() => {
    shownRef.current = undefined;
    if (placeRef.current !== undefined) follow(placeRef.current);
  }, [follow]);
  const inView = useCallback(() => {
    const place = placeRef.current;
    if (place === undefined) return true;
    const where = measureCursor(place, viewRef, contentRef);
    if (where === undefined) return true;
    const top = currentTop();
    return where.at >= top && where.at < top + where.viewRows;
  }, [viewRef, contentRef, currentTop]);
  useEffect(() => {
    if (placeRef.current !== undefined) follow(placeRef.current);
  });
  return { held: holders > 0, hold, follow, showAgain, inView };
}

/**
 * A layer frame in the shell's layer area: at the top of the room it is given, as tall as its
 * content and never taller than the room, its content scrolling when it does not fit.
 */
function ScrollingFrame({ title, footer, children }: FrameProps) {
  const theme = useTheme();
  const t = useMessages(layerMessages);
  const active = useInputActive();
  const roomRef = useRef<DOMElement>(null);
  const frameRef = useRef<DOMElement>(null);
  const viewRef = useRef<DOMElement>(null);
  const contentRef = useRef<DOMElement>(null);
  const endRef = useRef<DOMElement>(null);
  const room = useBoxMetrics(roomRef);
  const frame = useBoxMetrics(frameRef);
  const view = useBoxMetrics(viewRef);
  const content = useBoxMetrics(contentRef);
  const end = useBoxMetrics(endRef);
  // The view as tall as the room lets it be: the room less the frame's own rows. Free rows and
  // rows out of view are counted against it, so a list sized by its free rows grows back when
  // the room does.
  const tallestView =
    room.hasMeasured && frame.hasMeasured && view.hasMeasured
      ? room.height - (frame.height - view.height)
      : undefined;
  const hidden =
    tallestView !== undefined && content.hasMeasured
      ? Math.max(0, content.height - tallestView)
      : 0;
  // Content that fits is laid out with the frame in one pass, so every frame drawn, the first
  // one and the one after the content grew included, shows it whole. Content that does not fit
  // is laid out apart from the view, which takes the whole room and scrolls it.
  const fits = hidden === 0;
  const scroll = useContentScroll(hidden);
  const { top, scrollBy } = scroll;
  const below = hidden - top;
  const [lists, setLists] = useState(0);
  const join = useCallback(() => {
    setLists((n) => n + 1);
    return () => setLists((n) => n - 1);
  }, []);
  const cursor = useCursorFollow(viewRef, contentRef, scroll);

  useInput(
    (_input, key) => {
      if (key.pageDown) scrollBy(view.height);
      else if (key.pageUp) scrollBy(-view.height);
      else if (key.upArrow || key.downArrow) {
        // ↑ ↓ are the cursor's when there is one; they bring it back into view after PageUp
        // or PageDown took the frame away from it, even when it cannot move further.
        if (cursor.held) cursor.showAgain();
        else scrollBy(key.downArrow ? 1 : -1);
      }
    },
    { isActive: active && hidden > 0 },
  );
  useWheel(
    (direction, steps) =>
      scrollBy((direction === "up" ? -1 : 1) * steps * LINES_PER_WHEEL_STEP),
    { isActive: hidden > 0 && !cursor.held },
  );

  const spare =
    tallestView !== undefined && end.hasMeasured
      ? tallestView - end.top
      : undefined;
  const scrolls = hidden > 0;
  const space = useMemo<LayerSpace>(
    () => ({
      spare,
      lists,
      join,
      scrolls,
      holdCursor: cursor.hold,
      reveal: cursor.follow,
      cursorInView: cursor.inView,
      showCursor: cursor.showAgain,
    }),
    [
      spare,
      lists,
      join,
      scrolls,
      cursor.hold,
      cursor.follow,
      cursor.inView,
      cursor.showAgain,
    ],
  );

  return (
    // Keeps the frame inside the room whatever box holds it: content that has just outgrown the
    // room is drawn once at its full height before the frame scrolls it.
    <Box ref={roomRef} flexDirection="column" flexGrow={1} overflow="hidden">
      <Box
        ref={frameRef}
        flexDirection="column"
        borderStyle="single"
        borderColor={inkColor(theme.border)}
        paddingX={1}
        // Placed apart from the room while the content fits, so the room's height does not
        // squeeze the rows of the content laid out with it.
        {...(fits
          ? ({ position: "absolute", width: "100%" } as const)
          : { flexGrow: 1 })}
      >
        <Box flexShrink={0}>
          <Text bold>{title}</Text>
        </Box>
        <HintRow text={top > 0 ? t("moreAbove", { count: top }) : undefined} />
        <Box
          ref={viewRef}
          flexDirection="column"
          {...(fits ? { flexShrink: 0 } : { flexGrow: 1, flexBasis: 0 })}
          overflow="hidden"
          contentOffsetY={top}
        >
          {/* Never shrunk, and while the content does not fit laid out apart from the view too:
              in flow, the rows of boxes nested in it can still come out squeezed and drawn over
              one another. */}
          <Box
            ref={contentRef}
            flexDirection="column"
            flexShrink={0}
            {...(fits
              ? {}
              : ({ position: "absolute", width: "100%" } as const))}
          >
            <LayerSpaceContext value={space}>{children}</LayerSpaceContext>
            {/* Its top is where the content ends. */}
            <Box ref={endRef} height={0} flexShrink={0} />
          </Box>
        </Box>
        <HintRow
          text={below > 0 ? t("moreBelow", { count: below }) : undefined}
        />
        {footer !== undefined && (
          <Box flexShrink={0}>
            <Text color={inkColor(theme.muted)}>{footer}</Text>
          </Box>
        )}
      </Box>
    </Box>
  );
}

/** A layer frame outside the shell's layer area: as tall as its content, nothing to scroll. */
function OpenFrame({ title, footer, children }: FrameProps) {
  const theme = useTheme();
  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor={inkColor(theme.border)}
      paddingX={1}
      flexGrow={1}
    >
      <Text bold>{title}</Text>
      <HintRow text={undefined} />
      <Box flexDirection="column" flexGrow={1}>
        {children}
      </Box>
      <HintRow text={undefined} />
      {footer !== undefined && (
        <Text color={inkColor(theme.muted)}>{footer}</Text>
      )}
    </Box>
  );
}

/**
 * The look of a layer: a title, the content, and a line saying how to leave it. In the shell's
 * layer area the frame sits at the top of the room the shell gives the layer, as tall as its
 * content and never taller than the room; the rows under it stay blank. Content taller than the
 * room scrolls,
 * every row drawn whole: PageUp and PageDown turn a page, ↑ and ↓ move a row, a wheel step moves
 * three rows, and the row under the title and the row above the footer say how many rows are out
 * of view. Nothing scrolls while the content fits. In a frame holding a cursor
 * (`useLayerCursor`), ↑ ↓ and the wheel are the cursor's: the frame scrolls only on PageUp and
 * PageDown, and scrolls by itself to show the cursor each time it moves.
 */
export function LayerFrame(props: FrameProps) {
  return use(LayerAreaContext) ? (
    <ScrollingFrame {...props} />
  ) : (
    <OpenFrame {...props} />
  );
}
