/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 * Modified for eta: drops the settings, alternate-buffer and height limits (and with them the pending-code truncation) and the raw-markdown mode, takes its colours from a palette, keeps a list item's indentation within the width, and draws a fence the text ends on with nothing after it as the line it is.
 */
import type { ReactNode } from "react";
import type { Palette } from "./colors";
import { Box, Text } from "ink";
import { colorizeCode } from "./code-colorizer";
import { RenderInline } from "./inline-markdown-renderer";
import { stripUnsafeCharacters } from "./markdown-parsing";
import { TableRenderer } from "./table-renderer";

interface MarkdownDisplayProps {
  text: string;
  width: number;
  palette: Palette;
}

// Constants for Markdown parsing and rendering

const EMPTY_LINE_HEIGHT = 1;
const CODE_BLOCK_PREFIX_PADDING = 1;
const LIST_ITEM_PREFIX_PADDING = 1;
const LIST_ITEM_TEXT_FLEX_GROW = 1;
/** The fewest columns a list item keeps for its text, however deep it is nested. */
const LIST_ITEM_MIN_TEXT_WIDTH = 10;

const headerRegex = /^ *(#{1,4}) +(.*)/;
const codeFenceRegex = /^ *(`{3,}|~{3,}) *(?:(\w+) *)?$/;
const ulItemRegex = /^([ \t]*)([-*+]) +(.*)/;
const olItemRegex = /^([ \t]*)(\d+)\. +(.*)/;

const hrRegex = /^ *(?:[-*_] *){3,}$/;
const tableRowRegex = /^\s*\|(.+)\|\s*$/;
const tableSeparatorRegex =
  /^\s*(?:\|\s*)?:?-+:?\s*(?:\|\s*:?-+:?\s*)+(?:\|\s*)?$/;

const splitCells = (row: string): string[] =>
  row.split("|").map((cell) => cell.trim());

/**
 * Markdown as Ink lines: headings, paragraphs, lists, rules, fenced code (highlighted by its
 * language) and tables. A code fence that is not closed yet runs to the end of the text, so text
 * still being written draws as it will once it is; one with nothing after it draws as the line it
 * is. A list item nested deeper than the width allows is indented no further.
 */
export function MarkdownDisplay({
  text,
  width,
  palette,
}: MarkdownDisplayProps) {
  if (!text) return null;

  const lines = text.split(/\r?\n/);
  const contentBlocks: ReactNode[] = [];
  let inCodeBlock = false;
  let lastLineEmpty = true;
  let codeBlockContent: string[] = [];
  let codeBlockLang: string | null = null;
  let codeBlockFence = "";
  let codeBlockFenceLine = "";
  let inTable = false;
  let tableRows: string[][] = [];
  let tableHeaders: string[] = [];

  function addContentBlock(block: ReactNode) {
    contentBlocks.push(block);
    lastLineEmpty = false;
  }

  const paragraph = (key: string, line: string) => (
    <Box key={key}>
      <Text wrap="wrap" color={palette.text}>
        <RenderInline
          text={line}
          defaultColor={palette.text}
          palette={palette}
        />
      </Text>
    </Box>
  );

  lines.forEach((line, index) => {
    const key = `line-${index}`;

    if (inCodeBlock) {
      const fenceMatch = line.match(codeFenceRegex);
      const fence = fenceMatch?.[1];
      if (
        fence !== undefined &&
        fence.startsWith(codeBlockFence[0] ?? "") &&
        fence.length >= codeBlockFence.length
      ) {
        addContentBlock(
          <RenderCodeBlock
            key={key}
            content={codeBlockContent}
            lang={codeBlockLang}
            width={width}
            palette={palette}
          />,
        );
        inCodeBlock = false;
        codeBlockContent = [];
        codeBlockLang = null;
        codeBlockFence = "";
      } else {
        codeBlockContent.push(line);
      }
      return;
    }

    const codeFenceMatch = line.match(codeFenceRegex);
    const headerMatch = line.match(headerRegex);
    const ulMatch = line.match(ulItemRegex);
    const olMatch = line.match(olItemRegex);
    const hrMatch = line.match(hrRegex);
    const tableRowMatch = line.match(tableRowRegex);
    const tableSeparatorMatch = line.match(tableSeparatorRegex);

    if (codeFenceMatch) {
      inCodeBlock = true;
      codeBlockFenceLine = line;
      codeBlockFence = codeFenceMatch[1] ?? "";
      codeBlockLang = codeFenceMatch[2] || null;
    } else if (tableRowMatch && !inTable) {
      // A row starts a table only when the next line is its separator.
      if (tableSeparatorRegex.test(lines[index + 1] ?? "")) {
        inTable = true;
        tableHeaders = splitCells(tableRowMatch[1] ?? "");
        tableRows = [];
      } else {
        addContentBlock(paragraph(key, line));
      }
    } else if (inTable && tableSeparatorMatch) {
      // The separator was seen with the header row.
    } else if (inTable && tableRowMatch) {
      const cells = splitCells(tableRowMatch[1] ?? "");
      // A row has as many cells as the header.
      while (cells.length < tableHeaders.length) cells.push("");
      if (cells.length > tableHeaders.length)
        cells.length = tableHeaders.length;
      tableRows.push(cells);
    } else if (inTable && !tableRowMatch) {
      // End of table
      if (tableHeaders.length > 0 && tableRows.length > 0) {
        addContentBlock(
          <TableRenderer
            key={`table-${contentBlocks.length}`}
            headers={tableHeaders}
            rows={tableRows}
            width={width}
            palette={palette}
          />,
        );
      }
      inTable = false;
      tableRows = [];
      tableHeaders = [];

      // The line after the table is ordinary text.
      if (line.trim().length > 0) addContentBlock(paragraph(key, line));
    } else if (hrMatch) {
      addContentBlock(
        <Box key={key}>
          <Text color={palette.muted}>---</Text>
        </Box>,
      );
    } else if (headerMatch) {
      const level = (headerMatch[1] ?? "").length;
      const headerText = headerMatch[2] ?? "";
      addContentBlock(
        <Box key={key}>
          <Heading level={level} text={headerText} palette={palette} />
        </Box>,
      );
    } else if (ulMatch) {
      addContentBlock(
        <RenderListItem
          key={key}
          itemText={ulMatch[3] ?? ""}
          type="ul"
          marker={ulMatch[2] ?? "-"}
          leadingWhitespace={ulMatch[1] ?? ""}
          width={width}
          palette={palette}
        />,
      );
    } else if (olMatch) {
      addContentBlock(
        <RenderListItem
          key={key}
          itemText={olMatch[3] ?? ""}
          type="ol"
          marker={olMatch[2] ?? "1"}
          leadingWhitespace={olMatch[1] ?? ""}
          width={width}
          palette={palette}
        />,
      );
    } else if (line.trim().length === 0) {
      if (!lastLineEmpty) {
        contentBlocks.push(
          <Box key={`spacer-${index}`} height={EMPTY_LINE_HEIGHT} />,
        );
        lastLineEmpty = true;
      }
    } else {
      addContentBlock(paragraph(key, line));
    }
  });

  if (inCodeBlock && codeBlockContent.length === 0) {
    // Written as it is: inline parsing would read a run of backticks as code.
    addContentBlock(
      <Box key="line-eof">
        <Text wrap="wrap" color={palette.text}>
          {stripUnsafeCharacters(codeBlockFenceLine)}
        </Text>
      </Box>,
    );
  } else if (inCodeBlock) {
    addContentBlock(
      <RenderCodeBlock
        key="line-eof"
        content={codeBlockContent}
        lang={codeBlockLang}
        width={width}
        palette={palette}
      />,
    );
  }

  // A table that runs to the end of the text.
  if (inTable && tableHeaders.length > 0 && tableRows.length > 0) {
    addContentBlock(
      <TableRenderer
        key={`table-${contentBlocks.length}`}
        headers={tableHeaders}
        rows={tableRows}
        width={width}
        palette={palette}
      />,
    );
  }

  return <Box flexDirection="column">{contentBlocks}</Box>;
}

interface HeadingProps {
  level: number;
  text: string;
  palette: Palette;
}

function Heading({ level, text, palette }: HeadingProps) {
  const inline = (color: string | undefined) => (
    <RenderInline text={text} defaultColor={color} palette={palette} />
  );
  switch (level) {
    case 1:
    case 2:
      return (
        <Text wrap="wrap" bold color={palette.accent}>
          {inline(palette.accent)}
        </Text>
      );
    case 3:
      return (
        <Text wrap="wrap" bold color={palette.text}>
          {inline(palette.text)}
        </Text>
      );
    case 4:
      return (
        <Text wrap="wrap" italic color={palette.muted}>
          {inline(palette.muted)}
        </Text>
      );
    default:
      return (
        <Text wrap="wrap" color={palette.text}>
          {inline(palette.text)}
        </Text>
      );
  }
}

interface RenderCodeBlockProps {
  content: string[];
  lang: string | null;
  width: number;
  palette: Palette;
}

function RenderCodeBlock({
  content,
  lang,
  width,
  palette,
}: RenderCodeBlockProps) {
  return (
    <Box
      paddingLeft={CODE_BLOCK_PREFIX_PADDING}
      flexDirection="column"
      width={width}
      flexShrink={0}
    >
      {colorizeCode({
        code: content.join("\n"),
        language: lang,
        width: width - CODE_BLOCK_PREFIX_PADDING,
        defaultColor: palette.text,
      })}
    </Box>
  );
}

interface RenderListItemProps {
  itemText: string;
  type: "ul" | "ol";
  marker: string;
  leadingWhitespace: string;
  width: number;
  palette: Palette;
}

function RenderListItem({
  itemText,
  type,
  marker,
  leadingWhitespace,
  width,
  palette,
}: RenderListItemProps) {
  const prefix = type === "ol" ? `${marker}. ` : `${marker} `;
  const prefixWidth = prefix.length;
  // The item's own indentation, plus the standard padding before every marker.
  const indentation = Math.min(
    leadingWhitespace.length + LIST_ITEM_PREFIX_PADDING,
    Math.max(0, width - prefixWidth - LIST_ITEM_MIN_TEXT_WIDTH),
  );

  return (
    <Box paddingLeft={indentation} flexDirection="row">
      <Box width={prefixWidth} flexShrink={0}>
        <Text color={palette.text}>{prefix}</Text>
      </Box>
      <Box flexGrow={LIST_ITEM_TEXT_FLEX_GROW}>
        <Text wrap="wrap" color={palette.text}>
          <RenderInline
            text={itemText}
            defaultColor={palette.text}
            palette={palette}
          />
        </Text>
      </Box>
    </Box>
  );
}
