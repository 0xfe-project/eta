/**
 * Finding and reading published artifacts from a session: what `search_artifacts` and
 * `read_artifact` do (`tools.ts`).
 *
 * What a session may see is decided here, from who the session is, never from what the model
 * asks for (`scopeOf`):
 *
 * - Captain, in any session including the routines it runs: every artifact.
 * - An agent in a conversation (a group, or Captain's own): that conversation's artifacts, which
 *   are the ones published there and the ones of the tasks that are in it now.
 * - A task's session: the conversation the task is in, the same as an agent there. A task in no
 *   conversation: its own artifacts only.
 * - Anything else (a routine that is not Captain's): nothing.
 *
 * An artifact of a task goes where the task goes: it is counted in the conversation the task is
 * in now, not the one it was published from. An artifact outside the scope is answered as one that
 * does not exist.
 *
 * Nothing is indexed: a search reads the newest version's text files from disk each time.
 */
import type { ArtifactView } from "@eta/client-contracts";
import type { ImageContent, TextContent } from "@eta/core";
import type { TaskRecord } from "../tasks/store";
import type { ArtifactService } from "./service";
import type { VersionRecord } from "./store";
import { readFile, stat } from "node:fs/promises";
import { extname } from "node:path";
import { heldIn, taskOf } from "../session-owner";
import { ArtifactError } from "./files";

export type ArtifactScope =
  | { kind: "all" }
  | { kind: "conversation"; conversationId: string }
  | { kind: "task"; taskId: string }
  | { kind: "none" };

/**
 * The conversation a task is in now: the one it is linked to. Not the one it was proposed in: a
 * task unlinked from its group (`board.link(id, null)`) is in no conversation, and sees and is
 * seen as one.
 */
export const conversationOfTask = (task: {
  conversationId: string | null;
}): string | undefined => task.conversationId ?? undefined;

/** What the session held in `key`, run by `agentId`, may find and read. Read at each call. */
export function scopeOf(
  key: string,
  agentId: string,
  deps: {
    isCaptain: (agentId: string) => boolean;
    findTask: (id: string) => TaskRecord | undefined;
    taskOfRun: (runId: string) => string | undefined;
  },
): ArtifactScope {
  if (deps.isCaptain(agentId)) return { kind: "all" };
  const held = heldIn(key);
  if (held === "routine") return { kind: "none" };
  if (held === "conversation")
    return { kind: "conversation", conversationId: key };
  const taskId = taskOf(key, deps.taskOfRun);
  const task = taskId === undefined ? undefined : deps.findTask(taskId);
  if (task === undefined) return { kind: "none" };
  const where = conversationOfTask(task);
  return where === undefined
    ? { kind: "task", taskId: task.id }
    : { kind: "conversation", conversationId: where };
}

/** Whether an artifact is in a scope. A task's artifact is where its task is now. */
function inScope(
  artifact: { taskId: string | null; conversationId: string | null },
  scope: ArtifactScope,
  findTask: (id: string) => TaskRecord | undefined,
): boolean {
  switch (scope.kind) {
    case "all":
      return true;
    case "none":
      return false;
    case "task":
      return artifact.taskId === scope.taskId;
    case "conversation": {
      const task =
        artifact.taskId === null ? undefined : findTask(artifact.taskId);
      if (task !== undefined)
        return conversationOfTask(task) === scope.conversationId;
      return artifact.conversationId === scope.conversationId;
    }
  }
}

/** Whether a task is one a scope can see: a task out of scope is answered as one that is not there. */
export function taskInScope(task: TaskRecord, scope: ArtifactScope): boolean {
  switch (scope.kind) {
    case "all":
      return true;
    case "none":
      return false;
    case "task":
      return task.id === scope.taskId;
    case "conversation":
      return conversationOfTask(task) === scope.conversationId;
  }
}

export interface ReadingDeps {
  artifacts: ArtifactService;
  findTask: (id: string) => TaskRecord | undefined;
  agentName: (agentId: string) => string | undefined;
}

/* ------------------------------------------------------------------ search */

/** What a search reads as text. */
const SEARCHED = new Set([
  ".html",
  ".htm",
  ".md",
  ".txt",
  ".css",
  ".js",
  ".mjs",
  ".json",
  ".svg",
]);
/** A file larger than this is not searched. */
const SEARCH_FILE_BYTES = 1024 * 1024;
export const SEARCH_LIMIT = 20;
export const SEARCH_LIMIT_MAX = 50;
/** Characters of context either side of a match. */
const AROUND = 60;

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/** The words of an HTML page: no tags, no comments, no style or script, entities decoded. */
export function htmlText(html: string): string {
  return html
    .replaceAll(/<!--[\s\S]*?-->/g, " ")
    .replaceAll(/<(style|script)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
    .replaceAll(/<[^>]*>/g, " ")
    .replaceAll(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
      if (name.startsWith("#")) {
        const code =
          name[1] === "x" || name[1] === "X"
            ? Number.parseInt(name.slice(2), 16)
            : Number.parseInt(name.slice(1), 10);
        return Number.isFinite(code) && code <= 0x10ffff
          ? String.fromCodePoint(code)
          : whole;
      }
      return ENTITIES[name.toLowerCase()] ?? whole;
    });
}

const squash = (text: string): string => text.replaceAll(/\s+/g, " ").trim();

/** The text around the first match of `needle` (lower case) in `text`, or nothing. */
function snippet(text: string, needle: string): string | undefined {
  const lower = text.toLowerCase();
  const at = lower.indexOf(needle);
  if (at < 0) return undefined;
  // Lower case can change a string's length; then the lower-case text is what is quoted.
  const source = lower.length === text.length ? text : lower;
  const start = Math.max(0, at - AROUND);
  const end = Math.min(source.length, at + needle.length + AROUND);
  return `${start > 0 ? "…" : ""}${source.slice(start, end)}${end < source.length ? "…" : ""}`;
}

/** The first match in a version's searched files, as a file name and the text around it. */
async function bodyMatch(
  artifacts: ArtifactService,
  version: VersionRecord,
  needle: string,
): Promise<{ file: string; text: string } | undefined> {
  const files = await artifacts.filesOf(version);
  const entry = artifacts.entryOf(version);
  // The entry page first: it is what the artifact is.
  files.sort((a, b) => Number(b.name === entry) - Number(a.name === entry));
  for (const file of files) {
    const ext = extname(file.name).toLowerCase();
    if (!SEARCHED.has(ext) || file.size > SEARCH_FILE_BYTES) continue;
    const path = artifacts.fileOf(version, file.name);
    if (path === undefined) continue;
    const raw = await readFile(path, "utf8").catch(() => undefined);
    if (raw === undefined) continue;
    const words = squash(
      ext === ".html" || ext === ".htm" || ext === ".svg" ? htmlText(raw) : raw,
    );
    const text = snippet(words, needle);
    if (text !== undefined) return { file: file.name, text };
  }
  return undefined;
}

const when = (ms: number): string =>
  `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;

const taskLabel = (task: TaskRecord | undefined): string | undefined =>
  task === undefined ? undefined : `#${task.number} ${task.title}`;

const publisherOf = (deps: ReadingDeps, artifact: ArtifactView): string =>
  artifact.publisherAgentId === null
    ? "unknown"
    : (deps.agentName(artifact.publisherAgentId) ?? artifact.publisherAgentId);

export interface SearchHit {
  id: string;
  title: string;
  version: number;
  updatedAt: number;
  publisher: string;
  task: string | undefined;
  match: "title" | "body" | undefined;
  snippet: string | undefined;
}

/** Artifacts in scope, newest first, title matches before body matches. */
export async function searchArtifacts(
  deps: ReadingDeps,
  scope: ArtifactScope,
  input: {
    query?: string | undefined;
    taskId?: string | undefined;
    limit: number;
  },
): Promise<SearchHit[]> {
  const needle = squash(input.query ?? "").toLowerCase();
  const candidates = deps.artifacts
    .list()
    .filter(
      (artifact) =>
        inScope(artifact, scope, deps.findTask) &&
        (input.taskId === undefined || artifact.taskId === input.taskId) &&
        artifact.versions.length > 0,
    )
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const hits: SearchHit[] = [];
  for (const artifact of candidates) {
    const latest = artifact.versions[0]!.number;
    const hit = (
      match: SearchHit["match"],
      text: string | undefined,
    ): SearchHit => ({
      id: artifact.id,
      title: artifact.title,
      version: latest,
      updatedAt: artifact.updatedAt,
      publisher: publisherOf(deps, artifact),
      task: taskLabel(
        artifact.taskId === null ? undefined : deps.findTask(artifact.taskId),
      ),
      match,
      snippet: text,
    });
    if (needle === "") {
      hits.push(hit(undefined, undefined));
      if (hits.length >= input.limit) break;
      continue;
    }
    if (artifact.title.toLowerCase().includes(needle)) {
      hits.push(hit("title", undefined));
      continue;
    }
    const version = deps.artifacts.versionOf(artifact.id, latest)?.version;
    if (version === undefined) continue;
    const found = await bodyMatch(deps.artifacts, version, needle);
    if (found !== undefined)
      hits.push(hit("body", `${found.file}: ${found.text}`));
  }
  const ranked = [
    ...hits.filter((h) => h.match !== "body"),
    ...hits.filter((h) => h.match === "body"),
  ];
  return ranked.slice(0, input.limit);
}

export function searchLine(hit: SearchHit): string {
  return [
    `${hit.id} "${hit.title}" v${hit.version}`,
    `updated ${when(hit.updatedAt)}`,
    `by ${hit.publisher}`,
    ...(hit.task === undefined ? [] : [`task ${hit.task}`]),
    ...(hit.match === "title" ? ["title matches"] : []),
    ...(hit.snippet === undefined ? [] : [`matched ${hit.snippet}`]),
  ].join(" · ");
}

/* ------------------------------------------------------------------ read */

const IMAGES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};
/** An image larger than this is only described. */
const IMAGE_BYTES = 5 * 1024 * 1024;
const READ_LINES = 400;
/** A line longer than this is cut. */
const LINE_CHARS = 2000;
/** A page of text stops here even before `limit` lines. */
const PAGE_CHARS = 100_000;

const size = (bytes: number): string =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${Math.round((bytes / 1024) * 10) / 10} KB`
      : `${Math.round((bytes / 1024 / 1024) * 10) / 10} MB`;

/**
 * The artifact `ref` names, among those in scope: an id, or else an exact title. Anything outside
 * the scope is not found, the same as an artifact that does not exist.
 */
function resolveVisible(
  deps: ReadingDeps,
  scope: ArtifactScope,
  ref: string,
): ArtifactView {
  const visible = (artifact: ArtifactView | undefined) =>
    artifact !== undefined && inScope(artifact, scope, deps.findTask);
  const byId = deps.artifacts.view(ref);
  if (visible(byId)) return byId!;
  const title = ref.trim();
  const named = deps.artifacts
    .list()
    .filter((artifact) => artifact.title === title && visible(artifact));
  if (named.length === 1) return named[0]!;
  if (named.length > 1)
    throw new ArtifactError(
      `several artifacts are titled "${title}"; name one by id: ${named
        .map((artifact) => artifact.id)
        .join(", ")}`,
    );
  throw new ArtifactError(`no such artifact: ${ref}`);
}

/** Text, as UTF-8 that decodes cleanly and has no NUL; anything else is binary. */
function asText(bytes: Uint8Array): string | undefined {
  if (bytes.includes(0)) return undefined;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

/** Lines `offset`..`offset + limit - 1` with their numbers, and what is left after them. */
export function page(
  text: string,
  offset: number,
  limit: number,
): { text: string; shown: number; total: number; left: number } {
  const lines = text.split(/\r?\n/);
  if (lines.length > 1 && lines.at(-1) === "") lines.pop();
  const total = lines.length;
  const start = Math.max(1, offset);
  const out: string[] = [];
  let chars = 0;
  let line = start;
  for (; line < start + limit && line <= total; line++) {
    let body = lines[line - 1]!;
    if (body.length > LINE_CHARS)
      body = `${body.slice(0, LINE_CHARS)}… (${body.length - LINE_CHARS} more characters on this line)`;
    if (out.length > 0 && chars + body.length > PAGE_CHARS) break;
    out.push(`${String(line).padStart(6)}\t${body}`);
    chars += body.length + 8;
  }
  return {
    text: out.join("\n"),
    shown: out.length,
    total,
    left: Math.max(0, total - (line - 1)),
  };
}

export interface ReadInput {
  artifactId: string;
  version?: number | undefined;
  path?: string | undefined;
  offset?: number | undefined;
  limit?: number | undefined;
}

/** One file of a version of an artifact in scope, with a header that says what the artifact is. */
export async function readArtifact(
  deps: ReadingDeps,
  scope: ArtifactScope,
  input: ReadInput,
): Promise<{
  content: (TextContent | ImageContent)[];
  details: { artifactId: string; version: number; path: string };
}> {
  const artifact = resolveVisible(deps, scope, input.artifactId);
  const latest = artifact.versions[0]?.number;
  const number = input.version ?? latest;
  const opened =
    number === undefined
      ? undefined
      : deps.artifacts.versionOf(artifact.id, number);
  if (opened === undefined)
    throw new ArtifactError(
      `no such version: ${artifact.id} has versions ${artifact.versions
        .map((v) => v.number)
        .join(", ")}`,
    );
  const { version } = opened;
  const files = await deps.artifacts.filesOf(version);
  const path = (input.path ?? deps.artifacts.entryOf(version)).replace(
    /^\.?\//,
    "",
  );
  const task =
    artifact.taskId === null ? undefined : deps.findTask(artifact.taskId);
  const header = [
    `Artifact ${artifact.id} "${artifact.title}"`,
    `Version ${version.number} of ${artifact.versions.length}${version.number === latest ? " (the newest)" : ""}, published ${when(version.createdAt)}`,
    `Publisher: ${publisherOf(deps, artifact)}`,
    ...(task === undefined ? [] : [`Task: ${taskLabel(task)}`]),
    `Files (${files.length}):`,
    ...files.map((file) => `  ${file.name} (${size(file.size)})`),
  ].join("\n");

  const disk = deps.artifacts.fileOf(version, path);
  if (disk === undefined)
    throw new ArtifactError(`not a path inside the artifact: ${input.path}`);
  const info = await stat(disk).catch(() => undefined);
  if (info === undefined || !info.isFile())
    throw new ArtifactError(
      `no file ${path} in version ${version.number}. ${header}`,
    );
  const details = {
    artifactId: artifact.id,
    version: version.number,
    path,
  };
  const ext = extname(path).toLowerCase();
  const mimeType = IMAGES[ext];
  if (mimeType !== undefined) {
    if (info.size > IMAGE_BYTES)
      return {
        content: [
          {
            type: "text",
            text: `${header}\n\n${path}: an image of ${size(info.size)}, too large to show (the limit is ${size(IMAGE_BYTES)}).`,
          },
        ],
        details,
      };
    const bytes = await readFile(disk);
    return {
      content: [
        {
          type: "text",
          text: `${header}\n\n${path}: ${mimeType}, ${size(info.size)}, attached.`,
        },
        { type: "image", data: bytes.toString("base64"), mimeType },
      ],
      details,
    };
  }
  const text = asText(new Uint8Array(await readFile(disk)));
  if (text === undefined)
    return {
      content: [
        {
          type: "text",
          text: `${header}\n\n${path}: a binary file of ${size(info.size)}; its contents are not shown.`,
        },
      ],
      details,
    };
  const offset = Math.max(1, Math.floor(input.offset ?? 1));
  const limit = Math.max(1, Math.floor(input.limit ?? READ_LINES));
  const shown = page(text, offset, limit);
  const tail =
    shown.shown === 0
      ? `${path} has ${shown.total} lines; nothing from line ${offset}.`
      : shown.left > 0
        ? `(${shown.left} more lines after line ${offset + shown.shown - 1} of ${shown.total}; read on with offset ${offset + shown.shown})`
        : `(end of ${path}, ${shown.total} lines)`;
  return {
    content: [
      {
        type: "text",
        text: `${header}\n\n${path}, lines ${offset}–${offset + Math.max(shown.shown, 1) - 1}:\n${shown.text}\n${tail}`,
      },
    ],
    details,
  };
}
