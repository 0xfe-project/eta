import type { ReactElement } from "react";
import type { FrameStyle, SgrPair } from "../contract";
import { renderToString, Text } from "ink";
import { draw } from "./lines";

const MARK = "x";
/** Wide enough that a name is never wrapped while it is cleaned; the layout cuts it to fit. */
const NAME_COLUMNS = 1000;

/**
 * The style of a frame in `color` (an Ink colour; undefined is the terminal's own) around a reply
 * by `name`. The codes are the ones Ink itself writes for that colour, so they follow the colour
 * level of the terminal; without colours they are empty.
 */
export function frameStyle(
  name: string,
  color: string | undefined,
): FrameStyle {
  return { name: cleanName(name), ...colourCodes(color) };
}

// Ink draws through chalk, which settles its colour level when it loads, so a colour's codes and a
// name's clean form stay the same for the life of the process.
const codesByColour = new Map<string | undefined, Omit<FrameStyle, "name">>();
const cleanNames = new Map<string, string>();

function colourCodes(color: string | undefined): Omit<FrameStyle, "name"> {
  const kept = codesByColour.get(color);
  if (kept !== undefined) return kept;
  const codes = {
    border: sgrOf(<Text color={color}>{MARK}</Text>),
    nameStyle: sgrOf(
      <Text bold color={color}>
        {MARK}
      </Text>,
    ),
  };
  codesByColour.set(color, codes);
  return codes;
}

function cleanName(name: string): string {
  const kept = cleanNames.get(name);
  if (kept !== undefined) return kept;
  const clean = oneLine(name);
  cleanNames.set(name, clean);
  return clean;
}

/** The codes Ink writes before and after a one-character text. */
function sgrOf(node: ReactElement): SgrPair {
  const output = renderToString(node, { columns: NAME_COLUMNS });
  const at = output.indexOf(MARK);
  return { open: output.slice(0, at), close: output.slice(at + MARK.length) };
}

/** The name as Ink draws it, control characters gone, its lines joined by spaces. */
function oneLine(name: string): string {
  return draw(<Text>{name}</Text>, NAME_COLUMNS)
    .plain.filter((line) => line !== "")
    .join(" ");
}
