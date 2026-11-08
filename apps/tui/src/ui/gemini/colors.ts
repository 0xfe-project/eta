/**
 * The colours the components in this directory paint with. They come from Gemini CLI, where they
 * read a theme manager of their own; here the caller hands them a palette, and code is coloured
 * from one fixed table of the 16 terminal colours, so it follows the terminal's own theme.
 *
 * This file is eta's own, not taken from Gemini CLI.
 */

/** Ink colours; `undefined` leaves the terminal's own colour. */
export interface Palette {
  /** Ordinary text. */
  text: string | undefined;
  /** Secondary text: rules, line numbers, separators. */
  muted: string | undefined;
  /** Headings, inline code, links, table headers. */
  accent: string | undefined;
  /** Table borders. */
  border: string | undefined;
  /** Added lines of a diff. */
  success: string | undefined;
  /** Removed lines of a diff. */
  error: string | undefined;
}

/**
 * The colour of each highlight.js class lowlight emits. A class not listed takes the colour of the
 * element around it, and at the top the text colour.
 */
const SYNTAX_COLORS: Readonly<Record<string, string>> = {
  "hljs-keyword": "magenta",
  "hljs-selector-tag": "magenta",
  "hljs-doctag": "magenta",
  "hljs-string": "green",
  "hljs-regexp": "red",
  "hljs-addition": "green",
  "hljs-deletion": "red",
  "hljs-comment": "gray",
  "hljs-quote": "gray",
  "hljs-meta": "gray",
  "hljs-number": "yellow",
  "hljs-literal": "yellow",
  "hljs-symbol": "yellow",
  "hljs-bullet": "yellow",
  "hljs-title": "blue",
  "hljs-section": "blue",
  "hljs-built_in": "cyan",
  "hljs-type": "cyan",
  "hljs-attr": "cyan",
  "hljs-attribute": "cyan",
  "hljs-selector-class": "cyan",
  "hljs-selector-id": "cyan",
  "hljs-name": "blue",
  "hljs-tag": "blue",
  "hljs-variable": "red",
  "hljs-template-variable": "red",
  "hljs-link": "blue",
};

/** The colour for a highlight.js class, if the table gives it one. */
export function syntaxColor(className: string): string | undefined {
  return Object.hasOwn(SYNTAX_COLORS, className)
    ? SYNTAX_COLORS[className]
    : undefined;
}
