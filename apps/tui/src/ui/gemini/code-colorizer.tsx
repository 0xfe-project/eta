/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 * Modified for eta: colours from a fixed table of the 16 terminal colours instead of the theme manager, leaves code of an unknown language plain instead of guessing it, drops MaxSizedBox, line numbers and settings, and carries the extension table from DiffRenderer.tsx.
 */
import type {
  Element,
  ElementContent,
  Text as HastText,
  Root,
  RootContent,
} from "hast";
import type { ReactNode } from "react";
import { stripVTControlCharacters } from "node:util";
import { Box, Text } from "ink";
import { common, createLowlight } from "lowlight";
import { Fragment } from "react";
import { syntaxColor } from "./colors";

const lowlight = createLowlight(common);
const TAB_SPACES = "    ";

function renderHastNode(
  node: Root | Element | HastText | RootContent,
  inheritedColor: string | undefined,
): ReactNode {
  if (node.type === "text")
    return <Text color={inheritedColor}>{node.value}</Text>;

  // An element only groups its children and passes its colour down; the text nodes paint.
  if (node.type === "element") {
    const className = node.properties.className;
    const nodeClasses = Array.isArray(className) ? className.map(String) : [];
    let elementColor: string | undefined;
    for (let i = nodeClasses.length - 1; i >= 0; i--) {
      const color = syntaxColor(nodeClasses[i] ?? "");
      if (color !== undefined) {
        elementColor = color;
        break;
      }
    }
    const colorToPassDown = elementColor ?? inheritedColor;
    return node.children.map((child: ElementContent, index: number) => (
      // Children of one node never reorder, so the index names each.
      // eslint-disable-next-line react/no-array-index-key
      <Fragment key={index}>{renderHastNode(child, colorToPassDown)}</Fragment>
    ));
  }

  if (node.type === "root") {
    if (node.children.length === 0) return null;
    return node.children.map((child: RootContent, index: number) => (
      // eslint-disable-next-line react/no-array-index-key
      <Fragment key={index}>{renderHastNode(child, inheritedColor)}</Fragment>
    ));
  }

  return null;
}

/** One line of code as coloured text runs; plain in `defaultColor` when the language is unknown. */
export function colorizeLine(
  line: string,
  language: string | null,
  defaultColor: string | undefined,
): ReactNode {
  const strippedLine = stripVTControlCharacters(line);
  if (language === null || !lowlight.registered(language))
    return <Text color={defaultColor}>{strippedLine}</Text>;
  try {
    const rendered = renderHastNode(
      lowlight.highlight(language, strippedLine),
      defaultColor,
    );
    return rendered ?? strippedLine;
  } catch {
    // lowlight throws on grammar errors; the line still reads plain.
    return <Text color={defaultColor}>{strippedLine}</Text>;
  }
}

export interface ColorizeCodeOptions {
  code: string;
  language: string | null;
  width: number;
  defaultColor: string | undefined;
}

/**
 * Code as one Ink line per source line, highlighted line by line, each wrapping within `width`.
 * One trailing newline is not a line of its own.
 */
export function colorizeCode({
  code,
  language,
  width,
  defaultColor,
}: ColorizeCodeOptions): ReactNode {
  // A tab's width depends on the terminal's tab stops, so it is spaces before anything measures it.
  const lines = code
    .replace(/\n$/, "")
    .split(/\r?\n/)
    .map((line) => line.replaceAll("\t", TAB_SPACES));
  return (
    <Box flexDirection="column" width={width}>
      {lines.map((line, index) => (
        // Lines never reorder, so the index names each.
        // eslint-disable-next-line react/no-array-index-key
        <Box key={index} minHeight={1}>
          <Text color={defaultColor} wrap="wrap">
            {colorizeLine(line, language, defaultColor)}
          </Text>
        </Box>
      ))}
    </Box>
  );
}

const LANGUAGE_BY_EXTENSION: Readonly<Record<string, string>> = {
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "javascript",
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "typescript",
  py: "python",
  json: "json",
  css: "css",
  scss: "scss",
  html: "xml",
  xml: "xml",
  sh: "bash",
  bash: "bash",
  md: "markdown",
  yaml: "yaml",
  yml: "yaml",
  toml: "ini",
  ini: "ini",
  txt: "plaintext",
  java: "java",
  kt: "kotlin",
  c: "c",
  h: "c",
  cpp: "cpp",
  hpp: "cpp",
  cs: "csharp",
  go: "go",
  rs: "rust",
  rb: "ruby",
  php: "php",
  sql: "sql",
  swift: "swift",
  lua: "lua",
};

/** The highlighting language for a file, by its extension; null when there is none or it is unknown. */
export function languageForPath(path: string | undefined): string | null {
  const name = path?.split(/[/\\]/).pop() ?? "";
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return null;
  const extension = name.slice(dot + 1).toLowerCase();
  return Object.hasOwn(LANGUAGE_BY_EXTENSION, extension)
    ? (LANGUAGE_BY_EXTENSION[extension] ?? null)
    : null;
}
