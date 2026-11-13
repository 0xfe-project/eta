import type { ActionGate } from "./layer-space";
import { useInput, useWindowSize } from "ink";
import { useState } from "react";
import { useInputActive } from "../../extensions/react";
import { FRAME_ROWS, gateAllows, useLayerRows } from "./layer-space";

/**
 * Rows of the screen a layer's frame, status area and tab bar take, assumed until the shell has
 * laid the layer out.
 */
const RESERVED_ROWS = 10;
const FEWEST_ROWS = 3;

/**
 * How many list rows fit in a layer's frame when `extra` of its content rows go to other lines:
 * the rows the shell gives the layer, less the frame's own; before the first layout, an estimate
 * from the terminal's height.
 */
export function useListHeight(extra = 0): number {
  const { rows } = useWindowSize();
  const layerRows = useLayerRows();
  const content =
    layerRows === undefined ? rows - RESERVED_ROWS : layerRows - FRAME_ROWS;
  return Math.max(FEWEST_ROWS, content - extra);
}

/**
 * ↑↓ move the cursor over `count` rows; Enter chooses the row at it unless `gate` (the gate the
 * `RowList` drawing these rows fills) says the cursor is out of view; Esc leaves.
 */
export function useRowCursor(
  count: number,
  onChoose: (index: number) => void,
  onEscape: () => void,
  gate?: ActionGate,
): number {
  const active = useInputActive();
  const [cursor, setCursor] = useState(0);
  const at = Math.min(cursor, Math.max(0, count - 1));
  useInput(
    (_input, key) => {
      if (key.upArrow) setCursor(Math.max(0, at - 1));
      else if (key.downArrow) setCursor(Math.min(count - 1, at + 1));
      else if (key.return && count > 0) {
        if (gateAllows(gate)) onChoose(at);
      } else if (key.escape) onEscape();
    },
    { isActive: active },
  );
  return at;
}
