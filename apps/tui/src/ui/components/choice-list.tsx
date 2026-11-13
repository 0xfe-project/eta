import { Box, Text, useInput } from "ink";
import { useState } from "react";
import { useInputActive, useTheme } from "../../extensions/react";
import { inkColor } from "../theme";
import { useLayerCursor } from "./layer-space";

export interface Choice {
  label: string;
  hint?: string;
}

/** Rows a choice takes: its label, and its hint under it when it has one. */
function rowsOf(choice: Choice): number {
  return choice.hint === undefined ? 1 : 2;
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
  const layerCursor = useLayerCursor(
    marked,
    choices.slice(0, marked).reduce((rows, c) => rows + rowsOf(c), 0),
    choices[marked] === undefined ? 1 : rowsOf(choices[marked]),
  );
  useInput(
    (input, key) => {
      if (key.upArrow) setMarked((m) => Math.max(0, m - 1));
      else if (key.downArrow)
        setMarked((m) => Math.min(choices.length - 1, m + 1));
      else if (key.return) {
        if (layerCursor.takeAction()) onChoose(marked);
      } else if (/^[1-9]$/.test(input) && Number(input) <= choices.length)
        onChoose(Number(input) - 1);
    },
    { isActive: active },
  );
  return (
    <Box ref={layerCursor.ref} flexDirection="column">
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
