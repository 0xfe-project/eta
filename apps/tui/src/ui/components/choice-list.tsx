import { Box, Text, useInput } from "ink";
import { useState } from "react";
import { useInputActive, useTheme } from "../../extensions/react";
import { inkColor } from "../theme";

export interface Choice {
  label: string;
  hint?: string;
}

/**
 * Numbered choices: a digit picks one at once; ↑↓ move the marker and Enter picks the marked one.
 * At most nine choices.
 */
export function ChoiceList({
  choices,
  onChoose,
}: {
  choices: Choice[];
  onChoose: (index: number) => void;
}) {
  const theme = useTheme();
  const active = useInputActive();
  const [marked, setMarked] = useState(0);
  useInput(
    (input, key) => {
      if (key.upArrow) setMarked((m) => Math.max(0, m - 1));
      else if (key.downArrow)
        setMarked((m) => Math.min(choices.length - 1, m + 1));
      else if (key.return) onChoose(marked);
      else if (/^[1-9]$/.test(input) && Number(input) <= choices.length)
        onChoose(Number(input) - 1);
    },
    { isActive: active },
  );
  return (
    <Box flexDirection="column">
      {choices.map((choice, index) => {
        const isMarked = index === marked;
        return (
          <Box key={choice.label} flexDirection="column">
            <Text
              color={isMarked ? inkColor(theme.accent) : undefined}
              bold={isMarked}
            >
              {isMarked ? "› " : "  "}
              {index + 1}. {choice.label}
            </Text>
            {choice.hint !== undefined && (
              <Text color={inkColor(theme.muted)}>
                {"     "}
                {choice.hint}
              </Text>
            )}
          </Box>
        );
      })}
    </Box>
  );
}
