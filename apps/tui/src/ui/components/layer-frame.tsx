import type { ReactNode } from "react";
import { Box, Text } from "ink";
import { useTheme } from "../../extensions/react";
import { inkColor } from "../theme";

/** The look of a layer: a title, the content, and a line saying how to leave it. */
export function LayerFrame({
  title,
  footer,
  children,
}: {
  title: string;
  footer?: string;
  children: ReactNode;
}) {
  const theme = useTheme();
  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor={inkColor(theme.border)}
      paddingX={1}
      flexGrow={1}
    >
      <Text bold>{title}</Text>
      <Box flexDirection="column" marginY={1} flexGrow={1}>
        {children}
      </Box>
      {footer !== undefined && (
        <Text color={inkColor(theme.muted)}>{footer}</Text>
      )}
    </Box>
  );
}
