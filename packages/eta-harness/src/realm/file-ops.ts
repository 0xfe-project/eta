import type { Realm } from "./realm";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { cwd } from "node:process";

import { ripgrep } from "ripgrep";

/**
 * The three file operations a script reaches for first, as realm top-level
 * globals. Each one is a binding, so it lands in the effect ledger with the
 * line that called it and goes through the authorizer like every other host
 * call — there is no second door.
 *
 * `search` shells out to ripgrep via the npm `ripgrep` library (WASM build,
 * no native binary). `view` and `edit` are plain fs work; `edit` refuses an
 * ambiguous match, which is the whole reason it exists next to `fs.writeFile`.
 */

export interface SearchResult {
  /** Path as ripgrep reported it, relative to the search cwd when it is one. */
  file: string;
  /** Line number (1-indexed). */
  line: number;
  /** Column of the first submatch (1-indexed), when ripgrep reports one. */
  column?: number;
  /** The matched line's full text. */
  text: string;
  /** The matched substring, when ripgrep reports one. */
  match?: string;
}

export interface SearchOptions {
  /** File filter handed to ripgrep, e.g. `"*.ts"`. */
  glob?: string;
  /** Directory to search. Defaults to the host process cwd. */
  cwd?: string;
  /** Stop after this many matches. Default 100. */
  limit?: number;
}

export interface ViewOptions {
  /** First line to read, 1-indexed. Default 1. */
  start?: number;
  /** How many lines to read. Default 50. */
  limit?: number;
}

export async function search(
  pattern: string,
  options: SearchOptions = {},
): Promise<SearchResult[]> {
  const { glob, cwd: workingDir = cwd(), limit = 100 } = options;

  const args = ["--json", "--line-number", "--column", "--no-heading"];
  if (glob !== undefined) args.push("--glob", glob);
  args.push("--", pattern, workingDir);

  const { code, stdout, stderr } = await ripgrep(args, {
    buffer: true,
    // The library preopens `process.cwd()` by default; an explicit cwd needs
    // the matching preopen or the WASM instance cannot see the directory.
    preopens: { "/": "/" },
  });
  if (code === 2)
    throw new Error(`ripgrep error: ${stderr.trim() || "unknown error"}`);

  const results: SearchResult[] = [];
  for (const line of stdout.split("\n")) {
    if (line === "" || results.length >= limit) continue;
    let event: {
      type: string;
      data?: {
        path?: { text?: string };
        line_number?: number;
        lines?: { text?: string };
        submatches?: { match?: { text?: string }; start?: number }[];
      };
    };
    try {
      event = JSON.parse(line) as typeof event;
    } catch {
      continue;
    }
    if (event.type !== "match" || event.data === undefined) continue;
    const data = event.data;
    const file = data.path?.text;
    const line_number = data.line_number;
    if (file === undefined || line_number === undefined) continue;
    const result: SearchResult = {
      file,
      line: line_number,
      text: (data.lines?.text ?? "").trimEnd(),
    };
    const first = data.submatches?.[0];
    if (first?.match?.text !== undefined) {
      result.match = first.match.text;
      if (first.start !== undefined) result.column = first.start + 1;
    }
    results.push(result);
  }
  return results;
}

export async function view(
  path: string,
  options: ViewOptions = {},
  base: string = cwd(),
): Promise<string> {
  const { start = 1, limit = 50 } = options;
  if (start < 1) throw new Error(`start must be >= 1, got ${start}`);

  const content = await readFile(resolve(base, path), "utf-8");
  const lines = content.split("\n");
  if (start > lines.length) return "";

  const end = Math.min(start + limit - 1, lines.length);
  const out: string[] = [];
  for (let i = start; i <= end; i++) out.push(`${i}: ${lines[i - 1]}`);
  return out.join("\n");
}

export async function edit(
  path: string,
  oldText: string,
  newText: string,
  base: string = cwd(),
): Promise<void> {
  const resolved = resolve(base, path);
  const content = await readFile(resolved, "utf-8");

  let count = 0;
  let pos = 0;
  for (;;) {
    const at = content.indexOf(oldText, pos);
    if (at === -1) break;
    count++;
    pos = at + oldText.length;
  }

  const preview =
    oldText.length > 100 ? `${oldText.slice(0, 100)}...` : oldText;
  if (count === 0) throw new Error(`edit: no match found for:\n${preview}`);
  if (count > 1)
    throw new Error(
      `edit: match is not unique, found ${count} occurrences of:\n${preview}`,
    );

  await writeFile(resolved, content.replace(oldText, newText), "utf-8");
}

/** Mounts `search` / `view` / `edit` as realm top-level globals. */
export function mountFileOps(realm: Realm, base?: string): void {
  realm.global(
    "search",
    realm.binding(
      "search",
      (pattern: string, options?: SearchOptions) =>
        search(pattern, {
          ...options,
          ...(base !== undefined && options?.cwd === undefined
            ? { cwd: base }
            : {}),
        }),
      (pattern, options) =>
        `${pattern}${options?.glob !== undefined ? ` glob:${options.glob}` : ""}${options?.cwd !== undefined ? ` in:${options.cwd}` : ""}`,
    ),
  );
  realm.global(
    "view",
    realm.binding(
      "view",
      (path: string, options?: ViewOptions) => view(path, options, base),
      (path, options) =>
        `${path}${options?.start !== undefined ? ` :${options.start}` : ""}${options?.limit !== undefined ? `+${options.limit}` : ""}`,
    ),
  );
  realm.global(
    "edit",
    realm.binding(
      "edit",
      (path: string, oldText: string, newText: string) =>
        edit(path, oldText, newText, base),
      (path) => path,
    ),
  );
}
