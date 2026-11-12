import type { ReactNode } from "react";
import type { ActionGate } from "./layer-space";
import { Box } from "ink";
import { useLayerCursor } from "./layer-space";

/**
 * A column of rows with a cursor among them, for a layer that draws its own cursor rows inside
 * its `LayerFrame`: the frame leaves ↑ ↓ to the cursor and keeps the cursor's rows in view (see
 * `useLayerCursor`). `cursor` is the item the cursor is on; its rows are `rows` rows starting
 * `offset` rows below the top of the column. `gate` gets the cursor's `takeAction`, for the
 * layer's own Enter and Space handling to ask before acting (see `gateAllows`).
 */
export function LayerCursorBox({
  cursor,
  offset,
  rows = 1,
  marginTop,
  gate,
  children,
}: {
  cursor: number;
  offset: number;
  rows?: number;
  marginTop?: number;
  gate?: ActionGate;
  children: ReactNode;
}) {
  const { ref, takeAction } = useLayerCursor(cursor, offset, rows);
  if (gate !== undefined) gate.current = takeAction;
  return (
    <Box ref={ref} flexDirection="column" marginTop={marginTop}>
      {children}
    </Box>
  );
}
