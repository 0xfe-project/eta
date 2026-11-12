import { useInput, useWindowSize } from "ink";
import { useState } from "react";
import { useInputActive } from "../../extensions/react";

/** Rows of the screen a layer's frame, title, footer, status area and tab bar take. */
const RESERVED_ROWS = 10;
const FEWEST_ROWS = 3;

/** How many list rows fit in a layer on this terminal. */
export function useListHeight(extra = 0): number {
  const { rows } = useWindowSize();
  return Math.max(FEWEST_ROWS, rows - RESERVED_ROWS - extra);
}

/** ↑↓ move the cursor over `count` rows; Enter chooses the row at it; Esc leaves. */
export function useRowCursor(
  count: number,
  onChoose: (index: number) => void,
  onEscape: () => void,
): number {
  const active = useInputActive();
  const [cursor, setCursor] = useState(0);
  const at = Math.min(cursor, Math.max(0, count - 1));
  useInput(
    (_input, key) => {
      if (key.upArrow) setCursor(Math.max(0, at - 1));
      else if (key.downArrow) setCursor(Math.min(count - 1, at + 1));
      else if (key.return && count > 0) onChoose(at);
      else if (key.escape) onEscape();
    },
    { isActive: active },
  );
  return at;
}
