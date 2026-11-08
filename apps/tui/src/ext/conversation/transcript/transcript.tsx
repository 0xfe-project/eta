import type { Key } from "ink";
import type { RenderedItem, TranscriptItem } from "../contract";
import type { TranscriptLayout } from "./layout";
import type { LineScroll } from "./scroll";
import type { Match } from "./search";
import type { Selection } from "./selection";
import type { LinePlace, MatchPlace, SearchState, TranscriptUi } from "./ui";
import { Box, Text, useInput } from "ink";
import { useEffect, useMemo, useState } from "react";
import { useAction, useInputActive, useTheme } from "../../../extensions/react";
import { useMessages } from "../../../i18n/react";
import { LineInput } from "../../../ui/components/line-input";
import { inkColor } from "../../../ui/theme";
import { copyToClipboard } from "./clipboard";
import { layoutTranscript } from "./layout";
import { transcriptMessages } from "./messages";
import {
  lineOfPlace,
  placeIn,
  placeOfLine,
  scrollIn,
  scrollLine,
  scrollPlace,
} from "./places";
import {
  normalized,
  pageSize,
  revealLine,
  scrolledBy,
  scrolledTo,
  viewportOf,
} from "./scroll";
import { findMatches, matchAtOrAbove, stepMatch } from "./search";
import {
  foldPlace,
  moveCursor,
  selectedLines,
  selectedText,
} from "./selection";
import { toggledExpanded } from "./ui";

/** What the transcript's keys do now: scroll, type a search, or move a selection cursor. */
export type TranscriptMode = "normal" | "search" | "select";

export interface TranscriptProps {
  items: readonly TranscriptItem[];
  /** One drawing per item, in the same order. */
  rendered: readonly RenderedItem[];
  /** Rows the transcript fills, the search bar and the hint rows included. */
  height: number;
  width: number;
  /** The view is in front; off, none of its keys work. */
  isActive: boolean;
  ui: TranscriptUi;
  onUi: (update: Partial<TranscriptUi>) => void;
  /** Rows older than the first item exist. */
  hasOlder: boolean;
  /** Older rows are on their way, or have come and are not among `items` yet. */
  loadingOlder: boolean;
  /**
   * A scroll up (a key, or the selection cursor) left the first line on screen while `hasOlder`
   * and not `loadingOlder`. Called once per such scroll, never while the view merely stays there.
   */
  onReachTop: () => void;
  /** A line for the status area, already in the reader's language. */
  onNotify: (text: string) => void;
  /** Puts text on the clipboard; OSC 52 to the terminal unless given. */
  copy?: ((text: string) => void) | undefined;
  onModeChange?: ((mode: TranscriptMode) => void) | undefined;
}

type Texts = ReturnType<
  typeof useMessages<keyof (typeof transcriptMessages)["en"]>
>;

/** A selection as places, so it stays on the same content while lines move. */
interface HeldSelection {
  cursor: LinePlace;
  anchor: LinePlace | undefined;
}

/**
 * The conversation's lines in a column of `height` rows: it follows the newest line until scrolled
 * away, searches with a bar on its last row, and selects lines with a cursor to copy or fold.
 * Where it is scrolled, what is unfolded and the search live in `ui`, so they outlast the view.
 */
export function Transcript(props: TranscriptProps) {
  const { items, rendered, height, ui, onUi, isActive } = props;
  const t = useMessages(transcriptMessages);
  const theme = useTheme();
  const scopeActive = useInputActive();
  const [held, setHeld] = useState<HeldSelection | undefined>(undefined);
  const mode: TranscriptMode =
    held !== undefined
      ? "select"
      : ui.search !== undefined
        ? "search"
        : "normal";

  const layout = useMemo(
    () => layoutTranscript(items, rendered),
    [items, rendered],
  );
  // Every layout names the kept places again, so one whose item goes away stands in from where it
  // was in the last layout that had it.
  const [heldLayout, setHeldLayout] = useState(layout);
  if (heldLayout !== layout) {
    setHeldLayout(layout);
    if (held !== undefined) setHeld(heldIn(layout, held));
  }
  const { scroll: keptScroll, search: keptSearch } = ui;
  useEffect(() => {
    const scroll = scrollIn(layout, keptScroll);
    const search = searchIn(layout, keptSearch);
    if (scroll !== keptScroll || search !== keptSearch)
      onUi({ scroll, search });
  }, [layout, keptScroll, keptSearch, onUi]);

  const total = layout.lines.length;
  const chrome = mode === "normal" ? 0 : 1;
  const linesHeight = Math.max(0, height - chrome);

  const scroll = scrollLine(layout, ui.scroll);
  const view = viewportOf(scroll, total, linesHeight);
  const setScroll = (next: LineScroll) =>
    onUi({ scroll: scrollPlace(layout, normalized(next, total, linesHeight)) });

  const { hasOlder, loadingOlder, onReachTop } = props;
  const askOlderAt = (next: LineScroll) => {
    if (!hasOlder || loadingOlder) return;
    if (viewportOf(next, total, linesHeight).top === 0) onReachTop();
  };
  const scrollUp = (next: LineScroll) => {
    setScroll(next);
    askOlderAt(next);
  };

  const { onModeChange } = props;
  useEffect(() => {
    onModeChange?.(mode);
  }, [mode, onModeChange]);

  const query = ui.search?.query;
  const matches = useMemo(
    () => (query === undefined ? [] : findMatches(layout.plain, query)),
    [layout, query],
  );
  const current = currentMatch(layout, matches, ui.search?.current);

  const selection: Selection | undefined =
    held === undefined
      ? undefined
      : {
          cursor: lineOfPlace(layout, held.cursor),
          anchor:
            held.anchor === undefined
              ? undefined
              : lineOfPlace(layout, held.anchor),
        };
  const hold = (next: Selection): HeldSelection => ({
    cursor: placeOfLine(layout, next.cursor),
    anchor:
      next.anchor === undefined ? undefined : placeOfLine(layout, next.anchor),
  });

  const scrolling = isActive && mode !== "select";
  const page = pageSize(linesHeight);
  useAction(
    "transcript.pageUp",
    () => scrollUp(scrolledBy(scroll, -page, total, linesHeight)),
    { isActive: scrolling },
  );
  useAction(
    "transcript.pageDown",
    () => setScroll(scrolledBy(scroll, page, total, linesHeight)),
    { isActive: scrolling },
  );
  useAction(
    "transcript.lineUp",
    () => scrollUp(scrolledBy(scroll, -1, total, linesHeight)),
    { isActive: scrolling },
  );
  useAction(
    "transcript.lineDown",
    () => setScroll(scrolledBy(scroll, 1, total, linesHeight)),
    { isActive: scrolling },
  );
  useAction(
    "transcript.top",
    () => scrollUp(scrolledTo(0, total, linesHeight)),
    { isActive: scrolling },
  );
  useAction("transcript.bottom", () => setScroll({ follow: true }), {
    isActive: scrolling,
  });
  useAction("transcript.expandAll", () => onUi({ expandAll: !ui.expandAll }), {
    isActive,
  });
  useAction(
    "transcript.search",
    () => {
      setHeld(undefined);
      onUi({ search: { query: "", current: undefined } });
    },
    { isActive: isActive && mode !== "search" },
  );
  useAction(
    "transcript.select",
    () => {
      if (total === 0) return;
      // The keys take the last row, so the view is one row shorter from here on.
      const shorter = viewportOf(scroll, total, Math.max(0, height - 1));
      setHeld(
        hold({
          cursor: Math.max(0, shorter.top + shorter.rows - 1),
          anchor: undefined,
        }),
      );
      onUi({ search: undefined });
    },
    { isActive: isActive && mode !== "select" },
  );

  const searchTo = (
    text: string,
    index: number | undefined,
    found: readonly Match[],
  ) => {
    const match = index === undefined ? undefined : found[index];
    onUi({
      search: {
        query: text,
        current:
          match === undefined
            ? undefined
            : { place: placeOfLine(layout, match.line), start: match.start },
      },
      ...(match === undefined
        ? {}
        : {
            scroll: scrollPlace(
              layout,
              revealLine(scroll, match.line, total, linesHeight),
            ),
          }),
    });
  };
  const typed = (text: string) => {
    const found = findMatches(layout.plain, text);
    searchTo(text, matchAtOrAbove(found, view.top + view.rows - 1), found);
  };
  const step = (direction: -1 | 1) => {
    if (ui.search === undefined) return;
    searchTo(
      ui.search.query,
      stepMatch(current, matches.length, direction),
      matches,
    );
  };
  useInput(
    (_input, key) => {
      // A modified arrow belongs to the scrolling keys (Shift+↑ scrolls a line).
      if (key.shift || key.ctrl || key.meta) return;
      if (key.upArrow) step(-1);
      else if (key.downArrow) step(1);
    },
    { isActive: scopeActive && isActive && mode === "search" },
  );

  const selecting = (next: Selection, delta = 0) => {
    setHeld(hold(next));
    const revealed = revealLine(scroll, next.cursor, total, linesHeight);
    onUi({ scroll: scrollPlace(layout, revealed) });
    if (delta < 0) askOlderAt(revealed);
  };
  const copyText = props.copy ?? ((text: string) => copyToClipboard(text));
  const onSelectKey = (input: string, key: Key) => {
    if (selection === undefined) return;
    const reaction = selectionKey(input, key, page);
    switch (reaction?.type) {
      case "move":
        selecting(moveCursor(selection, reaction.delta, total), reaction.delta);
        return;
      case "mark":
        setHeld({
          cursor: placeOfLine(layout, selection.cursor),
          anchor:
            selection.anchor === undefined
              ? placeOfLine(layout, selection.cursor)
              : undefined,
        });
        return;
      case "copy-lines": {
        const text = selectedText(layout.plain, selection);
        if (text.trim() === "") props.onNotify(t("nothingCopied"));
        else {
          copyText(text);
          props.onNotify(copiedLines(t, selectedLines(selection)));
        }
        setHeld(undefined);
        return;
      }
      case "copy-item": {
        const place = foldPlace(layout, selection.cursor);
        if (place === undefined) return;
        copyText(rendered[place.item]!.source);
        props.onNotify(t("copied"));
        return;
      }
      case "fold": {
        const place = foldPlace(layout, selection.cursor);
        if (place === undefined || !rendered[place.item]!.foldable) return;
        onUi({
          expanded: toggledExpanded(ui.expanded, items[place.item]!.key),
        });
        selecting({ ...selection, cursor: place.line });
        return;
      }
      case "leave":
        setHeld(undefined);
    }
  };
  useInput(onSelectKey, {
    isActive: scopeActive && isActive && mode === "select",
  });

  const shown = layout.lines.slice(view.top, view.top + view.rows);
  return (
    <Box flexDirection="column" height={height} width={props.width}>
      <Box flexDirection="column" height={linesHeight} flexShrink={0}>
        {shown.map((line, offset) => {
          const index = view.top + offset;
          return (
            <Line
              key={index}
              index={index}
              line={line}
              layout={layout}
              selection={selection}
              matches={matches}
              current={current}
              selectionColor={inkColor(theme.selection)}
            />
          );
        })}
        {view.following || view.rows === linesHeight ? null : (
          <Text color={inkColor(theme.muted)} wrap="truncate-end">
            {view.below === 1
              ? t("belowOne")
              : t("below", { count: view.below })}
          </Text>
        )}
      </Box>
      {mode === "search" && ui.search !== undefined ? (
        <SearchBar
          query={ui.search.query}
          count={matches.length}
          current={current}
          texts={t}
          onChange={typed}
          onPrevious={() => step(-1)}
          onClose={() => onUi({ search: undefined })}
          isActive={isActive}
        />
      ) : null}
      {mode === "select" ? (
        <Text color={inkColor(theme.muted)} wrap="truncate-end">
          {t("selectKeys")}
        </Text>
      ) : null}
    </Box>
  );
}

function searchIn(
  layout: TranscriptLayout,
  search: SearchState | undefined,
): SearchState | undefined {
  if (search?.current === undefined) return search;
  const { current } = search;
  const place = placeIn(layout, current.place);
  return place === current.place
    ? search
    : { ...search, current: { ...current, place } };
}

function heldIn(layout: TranscriptLayout, held: HeldSelection): HeldSelection {
  const cursor = placeIn(layout, held.cursor);
  const anchor =
    held.anchor === undefined ? undefined : placeIn(layout, held.anchor);
  return cursor === held.cursor && anchor === held.anchor
    ? held
    : { cursor, anchor };
}

/**
 * The index of the match `place` names: the one starting there, or, when the lines under it
 * changed, the newest at or above its line.
 */
function currentMatch(
  layout: TranscriptLayout,
  matches: readonly Match[],
  place: MatchPlace | undefined,
): number | undefined {
  if (place === undefined) return undefined;
  const line = lineOfPlace(layout, place.place);
  const exact = matches.findIndex(
    (match) => match.line === line && match.start === place.start,
  );
  return exact >= 0 ? exact : matchAtOrAbove(matches, line);
}

function copiedLines(t: Texts, count: number): string {
  return count === 1 ? t("copiedOne") : t("copiedLines", { count });
}

type SelectionReaction =
  | { type: "move"; delta: number }
  | { type: "mark" }
  | { type: "copy-lines" }
  | { type: "copy-item" }
  | { type: "fold" }
  | { type: "leave" };

/** The selection mode's keys, which are fixed rather than bound in the settings. */
function selectionKey(
  input: string,
  key: Key,
  page: number,
): SelectionReaction | undefined {
  if (key.upArrow) return { type: "move", delta: -1 };
  if (key.downArrow) return { type: "move", delta: 1 };
  if (key.pageUp) return { type: "move", delta: -page };
  if (key.pageDown) return { type: "move", delta: page };
  if (key.home) return { type: "move", delta: -Infinity };
  if (key.end) return { type: "move", delta: Infinity };
  if (key.escape) return { type: "leave" };
  if (key.return) return { type: "copy-lines" };
  if (key.ctrl || key.meta) return undefined;
  if (input === "v") return { type: "mark" };
  if (input === "y") return { type: "copy-lines" };
  if (input === "c") return { type: "copy-item" };
  if (input === " ") return { type: "fold" };
  return undefined;
}

function Line({
  index,
  line,
  layout,
  selection,
  matches,
  current,
  selectionColor,
}: {
  index: number;
  line: string;
  layout: TranscriptLayout;
  selection: Selection | undefined;
  matches: readonly Match[];
  current: number | undefined;
  selectionColor: string | undefined;
}) {
  const plain = layout.plain[index] ?? "";
  // Ink gives an empty text no row at all; a blank line still takes one.
  const blankSafe = (text: string) => (text === "" ? " " : text);
  if (selection !== undefined) {
    if (index === selection.cursor)
      return (
        <Text inverse wrap="truncate-end">
          {blankSafe(plain)}
        </Text>
      );
    const anchor = selection.anchor;
    if (
      anchor !== undefined &&
      index >= Math.min(anchor, selection.cursor) &&
      index <= Math.max(anchor, selection.cursor)
    )
      return (
        <Text backgroundColor={selectionColor} wrap="truncate-end">
          {blankSafe(plain)}
        </Text>
      );
  }
  const here = matches.flatMap((match, at) =>
    match.line === index ? [{ match, at }] : [],
  );
  if (here.length === 0)
    return <Text wrap="truncate-end">{blankSafe(line)}</Text>;
  // A line with a match is drawn from its plain text, so the match can be marked inside it.
  const parts: React.ReactNode[] = [];
  let from = 0;
  for (const { match, at } of here) {
    if (match.start > from) parts.push(plain.slice(from, match.start));
    const found = plain.slice(match.start, match.end);
    parts.push(
      at === current ? (
        <Text key={at} backgroundColor={selectionColor}>
          {found}
        </Text>
      ) : (
        <Text key={at} inverse>
          {found}
        </Text>
      ),
    );
    from = match.end;
  }
  if (from < plain.length) parts.push(plain.slice(from));
  return <Text wrap="truncate-end">{parts}</Text>;
}

function SearchBar({
  query,
  count,
  current,
  texts,
  onChange,
  onPrevious,
  onClose,
  isActive,
}: {
  query: string;
  count: number;
  current: number | undefined;
  texts: Texts;
  onChange: (query: string) => void;
  onPrevious: () => void;
  onClose: () => void;
  isActive: boolean;
}) {
  const where =
    query === ""
      ? ""
      : count === 0 || current === undefined
        ? texts("noMatches")
        : `${current + 1}/${count}`;
  return (
    <Box>
      <Text>/ </Text>
      <LineInput
        value={query}
        onChange={onChange}
        onSubmit={onPrevious}
        onEscape={onClose}
        focused={isActive}
      />
      {where === "" ? null : <Text>{`  ${where}`}</Text>}
    </Box>
  );
}
