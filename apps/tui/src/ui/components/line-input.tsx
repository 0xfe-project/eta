import { Text, useInput, usePaste } from "ink";
import { useInputActive } from "../../extensions/react";

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function isPrintable(input: string): boolean {
  return (
    input !== "" &&
    [...input].every((char) => {
      const code = char.codePointAt(0) ?? 0;
      return code >= 0x20 && code !== 0x7f;
    })
  );
}

function dropLastGrapheme(text: string): string {
  const parts = [...graphemes.segment(text)];
  return parts
    .slice(0, -1)
    .map((p) => p.segment)
    .join("");
}

/**
 * A one-line text field that only appends: typing and pasting add at the end, Backspace removes
 * the last character, and Left and Right are left to the rest of the screen. A paste's line
 * breaks become spaces. `masked` shows each character as `*`.
 */
export function LineInput({
  value,
  onChange,
  onSubmit,
  onEscape,
  onTab,
  masked = false,
  focused = true,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit?: (value: string) => void;
  onEscape?: () => void;
  onTab?: () => void;
  masked?: boolean;
  focused?: boolean;
}) {
  const isActive = useInputActive() && focused;
  useInput(
    (input, key) => {
      if (key.return) onSubmit?.(value);
      else if (key.escape) onEscape?.();
      else if (key.tab) onTab?.();
      else if (key.backspace || key.delete) onChange(dropLastGrapheme(value));
      else if (!key.ctrl && !key.meta && isPrintable(input))
        onChange(value + input);
    },
    { isActive },
  );
  usePaste((text) => onChange(value + text.replace(/\r?\n|\r/g, " ")), {
    isActive,
  });
  const shown = masked
    ? "*".repeat([...graphemes.segment(value)].length)
    : value;
  return (
    <Text>
      {shown}
      {focused && <Text inverse> </Text>}
    </Text>
  );
}
