import type { ReactNode } from "react";
import { Box, Text, useInput } from "ink";
import { useRef, useState } from "react";
import { useInputActive, useTheme } from "../../extensions/react";
import { useLayerCursor, useListFit } from "../../ui/components/layer-space";
import { inkColor } from "../../ui/theme";

/** One line of a scrolling list: a choice, or a heading the cursor skips. */
export type ListLine =
  | { kind: "choice"; key: string; content: ReactNode }
  | { kind: "heading"; key: string; text: string };

const CURSOR = "› ";
const NO_CURSOR = "  ";

/**
 * The first line to show: the window from `top` moved just enough to hold the cursor's line, at
 * the very top while the cursor is on the first choice and that fits, so the headings above it
 * show; never past the point where the last page would be short.
 */
function followedTop(
  top: number,
  cursor: number,
  cursorLine: number | undefined,
  rows: number,
  count: number,
): number {
  let next = top;
  if (cursorLine !== undefined) {
    if (cursor === 0 && cursorLine < rows) next = 0;
    else if (cursorLine < next) next = cursorLine;
    else if (cursorLine >= next + rows) next = cursorLine - rows + 1;
  }
  return Math.max(0, Math.min(next, count - rows));
}

/**
 * Lines as tall as the room the layer frame leaves them (see `useListFit`), the window following
 * the cursor: ↑↓ move a choice, PageUp and PageDown a screen, Enter picks the choice under the
 * cursor and Esc leaves. Headings are drawn and skipped. In a frame whose content is taller than
 * it, PageUp and PageDown scroll the frame instead, and Enter while the cursor is out of view only
 * brings it back (see `useLayerCursor`).
 */
export function ScrollList({
  lines,
  onPick,
  onEscape,
}: {
  lines: readonly ListLine[];
  onPick: (key: string) => void;
  onEscape: () => void;
}) {
  const theme = useTheme();
  const active = useInputActive();
  const fit = useListFit(lines.length, lines.length, 0);
  const rows = Math.max(1, fit.height);
  const choices = lines.flatMap((line, index) =>
    line.kind === "choice" ? [index] : [],
  );
  const [cursorKey, setCursorKey] = useState<string | undefined>(undefined);
  const topRef = useRef(0);

  // The cursor stays on its choice when lines come and go; a choice that went leaves it on the first.
  const found = choices.findIndex((index) => lines[index]?.key === cursorKey);
  const cursor = found === -1 ? 0 : found;
  const cursorLine = choices[cursor];

  // The window follows the cursor; it is worked out on each draw, so a smaller room shows the
  // cursor at once, and kept for the next draw.
  const windowTop = followedTop(
    topRef.current,
    cursor,
    cursorLine,
    rows,
    lines.length,
  );
  topRef.current = windowTop;

  const moveTo = (index: number) => {
    const clamped = Math.max(0, Math.min(choices.length - 1, index));
    const line = lines[choices[clamped] ?? -1];
    if (line !== undefined) setCursorKey(line.key);
  };

  const layerCursor = useLayerCursor(cursor, (cursorLine ?? 0) - windowTop);

  useInput(
    (_input, key) => {
      if ((key.pageUp || key.pageDown) && layerCursor.framePages) return;
      if (key.escape) onEscape();
      else if (key.upArrow) moveTo(cursor - 1);
      else if (key.downArrow) moveTo(cursor + 1);
      else if (key.pageUp) moveTo(cursor - Math.max(1, rows - 1));
      else if (key.pageDown) moveTo(cursor + Math.max(1, rows - 1));
      else if (key.return && cursorLine !== undefined) {
        if (!layerCursor.takeAction()) return;
        const line = lines[cursorLine];
        if (line !== undefined) onPick(line.key);
      }
    },
    { isActive: active },
  );

  const visible = lines.slice(windowTop, windowTop + rows);
  fit.drew(visible.length);
  const cursorKeyNow = lines[cursorLine ?? -1]?.key;
  return (
    <Box ref={layerCursor.ref} flexDirection="column">
      {visible.map((line) =>
        line.kind === "heading" ? (
          <Text key={line.key} bold wrap="truncate-end">
            {line.text}
          </Text>
        ) : (
          <Text
            key={line.key}
            wrap="truncate-end"
            color={
              line.key === cursorKeyNow ? inkColor(theme.accent) : undefined
            }
          >
            {line.key === cursorKeyNow ? CURSOR : NO_CURSOR}
            {line.content}
          </Text>
        ),
      )}
    </Box>
  );
}
