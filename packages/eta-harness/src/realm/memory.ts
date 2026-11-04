/**
 * `eta:{layer}:memory`: structured access to one layer's MEMORY.md.
 *
 * The file is the storage and a human may edit it at any time, so nothing is
 * cached: every read reads it, and every write re-reads it first, so a hand
 * edit is neither missed nor overwritten.
 *
 * Format (shared with eta-harness/src/memory.ts, minus the LLM extraction):
 *
 * ```markdown
 * # eta memory (untrusted)
 * ## decision
 * - [eta~dcdc#0] text
 * ## preference
 * ## lesson
 * ```
 *
 * Parsing also accepts the harness's `- [0] text` and bare `- text` (a hand
 * written note gets the next free number, which is then written back).
 */

import { readFileSync } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import process from "node:process";

export const MEMORY_SECTIONS = ["decision", "preference", "lesson"] as const;
export type MemorySection = (typeof MEMORY_SECTIONS)[number];

export interface MemoryEntry {
  /** `<label>#<num>`, e.g. "eta~dcdc#42". */
  id: string;
  /** The number written in the file; stable inside one file. */
  num: number;
  /** The MEMORY.md this entry was read from. */
  file: string;
  section: MemorySection;
  text: string;
}

export interface MemoryApi {
  list: (section?: MemorySection) => MemoryEntry[];
  get: (id: string) => MemoryEntry | undefined;
  add: (section: MemorySection, text: string) => Promise<string>;
  remove: (id: string) => Promise<boolean>;
}

export const MEMORY_FILE = "MEMORY.md";
const HEADER = "# eta memory (untrusted)";

/** FNV-1a, 4 hex chars: same as the harness so ids agree across both. */
function shortHash(value: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0").slice(0, 4);
}

/**
 * Path-derived label. `{project}/.eta/MEMORY.md` is named after `{project}`
 * (matching the harness, e.g. `eta~dcdc`); any other file after its directory
 * (`~/.eta/sessions/{id}` → `{id}~…`, `~/.eta/global` → `global~…`).
 */
export function memoryFileLabel(path: string): string {
  const dir = dirname(path);
  const owner = basename(dir) === ".eta" ? dirname(dir) : dir;
  const name = basename(owner).replace(/[^\w.-]/g, "_") || "root";
  return `${name}~${shortHash(owner)}`;
}

function isSection(value: string): value is MemorySection {
  return (MEMORY_SECTIONS as readonly string[]).includes(value);
}

/** One `- …` line → number (if written) and text. No regex over free text. */
function parseItem(line: string): { num?: number; text: string } | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith("- ")) return undefined;
  const rest = trimmed.slice(2).trimStart();
  if (rest.startsWith("[")) {
    const close = rest.indexOf("]");
    const tag = /^(?:[^\]#]*#)?(\d+)$/.exec(rest.slice(1, close));
    if (close > 0 && tag !== null) {
      const text = rest.slice(close + 1).trim();
      return text.length === 0 ? undefined : { num: Number(tag[1]), text };
    }
  }
  return rest.length === 0 ? undefined : { text: rest };
}

export function parseMemoryFile(
  text: string,
  filePath: string,
  label: string,
): MemoryEntry[] {
  const items: { section: MemorySection; num?: number; text: string }[] = [];
  const used = new Set<number>();
  let section: MemorySection | undefined;

  for (const line of text.split("\n")) {
    const heading = /^##\s+(\w+)/.exec(line);
    if (heading !== null) {
      section = isSection(heading[1]) ? heading[1] : undefined;
      continue;
    }
    if (section === undefined) continue;
    const item = parseItem(line);
    if (item === undefined) continue;
    // A duplicated number (a copy-pasted line) is renumbered, so ids stay unique.
    if (item.num !== undefined && used.has(item.num)) item.num = undefined;
    if (item.num !== undefined) used.add(item.num);
    items.push({ section, ...item });
  }

  // Unnumbered lines take numbers after every written one, so a hand edit
  // never steals the number of a line further down.
  let next = used.size === 0 ? 0 : Math.max(...used) + 1;
  return items.map(({ section, num, text }) => {
    const n = num ?? next++;
    return { id: `${label}#${n}`, num: n, file: filePath, section, text };
  });
}

export function serializeMemoryFile(
  entries: readonly MemoryEntry[],
  label: string,
): string {
  const lines = [HEADER];
  for (const section of MEMORY_SECTIONS) {
    lines.push(`## ${section}`);
    for (const e of entries)
      if (e.section === section) lines.push(`- [${label}#${e.num}] ${e.text}`);
  }
  return `${lines.join("\n")}\n`;
}

/** A section name from realm code is untrusted input. */
function checkSection(section: unknown): MemorySection {
  if (typeof section !== "string" || !isSection(section))
    throw new TypeError(
      `memory section must be one of ${MEMORY_SECTIONS.join(" / ")}, got ${String(section)}`,
    );
  return section;
}

/** One line per entry: newlines would split it into lines the parser reads differently. */
function checkText(text: unknown): string {
  if (typeof text !== "string")
    throw new TypeError("memory text must be a string");
  const flat = text.replace(/\s*\n\s*/g, " ").trim();
  if (flat.length === 0) throw new TypeError("memory text must not be empty");
  return flat;
}

/**
 * The API over one MEMORY.md. A missing file reads as `[]`.
 *
 * `list`/`get` are synchronous (that is the module's API), so they read with
 * `readFileSync`. Writes go through `fs/promises`, one at a time, each
 * re-reading the file first and replacing it by temp file + rename.
 */
export function createMemoryModule(path: string): MemoryApi {
  const label = memoryFileLabel(path);
  let queue: Promise<unknown> = Promise.resolve();
  let tmpSeq = 0;

  const parse = (text: string): MemoryEntry[] =>
    parseMemoryFile(text, path, label);

  /** Synchronous because `list`/`get` are; a missing file is just empty. */
  function readNow(): MemoryEntry[] {
    try {
      return parse(readFileSync(path, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async function readFresh(): Promise<MemoryEntry[]> {
    try {
      await stat(path);
    } catch {
      return [];
    }
    return parse(await readFile(path, "utf8"));
  }

  async function save(entries: MemoryEntry[]): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.${tmpSeq++}.tmp`;
    try {
      await writeFile(tmp, serializeMemoryFile(entries, label), "utf8");
      await rename(tmp, path);
    } catch (error) {
      await rm(tmp, { force: true });
      throw error;
    }
  }

  /** Serialize read-modify-write cycles inside this process. */
  function exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = queue.then(fn, fn);
    queue = run.catch(() => undefined);
    return run;
  }

  const copy = (e: MemoryEntry): MemoryEntry => ({ ...e });

  return {
    list(section) {
      const wanted = section === undefined ? undefined : checkSection(section);
      return readNow()
        .filter((e) => wanted === undefined || e.section === wanted)
        .map(copy);
    },
    get(id) {
      const found = readNow().find((e) => e.id === id);
      return found === undefined ? undefined : copy(found);
    },
    async add(section, text) {
      const s = checkSection(section);
      const t = checkText(text);
      return exclusive(async () => {
        const entries = await readFresh();
        const num = entries.reduce((max, e) => Math.max(max, e.num + 1), 0);
        const id = `${label}#${num}`;
        entries.push({ id, num, file: path, section: s, text: t });
        await save(entries);
        return id;
      });
    },
    async remove(id) {
      return exclusive(async () => {
        const entries = await readFresh();
        const kept = entries.filter((e) => e.id !== id);
        if (kept.length === entries.length) return false;
        await save(kept);
        return true;
      });
    },
  };
}
