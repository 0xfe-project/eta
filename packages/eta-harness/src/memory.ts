/**
 * Memory battery (C5): a small untrusted NOTES file per project, read at session start and
 * refreshed when the file changes. There is deliberately no home-level file: a note is a
 * decision about *this* project, and a global note file quietly becomes a pile of last
 * session's assumptions that every new folder inherits and nobody can turn off.
 *
 * Three fixed sections so the extraction call and humans can both write it. The FS is
 * injected so tests and the GUI sandbox can supply their own.
 *
 * Ids are `<file label>#<number>`, and the number is the one written in the
 * file. Two files merging into one block is the normal case, so an id that was
 * only a position in the merged list would point at a different note every time
 * a file appeared, disappeared, or moved — and a removal would then quietly
 * delete the wrong line. A label derived from the path keeps an id meaning the
 * row it was read from, and lets `applyExtraction` tell "remove this" from
 * "remove something in the other file", which it ignores rather than guessing.
 */

import type { ExecutionEnv } from "@eta/execution";
import {
  MEMORY_EXTRACT_PROMPT,
  MEMORY_EXTRACT_SYSTEM_PROMPT,
} from "./prompts/memory";

/**
 * The little filesystem this module needs. Narrow on purpose: memory is about
 * four operations, and a test (or a GUI's sandbox) can supply them without a real
 * environment. `envMemoryFs` adapts an `ExecutionEnv` when there is one.
 */
export interface MemoryFs {
  readFile: (path: string) => Promise<string | undefined>;
  /** undefined when the path doesn't exist. */
  mtime: (path: string) => Promise<number | undefined>;
  writeFile: (path: string, content: string) => Promise<void>;
  listFileNames: (dir: string) => Promise<string[]>;
}

export const MEMORY_SECTIONS = ["decision", "preference", "lesson"] as const;
export type MemorySection = (typeof MEMORY_SECTIONS)[number];

/** One MEMORY.md plus the label its entries carry. */
export interface MemoryFile {
  path: string;
  label: string;
}

export interface MemoryEntry {
  /** `<label>#<num>` — what the model sees and what a removal names. */
  id: string;
  /** The number stored between brackets; stable inside one file. */
  num: number;
  file: string;
  section: MemorySection;
  text: string;
}

export const MEMORY_FILE = "MEMORY.md";
export const MEMORY_CAP = 20_000;
const HEADER = "# eta memory (untrusted)";

/** Path hash without a crypto import: the harness stays runtime-agnostic here. */
function shortHash(value: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0").slice(0, 4);
}

/**
 * Short, path-derived label. `eta-agent~9f3c` for a project file; `user` is kept for a file
 * that sits at `~/.eta` — which is what a session opened in $HOME now is, not a global tier.
 * The directory owning `.eta/MEMORY.md` names it; the hash keeps two same-named directories apart.
 */
export function memoryFileLabel(path: string, home: string): string {
  if (path === `${home}/.eta/${MEMORY_FILE}`) return "user";
  const owner = path.replace(new RegExp(`/.eta/${MEMORY_FILE}$`), "");
  const name =
    (owner.split("/").pop() ?? "").replace(/[^\w.-]/g, "_") || "root";
  return `${name}~${shortHash(owner)}`;
}

export function parseMemory(text: string, target: MemoryFile): MemoryEntry[] {
  const entries: MemoryEntry[] = [];
  let section: MemorySection | undefined;
  let nextNum = 0;
  for (const line of text.split("\n")) {
    const heading = /^##\s+(\w+)/.exec(line);
    if (heading !== null) {
      section = (MEMORY_SECTIONS as readonly string[]).includes(heading[1])
        ? (heading[1] as MemorySection)
        : undefined;
      continue;
    }
    if (section === undefined) continue;
    const item = /^-\s+(?:\[(\d+)\]\s+)?(.*)$/.exec(line.trim());
    if (item === null || item[2].length === 0) continue;
    // A hand-written note carries no number: take the next free one and keep it.
    const num = item[1] === undefined ? nextNum : Number(item[1]);
    nextNum = Math.max(nextNum, num) + 1;
    entries.push({
      id: `${target.label}#${num}`,
      num,
      file: target.path,
      section,
      text: item[2],
    });
  }
  return entries;
}

export function renderMemory(entries: readonly MemoryEntry[]): string {
  const lines = [HEADER];
  for (const section of MEMORY_SECTIONS) {
    lines.push(`## ${section}`);
    for (const e of entries)
      if (e.section === section) lines.push(`- [${e.num}] ${e.text}`);
  }
  return `${lines.join("\n")}\n`;
}

export function renderMemoryBlock(entries: readonly MemoryEntry[]): string {
  const body = MEMORY_SECTIONS.map((section) => {
    const items = entries
      .filter((e) => e.section === section)
      .map((e) => `- [${e.id}] ${e.text}`);
    return items.length === 0
      ? undefined
      : `## ${section}\n${items.join("\n")}`;
  })
    .filter((s) => s !== undefined)
    .join("\n");
  return `<memory>\n[untrusted notes collected earlier]\n${body}\n</memory>`;
}

/** Git-aware upward walk from cwd; outermost project first. There is no home-level note. */
export interface MemoryScan {
  /** Note files this session reads, outermost first; empty until the project keeps one. */
  files: MemoryFile[];
  /** Where a new note goes: the nearest file that exists, else the project's own. */
  target: MemoryFile;
  /** The directory that owns the session's notes — the git root, or cwd outside a checkout. */
  projectRoot: string;
}

export async function scanMemory(
  fs: MemoryFs,
  cwd: string,
  home: string,
): Promise<MemoryScan> {
  const paths: string[] = [];
  let dir = cwd;
  let projectRoot: string | undefined;
  for (;;) {
    const candidate = `${dir}/.eta/${MEMORY_FILE}`;
    if ((await fs.mtime(candidate)) !== undefined) paths.unshift(candidate);
    if ((await fs.mtime(`${dir}/.git`)) !== undefined) {
      projectRoot = dir;
      break;
    }
    if (dir === "/") break;
    const parent = dir.replace(/\/[^/]*$/, "") || "/";
    if (parent === dir) break;
    dir = parent;
  }
  // Outside any checkout the folder you opened *is* the project: notes stay with the work
  // rather than leaking to the filesystem root, which is not writable by a person anyway.
  projectRoot ??= cwd;
  // Scan order is outermost first, so the last project entry is the nearest one.
  const targetPath = paths.at(-1) ?? `${projectRoot}/.eta/${MEMORY_FILE}`;
  return {
    files: paths.map((path) => ({ path, label: memoryFileLabel(path, home) })),
    target: { path: targetPath, label: memoryFileLabel(targetPath, home) },
    projectRoot,
  };
}

/** Just the files a session reads — the question asked most often about a scan. */
export async function scanMemoryPaths(
  fs: MemoryFs,
  cwd: string,
  home: string,
): Promise<MemoryFile[]> {
  return (await scanMemory(fs, cwd, home)).files;
}

/** What one session's memory resolves to: the block, the files behind it, and where notes go. */
export interface MemoryLoaded {
  text: string;
  files: string[];
  target: MemoryFile;
  projectRoot: string;
}

/** Reads + renders memory, re-reading only when a file's mtime changed. */
export class MemoryCache {
  private signature = "";
  private cached: MemoryLoaded = {
    text: "",
    files: [],
    target: { path: "", label: "" },
    projectRoot: "",
  };

  private readonly fs: MemoryFs;
  private readonly home: string;

  constructor(fs: MemoryFs, home: string) {
    this.fs = fs;
    this.home = home;
  }

  async load(cwd: string): Promise<MemoryLoaded> {
    const scan = await scanMemory(this.fs, cwd, this.home);
    const targets = scan.files;
    const stamps = await Promise.all(
      targets.map(
        async (t) => `${t.path}:${(await this.fs.mtime(t.path)) ?? 0}`,
      ),
    );
    const signature = `${scan.target.path}|${stamps.join("|")}`;
    if (signature === this.signature) return this.cached;
    let entries: MemoryEntry[] = [];
    for (const target of targets) {
      const text = await this.fs.readFile(target.path);
      if (text === undefined) continue;
      entries = entries.concat(parseMemory(text, target));
    }
    let block = renderMemoryBlock(entries);
    if (block.length > MEMORY_CAP) {
      // Cut at a line boundary: a half-line reads like the file is corrupt.
      block = `${block.slice(0, MEMORY_CAP).replace(/\n[^\n]*$/, "")}\n[memory truncated at cap]`;
    }
    this.signature = signature;
    this.cached = {
      text: block,
      files: targets.map((t) => t.path),
      target: scan.target,
      projectRoot: scan.projectRoot,
    };
    return this.cached;
  }
}

export interface MemoryExtraction {
  add_new_decision: string[];
  add_new_preference: string[];
  learn_new_lesson: string[];
  remove_memory_ids: string[];
}

/** Idempotent append/remove on one memory file; existing texts are never duplicated. */
export async function applyExtraction(
  fs: MemoryFs,
  target: MemoryFile,
  extraction: Partial<MemoryExtraction>,
): Promise<{ added: number; removed: number; foreign: number }> {
  const existingTexts = parseMemory(
    (await fs.readFile(target.path)) ?? "",
    target,
  );
  const known = new Set(existingTexts.map((e) => e.text.trim()));
  const removeIds = new Set(extraction.remove_memory_ids ?? []);
  const foreign = [...removeIds].filter(
    (id) => !id.startsWith(`${target.label}#`),
  ).length;
  let nextNum = existingTexts.reduce((m, e) => Math.max(m, e.num + 1), 0);
  const entries = existingTexts.filter((e) => !removeIds.has(e.id));
  const removed = existingTexts.length - entries.length;
  let added = 0;
  const adds: [MemorySection, string[]][] = [
    ["decision", extraction.add_new_decision ?? []],
    ["preference", extraction.add_new_preference ?? []],
    ["lesson", extraction.learn_new_lesson ?? []],
  ];
  for (const [section, texts] of adds) {
    for (const text of texts) {
      if (known.has(text.trim())) continue;
      known.add(text.trim());
      entries.push({
        id: `${target.label}#${nextNum}`,
        num: nextNum,
        file: target.path,
        section,
        text,
      });
      nextNum += 1;
      added += 1;
    }
  }
  await fs.writeFile(target.path, renderMemory(entries));
  return { added, removed, foreign };
}

/** Out-of-band extraction call: the agent never sees this conversation fork. */
export async function extractMemory(
  fs: MemoryFs,
  target: MemoryFile,
  transcriptText: string,
  call: (systemPrompt: string, prompt: string) => Promise<string>,
): Promise<{ added: number; removed: number; foreign: number } | undefined> {
  // The notes go along too: shown nothing to mark obsolete, the model could only
  // guess at remove_memory_ids.
  const current = parseMemory((await fs.readFile(target.path)) ?? "", target);
  const raw = await call(
    MEMORY_EXTRACT_SYSTEM_PROMPT,
    `${MEMORY_EXTRACT_PROMPT}\n\nCurrent notes:\n${renderMemoryBlock(current)}\n\nConversation:\n${transcriptText}`,
  );
  const jsonMatch = /\{[\s\S]*\}/.exec(raw);
  if (jsonMatch === null) return undefined;
  try {
    return await applyExtraction(
      fs,
      target,
      JSON.parse(jsonMatch[0]) as Partial<MemoryExtraction>,
    );
  } catch {
    return undefined;
  }
}

/** Structural on purpose: this file stays free of provider message types. */
export interface TranscriptLike {
  role?: string;
  content?: unknown;
}

export const MEMORY_TRANSCRIPT_CAP = 24_000;

/** What was said, one line per turn. Tool results stay out — notes are about the person, not the ls output. */
export function extractionTranscript(
  messages: readonly TranscriptLike[],
  cap = MEMORY_TRANSCRIPT_CAP,
): string {
  const lines: string[] = [];
  for (const message of messages) {
    if (message.role !== "user" && message.role !== "assistant") continue;
    if (typeof message.content === "string") {
      if (message.content.trim().length > 0)
        lines.push(`${message.role}: ${message.content.trim()}`);
      continue;
    }
    if (!Array.isArray(message.content)) continue;
    const blocks = message.content as {
      type?: string;
      text?: string;
      name?: string;
    }[];
    const said = blocks
      .filter(
        (block) =>
          block.type === "text" && (block.text ?? "").trim().length > 0,
      )
      .map((block) => block.text!.trim())
      .join(" ");
    const ran = blocks
      .filter((block) => block.type === "toolCall")
      .map((block) => block.name ?? "?");
    const line = [
      said.length > 0 ? `${message.role}: ${said}` : "",
      ran.length > 0 ? `[ran ${ran.join(", ")}]` : "",
    ]
      .filter((part) => part.length > 0)
      .join(" ");
    if (line.length > 0) lines.push(line);
  }
  const joined = lines.join("\n");
  // Over the cap keep the end: this is a compaction, and a summary already covers the older half.
  return joined.length <= cap ? joined : joined.slice(joined.length - cap);
}

export interface MemoryExtractionSource {
  fs: MemoryFs;
  target: MemoryFile;
  /** One-shot provider call; auth and model choice stay with the composition root. */
  call: (systemPrompt: string, prompt: string) => Promise<string>;
  /** Under this many characters of conversation the call is not worth making. */
  minTranscriptChars?: number;
}

/** A type alias, not an interface: this goes out as event data and needs an index signature. */
export interface MemoryExtractionOutcome {
  added: number;
  removed: number;
  /** Ids the model wanted gone that live in another file — reported, not guessed at. */
  foreign: number;
  skipped?: "thin" | "provider";
  reason?: string;
}

/**
 * What is worth keeping, asked at the end of a run.
 *
 * eta-agent asked this from a `before_compaction` hook; hooks are gone, and the
 * moment that matters is the same one either way — the end of a stretch of work,
 * when the conversation is about to stop being read. So this is a plain function
 * over a transcript, and whoever assembles a session calls it from the run-end
 * signal.
 *
 * It never fails a run: a provider that is down, a read-only directory, a reply
 * with no JSON in it — each becomes an outcome the host can log rather than a
 * reason the turn is considered failed.
 */
export async function extractMemoryAtRunEnd(
  source: MemoryExtractionSource,
  messages: readonly TranscriptLike[],
  onOutcome?: (outcome: MemoryExtractionOutcome) => void,
): Promise<MemoryExtractionOutcome> {
  const transcript = extractionTranscript(messages);
  const minChars = source.minTranscriptChars ?? 200;
  if (transcript.length < minChars) {
    const outcome: MemoryExtractionOutcome = {
      added: 0,
      removed: 0,
      foreign: 0,
      skipped: "thin",
    };
    onOutcome?.(outcome);
    return outcome;
  }
  try {
    const result = await extractMemory(
      source.fs,
      source.target,
      transcript,
      source.call,
    );
    const outcome: MemoryExtractionOutcome = {
      ...(result ?? { added: 0, removed: 0, foreign: 0 }),
      ...(result === undefined ? { skipped: "provider" as const } : {}),
    };
    onOutcome?.(outcome);
    return outcome;
  } catch (error) {
    const outcome: MemoryExtractionOutcome = {
      added: 0,
      removed: 0,
      foreign: 0,
      skipped: "provider",
      reason: error instanceof Error ? error.message : String(error),
    };
    onOutcome?.(outcome);
    return outcome;
  }
}

/** The memory filesystem as an execution environment sees it. */
export function envMemoryFs(env: ExecutionEnv): MemoryFs {
  return {
    async readFile(path: string): Promise<string | undefined> {
      const result = await env.readTextFile(path);
      return result.ok ? result.value : undefined;
    },
    async mtime(path: string): Promise<number | undefined> {
      const result = await env.fileInfo(path);
      return result.ok ? result.value.mtimeMs : undefined;
    },
    async writeFile(path: string, content: string): Promise<void> {
      const result = await env.writeFile(path, content);
      if (!result.ok) throw result.error;
    },
    async listFileNames(dir: string): Promise<string[]> {
      const result = await env.listDir(dir);
      return result.ok ? result.value.map((entry) => entry.name) : [];
    },
  };
}
