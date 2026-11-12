/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 * Modified for eta: returns styled spans instead of a chalk-coloured string, takes its colours from a palette, carries `stripUnsafeCharacters` from textUtils.ts without strip-ansi, and bounds what each inline marker may span so a line parses in time linear in its length; the code spans and URLs kept from the LaTeX pass are found in one scan.
 */
import type { Palette } from "./colors";
import type { InlineSpan } from "./styled-spans";
import { stripVTControlCharacters } from "node:util";
import { convertLatexToUnicode } from "./latex-to-unicode";

// Constants for Markdown parsing
const BOLD_MARKER_LENGTH = 2; // For "**"
const ITALIC_MARKER_LENGTH = 1; // For "*" or "_"
const STRIKETHROUGH_MARKER_LENGTH = 2; // For "~~")
const INLINE_CODE_MARKER_LENGTH = 1; // For "`"
const UNDERLINE_TAG_START_LENGTH = 3; // For "<u>"
const UNDERLINE_TAG_END_LENGTH = 4; // For "</u>"

/**
 * The most characters one inline span (emphasis, code, a link's text or address, underline) may
 * hold. Each place an opening marker stands is tried against at most this many characters, so a
 * line with many openers and no closers costs its length times this, not its length squared.
 */
const SPAN_LIMIT = 200;
const SPAN = `.{0,${SPAN_LIMIT}}?`;
const SPAN_NONEMPTY = `.{1,${SPAN_LIMIT}}?`;
// A link's text holds no brackets and its address no parentheses or spaces, so neither can run
// past the next opener.
const LINK_TEXT = `[^[\\]]{0,${SPAN_LIMIT}}`;
const LINK_URL = `[^()\\s]{0,${SPAN_LIMIT}}`;
const INLINE_PATTERN = [
  `\\*\\*\\*${SPAN}\\*\\*\\*`,
  `\\*\\*${SPAN}\\*\\*`,
  `\\*${SPAN}\\*`,
  `_${SPAN}_`,
  `~~${SPAN}~~`,
  `\\[${LINK_TEXT}\\]\\(${LINK_URL}\\)`,
  `\`{1,${SPAN_LIMIT}}${SPAN_NONEMPTY}\`{1,${SPAN_LIMIT}}`,
  `<u>${SPAN}<\\/u>`,
  `https?:\\/\\/\\S+`,
].join("|");

/**
 * Removes terminal control sequences and the characters that would move the cursor or change how
 * the line reads (C0 and C1 controls other than tab, line feed and carriage return, bidirectional
 * overrides, zero-width spaces).
 */
export function stripUnsafeCharacters(str: string): string {
  // The escape sequences go first, while their ESC still marks where each starts.
  const strippedAnsi = stripVTControlCharacters(str);
  // Lone C1 characters go before the second pass, which could otherwise read one (0x90 DCS) as
  // the start of a sequence and drop the text after it.
  const strippedWithRegex = [...strippedAnsi]
    .filter((char) => !isUnsafeCharacter(char.codePointAt(0) ?? 0))
    .join("");
  return stripVTControlCharacters(strippedWithRegex);
}

/** Zero-width spaces, bidirectional marks and overrides, and the byte order mark. */
const INVISIBLE_FORMAT_CHARACTERS = new Set([
  0x200b, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066,
  0x2067, 0x2068, 0x2069, 0xfeff,
]);
const TAB = 0x09;
const LINE_FEED = 0x0a;
const CARRIAGE_RETURN = 0x0d;

function isUnsafeCharacter(code: number): boolean {
  const c0 =
    code <= 0x1f &&
    code !== TAB &&
    code !== LINE_FEED &&
    code !== CARRIAGE_RETURN;
  const c1 = code >= 0x80 && code <= 0x9f;
  return c0 || c1 || INVISIBLE_FORMAT_CHARACTERS.has(code);
}

// Private-Use-Area codepoint used as a placeholder sentinel when masking
// inline code / URL spans from LaTeX conversion. Not touched by
// stripUnsafeCharacters and not matched by the markdown tokenizer.
const MASK_SENTINEL = String.fromCharCode(0xe000);
const MASK_PATTERN = new RegExp(`${MASK_SENTINEL}(\\d+)${MASK_SENTINEL}`, "g");

/**
 * Runs LaTeX conversion on `text` while keeping inline code spans and bare
 * URLs verbatim. Without masking, the LaTeX pass would happily rewrite
 * ``$\to$`` inside a backtick code span — violating the "code is verbatim"
 * contract — and could rewrite URL query strings containing `$`.
 */
const convertLatexPreservingSpans = (text: string): string => {
  const preserved: string[] = [];
  let masked = "";
  let from = 0;
  for (const span of verbatimSpans(text)) {
    const index = preserved.push(text.slice(span.start, span.end)) - 1;
    masked += `${text.slice(from, span.start)}${MASK_SENTINEL}${index}${MASK_SENTINEL}`;
    from = span.end;
  }
  masked += text.slice(from);
  const converted = convertLatexToUnicode(masked);
  return converted.replace(
    MASK_PATTERN,
    // Falls back to the literal match when the sentinel came from the input itself.
    (match, i: string) => preserved[Number(i)] ?? match,
  );
};

/**
 * The inline code spans and bare URLs of `text`, leftmost first, as `[start, end)`. A code span is
 * text on one line between two runs of backticks; when the runs differ in length it takes from
 * each as many as the shorter has, the ones next to the text. A URL that starts inside a code span
 * is part of it. Each character is read a bounded number of times, however the backticks fall.
 */
function verbatimSpans(text: string): { start: number; end: number }[] {
  const opener = /`+|https?:\/\/\S+/g;
  const body = /[^`\n]*/y;
  const backticks = /`*/y;
  const spans: { start: number; end: number }[] = [];
  for (
    let found = opener.exec(text);
    found !== null;
    found = opener.exec(text)
  ) {
    const start = found.index;
    const run = found[0];
    if (!run.startsWith("`")) {
      spans.push({ start, end: start + run.length });
      continue;
    }
    const bodyStart = start + run.length;
    body.lastIndex = bodyStart;
    const bodyEnd = bodyStart + (body.exec(text)?.[0].length ?? 0);
    backticks.lastIndex = bodyEnd;
    const closing = backticks.exec(text)?.[0].length ?? 0;
    if (bodyEnd === bodyStart || closing === 0) continue;
    const ticks = Math.min(run.length, closing);
    spans.push({ start: bodyStart - ticks, end: bodyEnd + ticks });
    opener.lastIndex = bodyEnd + ticks;
  }
  return spans;
}

type SpanStyle = Pick<
  InlineSpan,
  "bold" | "italic" | "strikethrough" | "underline"
>;

const withStyle = (spans: InlineSpan[], style: SpanStyle): InlineSpan[] =>
  spans.map((span) => ({ ...span, ...style }));

const plain = (text: string, color: string | undefined): InlineSpan => ({
  text,
  color,
});

/**
 * The spans one line of markdown draws as: emphasis, strikethrough, inline code, links, bare URLs
 * and `<u>` lose their markers and keep their style. Text outside any of them is `defaultColor`
 * (the palette's text colour when absent).
 */
export const parseInlineMarkdown = (
  rawText: string,
  defaultColor: string | undefined,
  palette: Palette,
): InlineSpan[] =>
  parseConverted(
    // Convert LaTeX-style math/commands to Unicode BEFORE tokenizing markdown,
    // so constructs like `$\{P_0, \dots, P_n\}$` are handled as a whole even
    // when they contain underscores (which the tokenizer would otherwise treat
    // as italic markers). Inline code and URLs are masked during the
    // conversion so their contents are preserved verbatim. Unknown `\foo`
    // sequences are left alone, so Windows paths and regex escapes survive.
    convertLatexPreservingSpans(rawText),
    defaultColor ?? palette.text,
    palette,
  );

function parseConverted(
  text: string,
  baseColor: string | undefined,
  palette: Palette,
): InlineSpan[] {
  if (text === "") return [];
  // Early return for plain text without markdown or URLs
  if (!/[*_~`<[hpst?:]/.test(text)) return [plain(text, baseColor)];

  const result: InlineSpan[] = [];
  const inlineRegex = new RegExp(INLINE_PATTERN, "g");
  let lastIndex = 0;
  const nested = (inner: string) => parseConverted(inner, baseColor, palette);

  for (const match of text.matchAll(inlineRegex)) {
    if (match.index > lastIndex)
      result.push(plain(text.slice(lastIndex, match.index), baseColor));

    const fullMatch = match[0];
    const matchEnd = match.index + fullMatch.length;
    let styled: InlineSpan[] = [];

    if (
      fullMatch.endsWith("***") &&
      fullMatch.startsWith("***") &&
      fullMatch.length > (BOLD_MARKER_LENGTH + ITALIC_MARKER_LENGTH) * 2
    ) {
      styled = withStyle(
        nested(
          fullMatch.slice(
            BOLD_MARKER_LENGTH + ITALIC_MARKER_LENGTH,
            -BOLD_MARKER_LENGTH - ITALIC_MARKER_LENGTH,
          ),
        ),
        { bold: true, italic: true },
      );
    } else if (
      fullMatch.endsWith("**") &&
      fullMatch.startsWith("**") &&
      fullMatch.length > BOLD_MARKER_LENGTH * 2
    ) {
      styled = withStyle(
        nested(fullMatch.slice(BOLD_MARKER_LENGTH, -BOLD_MARKER_LENGTH)),
        { bold: true },
      );
    } else if (
      fullMatch.length > ITALIC_MARKER_LENGTH * 2 &&
      ((fullMatch.startsWith("*") && fullMatch.endsWith("*")) ||
        (fullMatch.startsWith("_") && fullMatch.endsWith("_"))) &&
      !/\w/.test(text.substring(match.index - 1, match.index)) &&
      !/\w/.test(text.substring(matchEnd, matchEnd + 1)) &&
      !/\S[./\\]/.test(text.substring(match.index - 2, match.index)) &&
      !/[./\\]\S/.test(text.substring(matchEnd, matchEnd + 2))
    ) {
      styled = withStyle(
        nested(fullMatch.slice(ITALIC_MARKER_LENGTH, -ITALIC_MARKER_LENGTH)),
        { italic: true },
      );
    } else if (
      fullMatch.startsWith("~~") &&
      fullMatch.endsWith("~~") &&
      fullMatch.length > STRIKETHROUGH_MARKER_LENGTH * 2
    ) {
      styled = withStyle(
        nested(
          fullMatch.slice(
            STRIKETHROUGH_MARKER_LENGTH,
            -STRIKETHROUGH_MARKER_LENGTH,
          ),
        ),
        { strikethrough: true },
      );
    } else if (
      fullMatch.startsWith("`") &&
      fullMatch.endsWith("`") &&
      fullMatch.length > INLINE_CODE_MARKER_LENGTH
    ) {
      // eslint-disable-next-line regexp/no-super-linear-backtracking, regexp/no-misleading-capturing-group -- the match is one inline code span
      const codeMatch = fullMatch.match(/^(`+)(.+?)\1$/s);
      if (codeMatch?.[2]) styled = [plain(codeMatch[2], palette.accent)];
    } else if (
      fullMatch.startsWith("[") &&
      fullMatch.includes("](") &&
      fullMatch.endsWith(")")
    ) {
      const linkMatch = fullMatch.match(/^\[([^[\]]*)\]\(([^()\s]*)\)$/);
      if (linkMatch) {
        const linkText = linkMatch[1] ?? "";
        const url = linkMatch[2] ?? "";
        styled = [
          ...nested(linkText),
          plain(" (", baseColor),
          plain(url, palette.accent),
          plain(")", baseColor),
        ];
      }
    } else if (
      fullMatch.startsWith("<u>") &&
      fullMatch.endsWith("</u>") &&
      fullMatch.length >
        UNDERLINE_TAG_START_LENGTH + UNDERLINE_TAG_END_LENGTH - 1
    ) {
      styled = withStyle(
        nested(
          fullMatch.slice(
            UNDERLINE_TAG_START_LENGTH,
            -UNDERLINE_TAG_END_LENGTH,
          ),
        ),
        { underline: true },
      );
    } else if (/^https?:\/\//.test(fullMatch)) {
      styled = [plain(fullMatch, palette.accent)];
    }

    result.push(
      ...(styled.length > 0 ? styled : [plain(fullMatch, baseColor)]),
    );
    lastIndex = matchEnd;
  }

  if (lastIndex < text.length)
    result.push(plain(text.slice(lastIndex), baseColor));

  return result;
}
