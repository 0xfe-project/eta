import { Box, Text } from "ink";
import { useTheme } from "../../extensions/react";
import { inkColor } from "../theme";
import { windowStart } from "./list-window";

export interface Row {
  key: string;
  label: string;
  /** Drawn after the label in the muted colour. */
  note?: string;
}

/**
 * Rows with a cursor: the row at `cursor` is marked and in the accent colour; when they do not
 * all fit, the window follows the cursor.
 */
export function RowList({
  rows,
  cursor,
  height,
}: {
  rows: readonly Row[];
  cursor: number;
  height: number;
}) {
  const theme = useTheme();
  const start = windowStart(cursor, rows.length, height);
  return (
    <Box flexDirection="column">
      {rows.slice(start, start + height).map((row, offset) => {
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
