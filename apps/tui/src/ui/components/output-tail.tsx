import { Box, Text } from "ink";
import { useTheme } from "../../extensions/react";
import { inkColor } from "../theme";

const TAIL_LINES = 20;

/** The last 20 lines of a program's output, as it printed them. */
export function OutputTail({ output }: { output: string }) {
  const theme = useTheme();
  const lines = output.replace(/\s+$/, "").split(/\r?\n/).slice(-TAIL_LINES);
  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor={inkColor(theme.border)}
      paddingX={1}
    >
      {lines.map((line, index) => (
        // Lines repeat, and their order never changes while shown.
        // eslint-disable-next-line react/no-array-index-key
        <Text key={index} color={inkColor(theme.muted)} wrap="truncate-end">
          {line === "" ? " " : line}
        </Text>
      ))}
    </Box>
  );
}
