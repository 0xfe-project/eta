/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 * Modified for eta: split out of DiffRenderer.tsx (components/messages), with the hunk start read in one step.
 */
export interface DiffLine {
  type: "add" | "del" | "context" | "hunk" | "other";
  oldLine?: number;
  newLine?: number;
  content: string;
}

export function parseDiffWithLineNumbers(diffContent: string): DiffLine[] {
  const lines = diffContent.split(/\r?\n/);
  const result: DiffLine[] = [];
  let currentOldLine = 0;
  let currentNewLine = 0;
  let inHunk = false;
  // eslint-disable-next-line regexp/no-super-linear-backtracking -- one line of a diff at a time
  const hunkHeaderRegex = /^@@ -(\d+),?\d* \+(\d+),?\d* @@/;

  for (const line of lines) {
    const hunkMatch = line.match(hunkHeaderRegex);
    if (hunkMatch) {
      // Each number counts up before its line is pushed, so start one before the hunk's first.
      currentOldLine = Number.parseInt(hunkMatch[1] ?? "0", 10) - 1;
      currentNewLine = Number.parseInt(hunkMatch[2] ?? "0", 10) - 1;
      inHunk = true;
      result.push({ type: "hunk", content: line });
      continue;
    }
    // Before the first hunk is the file header.
    if (!inHunk) continue;
    if (line.startsWith("+")) {
      currentNewLine++;
      result.push({
        type: "add",
        newLine: currentNewLine,
        content: line.substring(1),
      });
    } else if (line.startsWith("-")) {
      currentOldLine++;
      result.push({
        type: "del",
        oldLine: currentOldLine,
        content: line.substring(1),
      });
    } else if (line.startsWith(" ")) {
      currentOldLine++;
      currentNewLine++;
      result.push({
        type: "context",
        oldLine: currentOldLine,
        newLine: currentNewLine,
        content: line.substring(1),
      });
    } else if (line.startsWith("\\")) {
      // "\ No newline at end of file"
      result.push({ type: "other", content: line });
    }
  }
  return result;
}
