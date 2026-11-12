import type { ReactNode } from "react";
import { Box, Text } from "ink";
import { MARK_WIDTH } from "./lines";

interface PrefixedProps {
  mark: string;
  markColor: string | undefined;
  markBold?: boolean;
  children: ReactNode;
}

/** A one-character mark, then the content; the content's wrapped lines line up under its start. */
export function Prefixed({
  mark,
  markColor,
  markBold = false,
  children,
}: PrefixedProps) {
  return (
    <Box flexDirection="row">
      <Box width={MARK_WIDTH} flexShrink={0}>
        <Text color={markColor} bold={markBold}>
          {mark}
        </Text>
      </Box>
      <Box flexDirection="column" flexGrow={1} flexShrink={1}>
        {children}
      </Box>
    </Box>
  );
}
