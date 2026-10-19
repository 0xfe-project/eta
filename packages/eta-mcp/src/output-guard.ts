// Ported from pi-mcp-adapter/mcp-output-guard.ts (MIT, see ../NOTICE); truncation is local instead of the host's, and only the text path and `_meta` are guarded.
/**
 * Keeps one oversized result from filling the model's context.
 *
 * Text over the limits is saved whole to a file under a directory the caller names; the model gets
 * the head, a notice and the path, and can read the rest when it needs it. Images pass through
 * untouched (they are not text context). The same guard bounds long descriptions.
 */
import type { ContentBlock } from "./types";
import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const DEFAULT_MAX_BYTES = 50 * 1024;
export const DEFAULT_MAX_LINES = 2000;
/** `_meta` and other side data in `details` beyond this is replaced by a note. */
export const DEFAULT_DETAILS_MAX_BYTES = 16 * 1024;

export interface OutputGuardOptions {
  /** Where full outputs are saved. Without it text is still cut, with no path to the rest. */
  dir?: string | undefined;
  maxBytes?: number | undefined;
  maxLines?: number | undefined;
  detailsMaxBytes?: number | undefined;
}

export interface OutputGuardDetails {
  truncated: true;
  originalBytes: number;
  originalLines: number;
  returnedBytes: number;
  returnedLines: number;
  fullOutputPath?: string;
  writeError?: string;
}

export interface GuardedText {
  text: string;
  guard?: OutputGuardDetails;
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function lineCount(text: string): number {
  return text.length === 0 ? 0 : text.split("\n").length;
}

/** The longest head of `text` within both limits, cut at a line boundary when it can be. */
function head(text: string, maxBytes: number, maxLines: number): string {
  const lines = text.split("\n");
  const kept: string[] = [];
  let bytes = 0;
  for (const line of lines.slice(0, Math.max(0, maxLines))) {
    const next = byteLength(line) + (kept.length > 0 ? 1 : 0);
    if (bytes + next > maxBytes) break;
    kept.push(line);
    bytes += next;
  }
  if (kept.length > 0) return kept.join("\n");
  // The first line alone is over the budget: cut it on a character boundary.
  const buffer = Buffer.from(text, "utf8").subarray(0, Math.max(0, maxBytes));
  return buffer.toString("utf8").replace(/�+$/, "");
}

function save(
  dir: string | undefined,
  kind: string,
  text: string,
): { path?: string; error?: string } {
  if (dir === undefined) return { error: "no output directory configured" };
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = join(
      dir,
      `${kind}-${Date.now()}-${randomBytes(4).toString("hex")}.txt`,
    );
    writeFileSync(path, text, { encoding: "utf8", mode: 0o600 });
    return { path };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/** Bounds one text. `kind` names the saved file (`output`, `description`). */
export function guardText(
  text: string,
  kind: string,
  options: OutputGuardOptions = {},
): GuardedText {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
  const originalBytes = byteLength(text);
  const originalLines = lineCount(text);
  if (originalBytes <= maxBytes && originalLines <= maxLines) return { text };

  const { path, error } = save(options.dir, kind, text);
  const notice = (shownLines: number): string => {
    const base = `[MCP ${kind} truncated: original ${originalLines} lines / ${originalBytes} bytes, showing ${shownLines} lines.`;
    return path === undefined
      ? `${base} The full ${kind} could not be saved: ${error ?? "unknown error"}]`
      : `${base} Full ${kind} saved to: ${path} (read it with offset/limit or grep).]`;
  };
  // The notice counts against the budget, so the result as a whole stays within the limits.
  const reserved = byteLength(notice(maxLines)) + 2;
  const preview = head(
    text,
    Math.max(0, maxBytes - reserved),
    Math.max(0, maxLines - 3),
  );
  const returned = `${preview}\n\n${notice(lineCount(preview))}`;
  return {
    text: returned,
    guard: {
      truncated: true,
      originalBytes,
      originalLines,
      returnedBytes: byteLength(returned),
      returnedLines: lineCount(returned),
      ...(path === undefined ? {} : { fullOutputPath: path }),
      ...(error === undefined ? {} : { writeError: error }),
    },
  };
}

/** Bounds the text blocks of a result together; image blocks are kept as they are. */
export function guardContent(
  content: ContentBlock[],
  options: OutputGuardOptions = {},
  affixes: { prefix?: string; suffix?: string } = {},
): { content: ContentBlock[]; guard?: OutputGuardDetails } {
  const images = content.filter((block) => block.type === "image");
  const text = content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
  const composed = `${affixes.prefix ?? ""}${text}${affixes.suffix ?? ""}`;
  const guarded = guardText(composed, "output", options);
  const blocks: ContentBlock[] = [
    { type: "text", text: guarded.text },
    ...images,
  ];
  return guarded.guard === undefined
    ? { content: blocks }
    : { content: blocks, guard: guarded.guard };
}

/**
 * Side data (`_meta`) that rides in `details`: kept as is when small, else replaced by a note that
 * says how big it was, so a chatty server cannot bloat the session.
 */
export function boundDetails(
  value: unknown,
  maxBytes = DEFAULT_DETAILS_MAX_BYTES,
): unknown {
  let serialized: string;
  try {
    serialized = JSON.stringify(value) ?? "";
  } catch {
    return { omitted: true };
  }
  const bytes = byteLength(serialized);
  return bytes <= maxBytes ? value : { omitted: true, bytes };
}
