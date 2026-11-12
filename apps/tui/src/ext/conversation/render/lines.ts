import type { ReactNode } from "react";
import { stripVTControlCharacters } from "node:util";
import { renderToString } from "ink";

/** Terminal lines, coloured and plain, index for index. */
export interface Lines {
  styled: string[];
  plain: string[];
}

export const NO_LINES: Lines = { styled: [], plain: [] };

/** Columns a line mark and the space after it take; wrapped and indented lines start this far in. */
export const MARK_WIDTH = 2;

// eslint-disable-next-line no-control-regex
const SGR_AT_END = /(?:\u001B\[[\d;]*m)*$/;

/**
 * An Ink node as the lines it draws at `width` columns, each without trailing white space. Ink
 * pads and wraps; nothing is cut here, so a node must already fit.
 */
export function draw(node: ReactNode, width: number): Lines {
  const output = renderToString(node, { columns: Math.max(1, width) });
  if (output === "") return NO_LINES;
  const trimmed = output.split("\n").map(trimEndStyled);
  const plain = trimmed.map(stripVTControlCharacters);
  // A line with nothing to show carries no colour codes either.
  const styled = trimmed.map((line, i) => (plain[i] === "" ? "" : line));
  return { styled, plain };
}

/** The line without the white space at its end, keeping the colour codes that close it. */
function trimEndStyled(line: string): string {
  let rest = line;
  for (;;) {
    const closing = rest.match(SGR_AT_END)?.[0] ?? "";
    const body = rest.slice(0, rest.length - closing.length);
    const trimmed = body.trimEnd();
    if (trimmed === body) return rest;
    rest = trimmed + closing;
  }
}

/** The lines moved right by `columns` spaces; an empty line stays empty. */
export function indent(lines: Lines, columns: number): Lines {
  const pad = " ".repeat(columns);
  const shift = (line: string, plain: string) =>
    plain === "" ? "" : pad + line;
  return {
    styled: lines.styled.map((line, i) => shift(line, lines.plain[i] ?? "")),
    plain: lines.plain.map((line) => shift(line, line)),
  };
}

export function concat(...parts: Lines[]): Lines {
  return {
    styled: parts.flatMap((part) => part.styled),
    plain: parts.flatMap((part) => part.plain),
  };
}

export function slice(lines: Lines, start: number, end?: number): Lines {
  return {
    styled: lines.styled.slice(start, end),
    plain: lines.plain.slice(start, end),
  };
}

/** The lines without the blank ones at either end. */
export function trimBlank(lines: Lines): Lines {
  let start = 0;
  let end = lines.plain.length;
  while (start < end && lines.plain[start] === "") start++;
  while (end > start && lines.plain[end - 1] === "") end--;
  return slice(lines, start, end);
}
