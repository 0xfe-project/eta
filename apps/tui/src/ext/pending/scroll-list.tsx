import type { DOMElement } from "ink";
import type { ReactNode } from "react";
import { Box, Text, useBoxMetrics, useInput } from "ink";
import { useEffect, useRef, useState } from "react";
import { useInputActive, useTheme } from "../../extensions/react";
import { inkColor } from "../../ui/theme";

/** One line of a scrolling list: a choice, or a heading the cursor skips. */
export type ListLine =
  | { kind: "choice"; key: string; content: ReactNode }
  | { kind: "heading"; key: string; text: string };

const CURSOR = "› ";
const NO_CURSOR = "  ";

/**
 * Lines as tall as the room they get, the window following the cursor: ↑↓ move a choice, PageUp
 * and PageDown a screen, Enter picks the choice under the cursor and Esc leaves. Headings are
 * drawn and skipped.
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
  const boxRef = useRef<DOMElement>(null);
  const { height, hasMeasured } = useBoxMetrics(boxRef);
  const rows = Math.max(1, height);
  const choices = lines.flatMap((line, index) =>
    line.kind === "choice" ? [index] : [],
  );
  const [cursorKey, setCursorKey] = useState<string | undefined>(undefined);
  const [top, setTop] = useState(0);

  // The cursor stays on its choice when lines come and go; a choice that went leaves it on the first.
  const found = choices.findIndex((index) => lines[index]?.key === cursorKey);
  const cursor = found === -1 ? 0 : found;
  const cursorLine = choices[cursor];

  useEffect(() => {
    if (!hasMeasured || cursorLine === undefined) return;
    // On the first choice the window is at the very top, so the headings above it show.
    if (cursor === 0 && cursorLine < rows) setTop(0);
    else if (cursorLine < top) setTop(cursorLine);
    else if (cursorLine >= top + rows) setTop(cursorLine - rows + 1);
  }, [hasMeasured, cursor, cursorLine, top, rows]);

  const moveTo = (index: number) => {
    const clamped = Math.max(0, Math.min(choices.length - 1, index));
    const line = lines[choices[clamped] ?? -1];
    if (line !== undefined) setCursorKey(line.key);
  };

  useInput(
    (_input, key) => {
      if (key.escape) onEscape();
      else if (key.upArrow) moveTo(cursor - 1);
      else if (key.downArrow) moveTo(cursor + 1);
      else if (key.pageUp) moveTo(cursor - Math.max(1, rows - 1));
      else if (key.pageDown) moveTo(cursor + Math.max(1, rows - 1));
      else if (key.return && cursorLine !== undefined) {
        const line = lines[cursorLine];
        if (line !== undefined) onPick(line.key);
      }
    },
    { isActive: active },
  );

  const visible = lines.slice(top, top + rows);
  const cursorKeyNow = lines[cursorLine ?? -1]?.key;
  return (
    <Box ref={boxRef} flexDirection="column" flexGrow={1} overflow="hidden">
      {hasMeasured &&
        visible.map((line) =>
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
