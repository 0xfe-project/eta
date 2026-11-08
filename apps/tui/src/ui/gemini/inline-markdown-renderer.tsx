/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 * Modified for eta: draws the parsed spans as nested Ink `<Text>` instead of printing a chalk string, and takes its colours from a palette.
 */
import type { Palette } from "./colors";
import type { InlineSpan } from "./styled-spans";
import { Text } from "ink";
import { parseInlineMarkdown, stripUnsafeCharacters } from "./markdown-parsing";

/** Spans as Ink text runs, to sit inside one `<Text>`. */
export function Spans({ spans }: { spans: readonly InlineSpan[] }) {
  return spans.map((span, index) => (
    <Text
      // The spans of one line never reorder, so the index names each.
      // eslint-disable-next-line react/no-array-index-key
      key={index}
      color={span.color}
      bold={span.bold}
      italic={span.italic}
      strikethrough={span.strikethrough}
      underline={span.underline}
    >
      {span.text}
    </Text>
  ));
}

interface RenderInlineProps {
  text: string;
  defaultColor: string | undefined;
  palette: Palette;
}

/** One line of markdown, styled; it wraps with the `<Text>` it is put in. */
export function RenderInline({
  text,
  defaultColor,
  palette,
}: RenderInlineProps) {
  const spans = parseInlineMarkdown(
    stripUnsafeCharacters(text),
    defaultColor,
    palette,
  );
  return (
    <Text>
      <Spans spans={spans} />
    </Text>
  );
}
