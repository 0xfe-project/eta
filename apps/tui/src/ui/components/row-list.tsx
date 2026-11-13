import type { ActionGate } from "./layer-space";
import { Box, Text } from "ink";
import { useTheme } from "../../extensions/react";
import { inkColor } from "../theme";
import { useLayerCursor, useListFit } from "./layer-space";
import { windowStart } from "./list-window";

export interface Row {
  key: string;
  label: string;
  /** Drawn after the label in the muted colour. */
  note?: string;
}

/**
 * Rows with a cursor: the row at `cursor` is marked and in the accent colour; when they do not
 * all fit, the window follows the cursor. At most `height` rows show, fewer in a layer frame that
 * has not got the rows for them (see `useListFit`).
 */
export function RowList({
  rows,
  cursor,
  height,
  gate,
}: {
  rows: readonly Row[];
  cursor: number;
  height: number;
  /** Gets the cursor's `takeAction`, for the layer's own Enter and Space handling. */
  gate?: ActionGate;
}) {
  const theme = useTheme();
  const fit = useListFit(rows.length, height, 0);
  const start = windowStart(cursor, rows.length, fit.height);
  const shown = rows.slice(start, start + fit.height);
  fit.drew(shown.length);
  const layerCursor = useLayerCursor(cursor, cursor - start);
  if (gate !== undefined) gate.current = layerCursor.takeAction;
  return (
    <Box ref={layerCursor.ref} flexDirection="column">
      {shown.map((row, offset) => {
        const marked = start + offset === cursor;
        return (
          <Text key={row.key} wrap="truncate-end">
            <Text
              color={marked ? inkColor(theme.accent) : undefined}
              bold={marked}
            >
              {marked ? "› " : "  "}
              {row.label}
            </Text>
            {row.note !== undefined && (
              <Text color={inkColor(theme.muted)}>{`  ${row.note}`}</Text>
            )}
          </Text>
        );
      })}
    </Box>
  );
}
