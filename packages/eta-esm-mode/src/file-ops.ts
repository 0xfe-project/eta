import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { cwd } from "node:process";
import { rgPath } from "@vscode/ripgrep";
import { execa } from "execa";

/**
 * Search result from ripgrep
 */
export interface SearchResult {
  /** Relative path to the file */
  file: string;
  /** Line number (1-indexed) */
  line: number;
  /** Column number (optional, 1-indexed) */
  column?: number;
  /** Full text of the matched line */
  text: string;
  /** Matched substring (if ripgrep provides it) */
  match?: string;
}

/**
 * Search options
 */
export interface SearchOptions {
  /** File pattern filter (e.g., "*.ts") */
  glob?: string;
  /** Search directory (defaults to current working directory) */
  cwd?: string;
  /** Maximum number of results to return (default: 100) */
  limit?: number;
}

/**
 * View options
 */
export interface ViewOptions {
  /** Starting line number (1-indexed, default: 1) */
  start?: number;
  /** Maximum number of lines to read (default: 50) */
  limit?: number;
}

/**
 * Search file contents using ripgrep.
 *
 * @param pattern - Search pattern (supports regex)
 * @param options - Search options
 * @returns Array of search results
 *
 * @example
 * ```ts
 * const results = await search("export.*function", { glob: "*.ts", limit: 50 });
 * for (const r of results) {
 *   console.log(`${r.file}:${r.line} - ${r.text}`);
 * }
 * ```
 */
export async function search(
  pattern: string,
  options: SearchOptions = {},
): Promise<SearchResult[]> {
  const { glob, cwd: workingDir = cwd(), limit = 100 } = options;

  const args = [
    "--json",
    "--line-number",
    "--column",
    "--no-heading",
    "--with-filename",
  ];

  if (glob) {
    args.push("--glob", glob);
  }

  args.push("--", pattern);

  try {
    const { stdout } = await execa(rgPath, args, {
      cwd: workingDir,
      stdin: "ignore",
    });

    const results: SearchResult[] = [];
    const lines = stdout
      .trim()
      .split("\n")
      .filter((line) => line);

    for (const line of lines) {
      if (results.length >= limit) break;

      const parsed = JSON.parse(line);

      if (parsed.type === "match") {
        const data = parsed.data;
        const result: SearchResult = {
          file: data.path.text,
          line: data.line_number,
          text: data.lines.text.trimEnd(),
        };

        // Add column if available
        if (data.submatches && data.submatches.length > 0) {
          result.column = data.submatches[0].start + 1; // Convert to 1-indexed
          result.match = data.submatches[0].match.text;
        }

        results.push(result);
      }
    }

    return results;
  } catch (err: any) {
    // ripgrep exits with 1 if no matches found
    if (err.exitCode === 1) {
      return [];
    }

    // For other errors, throw with more context
    throw new Error(`ripgrep error: ${err.stderr || err.message}`);
  }
}

/**
 * View file contents with line numbers.
 *
 * @param path - File path (relative or absolute)
 * @param options - View options
 * @returns File contents with line numbers
 *
 * @example
 * ```ts
 * const code = await view("src/agent.ts", { start: 100, limit: 20 });
 * // "100: export class Agent {\n101:   constructor(...) {..."
 * ```
 */
export async function view(
  path: string,
  options: ViewOptions = {},
): Promise<string> {
  const { start = 1, limit = 50 } = options;

  if (start < 1) {
    throw new Error(`start must be >= 1, got ${start}`);
  }

  const resolvedPath = resolve(path);
  const content = await readFile(resolvedPath, "utf-8");
  const lines = content.split("\n");

  if (start > lines.length) {
    return "";
  }

  const endLine = Math.min(start + limit - 1, lines.length);
  const result: string[] = [];

  for (let i = start; i <= endLine; i++) {
    result.push(`${i}: ${lines[i - 1]}`);
  }

  return result.join("\n");
}

/**
 * Edit file by exact text replacement.
 *
 * The oldText must match exactly once in the file, otherwise the operation fails.
 *
 * @param path - File path (relative or absolute)
 * @param oldText - Text to replace (must match exactly once)
 * @param newText - Replacement text
 *
 * @example
 * ```ts
 * await edit(
 *   "src/config.ts",
 *   "timeout: 5000",
 *   "timeout: 10000"
 * );
 * ```
 */
export async function edit(
  path: string,
  oldText: string,
  newText: string,
): Promise<void> {
  const resolvedPath = resolve(path);
  const content = await readFile(resolvedPath, "utf-8");

  // Count occurrences of oldText
  const occurrences = countOccurrences(content, oldText);

  if (occurrences === 0) {
    throw new Error(
      `No match found for:\n${oldText.slice(0, 100)}${oldText.length > 100 ? "..." : ""}`,
    );
  }

  if (occurrences > 1) {
    throw new Error(
      `Match is not unique, found ${occurrences} occurrences:\n${oldText.slice(0, 100)}${oldText.length > 100 ? "..." : ""}`,
    );
  }

  // Perform replacement
  const newContent = content.replace(oldText, newText);

  await writeFile(resolvedPath, newContent, "utf-8");
}

/**
 * Count exact occurrences of a substring in a string.
 */
function countOccurrences(text: string, substring: string): number {
  let count = 0;
  let pos = 0;

  while (true) {
    const index = text.indexOf(substring, pos);
    if (index === -1) break;
    count++;
    pos = index + substring.length;
  }

  return count;
}
