import { Box, Text } from "ink";
import { useState } from "react";
import { useTheme } from "../../extensions/react";
import { LineInput } from "../../ui/components/line-input";
import { inkColor } from "../../ui/theme";

/**
 * What goes in a layer that asks for one line of text: a label, the input, an optional help line
 * and an optional error line. Enter submits the value without the spaces around it, and does
 * nothing while it is blank; Esc cancels. While `busy` is set, it takes no keys and shows that
 * text instead of the help line.
 */
export function TextPrompt({
  label,
  onSubmit,
  onCancel,
  masked = false,
  help,
  error,
  busy,
  initialValue = "",
}: {
  label: string;
  onSubmit: (value: string) => void;
  onCancel: () => void;
  /** Shows each character as `*`, for keys and tokens. */
  masked?: boolean;
  help?: string;
  error?: string;
  /** What is being done with the value, such as "Checking…". */
  busy?: string;
  initialValue?: string;
}) {
  const theme = useTheme();
  const [value, setValue] = useState(initialValue);
  const idle = busy === undefined;
  const submit = (text: string) => {
    const trimmed = text.trim();
    if (trimmed !== "") onSubmit(trimmed);
  };
  return (
    <Box flexDirection="column">
      <Text bold>{label}</Text>
      <Box>
        <Text color={inkColor(theme.accent)}>{"› "}</Text>
        <LineInput
          value={value}
          onChange={setValue}
          onSubmit={submit}
          onEscape={onCancel}
          masked={masked}
          focused={idle}
        />
      </Box>
      {!idle && <Text color={inkColor(theme.muted)}>{busy}</Text>}
      {idle && help !== undefined && (
        <Text color={inkColor(theme.muted)}>{help}</Text>
      )}
      {error !== undefined && (
        <Text color={inkColor(theme.error)}>{error}</Text>
      )}
    </Box>
  );
}
