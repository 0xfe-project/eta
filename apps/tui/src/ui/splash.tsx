import type { ReactNode } from "react";
import { Box, Text, useWindowSize } from "ink";
import { useTheme } from "../extensions/react";
import { LOGO_LINES, logoLineColors } from "./logo";
import { LOGO_GAP, SPLASH_LOGO_ROWS, splashLogoFits } from "./splash-size";
import { inkColor } from "./theme";

/** The eta logo with the name, the version and `detail` beside it. */
export function SplashLogo({
  version,
  detail,
}: {
  version: string;
  /** Lines beside the logo, under the name. */
  detail: ReactNode;
}) {
  const theme = useTheme();
  const colors = logoLineColors(theme);
  return (
    <Box flexDirection="row" flexShrink={0}>
      <Box flexDirection="column" flexShrink={0}>
        {LOGO_LINES.map((line, index) => (
          // The logo's lines are fixed; their position is their identity.
          // eslint-disable-next-line react/no-array-index-key
          <Text key={index} color={colors[index]}>
            {line}
          </Text>
        ))}
      </Box>
      <Box flexDirection="column" justifyContent="center" marginLeft={LOGO_GAP}>
        <Text bold color={inkColor(theme.brand)}>
          eta {version}
        </Text>
        {detail}
      </Box>
    </Box>
  );
}

/** The splash in one line: `eta <version> · <detail>`, cut at the right edge. */
export function SplashLine({
  version,
  detail,
}: {
  version: string;
  detail: string;
}) {
  const theme = useTheme();
  return (
    <Text wrap="truncate-end">
      <Text bold color={inkColor(theme.brand)}>
        eta {version}
      </Text>
      <Text> · {detail}</Text>
    </Text>
  );
}

/**
 * The logo form of the splash, or its one-line form when the space left after `reservedRows`
 * cannot hold the logo or the terminal is too narrow for it.
 */
export function Splash({
  version,
  detail,
  compactDetail,
  reservedRows,
}: {
  version: string;
  /** Lines beside the logo, under the name. */
  detail: ReactNode;
  compactDetail: string;
  /** Rows of the screen that other parts use. */
  reservedRows: number;
}) {
  const { columns, rows } = useWindowSize();
  if (!splashLogoFits(columns) || rows - reservedRows < SPLASH_LOGO_ROWS)
    return <SplashLine version={version} detail={compactDetail} />;
  return <SplashLogo version={version} detail={detail} />;
}
