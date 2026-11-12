import type { ReactNode } from "react";
import { Box, Text, useWindowSize } from "ink";
import { useTheme } from "../extensions/react";
import { LOGO_LINES, logoLineColors } from "./logo";
import { inkColor } from "./theme";

const LOGO_WIDTH = Math.max(...LOGO_LINES.map((line) => [...line].length));
const GAP = 3;
/** The narrowest text column worth drawing beside the logo. */
const MIN_TEXT_WIDTH = 24;
const MIN_COLUMNS = LOGO_WIDTH + GAP + MIN_TEXT_WIDTH;

/**
 * The eta logo with the name, the version and a line about the host beside it, and optional
 * lines under it. When the space left after `reservedRows` cannot hold it, one line instead:
 * `eta <version> · <compactDetail>`.
 */
export function Splash({
  version,
  detail,
  compactDetail,
  below,
  belowRows = 0,
  reservedRows,
}: {
  version: string;
  /** Lines beside the logo, under the name. */
  detail: ReactNode;
  compactDetail: string;
  below?: ReactNode;
  belowRows?: number;
  /** Rows of the screen that other parts use. */
  reservedRows: number;
}) {
  const theme = useTheme();
  const { columns, rows } = useWindowSize();
  const neededRows = LOGO_LINES.length + (belowRows > 0 ? belowRows + 1 : 0);
  if (columns < MIN_COLUMNS || rows - reservedRows < neededRows) {
    return (
      <Text wrap="truncate-end">
        <Text bold color={inkColor(theme.brand)}>
          eta {version}
        </Text>
        <Text> · {compactDetail}</Text>
      </Text>
    );
  }
  const colors = logoLineColors(theme);
  return (
    <Box flexDirection="column" alignItems="flex-start">
      <Box flexDirection="row">
        <Box flexDirection="column" flexShrink={0}>
          {LOGO_LINES.map((line, index) => (
            // The logo's lines are fixed; their position is their identity.
            // eslint-disable-next-line react/no-array-index-key
            <Text key={index} color={colors[index]}>
              {line}
            </Text>
          ))}
        </Box>
        <Box flexDirection="column" justifyContent="center" marginLeft={GAP}>
          <Text bold color={inkColor(theme.brand)}>
            eta {version}
          </Text>
          {detail}
        </Box>
      </Box>
      {below !== undefined && (
        <Box marginTop={1} flexDirection="column">
          {below}
        </Box>
      )}
    </Box>
  );
}
