import type { TextRange } from "./typed-ranges";
import { Text } from "ink";
import stringWidth from "string-width";
import { useTheme } from "../../extensions/react";
import { inkColor } from "../theme";

/** `name` cut into pieces, each bold or not, along the sorted, non-overlapping `bold` ranges. */
function pieces(
  name: string,
  bold: readonly TextRange[],
): { text: string; bold: boolean; start: number }[] {
  const out: { text: string; bold: boolean; start: number }[] = [];
  let at = 0;
  for (const [start, end] of bold) {
    if (start > at)
      out.push({ text: name.slice(at, start), bold: false, start: at });
    out.push({ text: name.slice(start, end), bold: true, start });
    at = end;
  }
  if (at < name.length)
    out.push({ text: name.slice(at), bold: false, start: at });
  return out;
}

const SELECTED_MARK = "› ";
const UNSELECTED_MARK = "  ";

/** Columns between a name and its detail. */
const DETAIL_GAP = 2;

/**
 * One row of a completion menu: `› ` before the selected row and two spaces before the others;
 * the selected row's name in the accent colour, the others' in the default colour; the `bold`
 * ranges of the name bold; the detail, muted, two columns after the name filled out to
 * `nameWidth` columns. A row too long for its width ends in `…`. No row has a background.
 */
export function CompletionRow({
  name,
  nameWidth = 0,
  bold,
  detail,
  selected,
}: {
  name: string;
  nameWidth?: number;
  bold: readonly TextRange[];
  detail?: string;
  selected: boolean;
}) {
  const theme = useTheme();
  const gap = " ".repeat(
    Math.max(0, nameWidth - stringWidth(name)) + DETAIL_GAP,
  );
  return (
    <Text
      wrap="truncate-end"
      color={selected ? inkColor(theme.accent) : undefined}
    >
      {selected ? SELECTED_MARK : UNSELECTED_MARK}
      {pieces(name, bold).map((piece) => (
        <Text key={piece.start} bold={piece.bold}>
          {piece.text}
        </Text>
      ))}
      {detail !== undefined && detail !== "" && (
        <Text color={inkColor(theme.muted)}>{gap + detail}</Text>
      )}
    </Text>
  );
}
