/**
 * The files of a project, for the composer's `@` completion.
 *
 * Computed on the project's own machine by one shell script, so a project on a daemon is listed
 * by the daemon's filesystem and the primary does the same through its own shell. In a git
 * checkout the list is what git knows (tracked and not ignored), which already leaves out
 * `node_modules` and build output; elsewhere it is a bounded `find`. Either way the result is
 * filtered once more for the directories that never hold a file anyone means, ordered shallow
 * first (the files most likely meant), and capped, so a large tree cannot turn a menu into a hang.
 *
 * Paths are relative to the project's directory: that is where the agent runs, so `@src/app.ts`
 * is a path it can open.
 */
import type {
  ProjectDirectoryListing,
  ProjectFileContent,
  ProjectFileEntry,
} from "@eta/client-contracts";
import type { SshTransport } from "@eta/ssh";
import { Buffer } from "node:buffer";
import { shellQuote } from "@eta/ssh";

/** Directories whose contents are never what a person is pointing at. */
const SKIP_DIRECTORIES: ReadonlySet<string> = new Set([
  "node_modules",
  ".git",
  ".eta",
  "dist",
  "out",
  "build",
  ".next",
  ".turbo",
  ".cache",
  "target",
  "vendor",
  "__pycache__",
  ".venv",
]);

export const DEFAULT_FILE_LIMIT = 2000;
const MAX_FILE_LIMIT = 5000;
export const DEFAULT_DIRECTORY_LIMIT = 500;
const MAX_DIRECTORY_LIMIT = 2000;
/** Read at most 256 KiB for inline previews so large files never stall the link or UI. */
export const MAX_PREVIEW_BYTES = 256 * 1024;
/** Deeper than this is not a project layout, it is a filesystem. */
const MAX_DEPTH = 8;
/** What the script may print before it is cut: more than any menu can use. */
const RAW_LINES = 30_000;
const TIMEOUT_MS = 15_000;

const prunes = [...SKIP_DIRECTORIES].map((name) => `-name ${shellQuote(name)}`);

function script(path: string): string {
  return [
    `cd ${shellQuote(path)} || exit 2`,
    "{",
    "if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then",
    "  git -c core.quotepath=false ls-files --cached --others --exclude-standard",
    "else",
    `  find . -maxdepth ${MAX_DEPTH} \\( ${prunes.join(" -o ")} \\) -prune -o -type f -print | sed 's|^\\./||'`,
    "fi",
    `} | head -n ${RAW_LINES}`,
  ].join("\n");
}

/** Keep a path whose directories are all ones worth looking into. */
function worthListing(path: string): boolean {
  if (path === "") return false;
  const directories = path.split("/").slice(0, -1);
  return !directories.some((name) => SKIP_DIRECTORIES.has(name));
}

/** Shallow files first, then by name: the order a short menu wants. */
function shallowFirst(a: string, b: string): number {
  const depth = (path: string) => path.split("/").length;
  return depth(a) - depth(b) || (a < b ? -1 : a > b ? 1 : 0);
}

/** Validate and normalize a POSIX path relative to the project root. */
function normalizeRelativePath(raw: string, allowEmpty: boolean): string {
  if (raw.includes("\\") || /^[a-z]:/i.test(raw) || raw.startsWith("/"))
    throw new Error(`invalid project path: ${raw}`);
  for (let i = 0; i < raw.length; i += 1) {
    if (raw.charCodeAt(i) < 0x20)
      throw new Error(`invalid project path: ${raw}`);
  }
  const trimmed = raw.replace(/\/+$/, "");
  if (trimmed === "") {
    if (!allowEmpty) throw new Error("file path is required");
    return "";
  }
  const parts = trimmed.split("/");
  for (const part of parts) {
    if (part === "" || part === "." || part === "..")
      throw new Error(`invalid project path: ${raw}`);
  }
  return parts.join("/");
}

/** Shell guard ensuring `$1` resolves inside `$root_real`. */
const insideRootGuard = (varName: string): string =>
  [
    'if [ "$root_real" != "/" ]; then',
    `  case "$${varName}" in`,
    '    "$root_real"|"$root_real"/*) ;;',
    "    *) exit 4 ;;",
    "  esac",
    "fi",
  ].join("\n");

function directoryScript(projectPath: string, relPath: string): string {
  const lines = [
    `cd -P -- ${shellQuote(projectPath)} 2>/dev/null || exit 2`,
    "root_real=$(pwd -P) || exit 2",
  ];
  if (relPath !== "") {
    lines.push(
      `cd -P -- ${shellQuote(relPath)} 2>/dev/null || exit 2`,
      "dir_real=$(pwd -P) || exit 2",
      insideRootGuard("dir_real"),
    );
  }
  lines.push(
    "nl='",
    "'",
    "tab=$(printf '\\t')",
    "for e in .[!.]* ..?* *; do",
    '  [ -e "$e" ] || [ -L "$e" ] || continue',
    '  case "$e" in *"$nl"*|*"$tab"*) continue ;; esac',
    '  if [ -d "$e" ]; then',
    "    printf 'd\\t%s\\n' \"$e\"",
    '  elif [ -f "$e" ]; then',
    "    printf 'f\\t%s\\n' \"$e\"",
    "  fi",
    "done",
  );
  return lines.join("\n");
}

function readFileScript(
  projectPath: string,
  parentDir: string,
  fileName: string,
): string {
  const lines = [
    `cd -P -- ${shellQuote(projectPath)} 2>/dev/null || exit 2`,
    "root_real=$(pwd -P) || exit 2",
  ];
  if (parentDir !== "") {
    lines.push(
      `cd -P -- ${shellQuote(parentDir)} 2>/dev/null || exit 2`,
      "dir_real=$(pwd -P) || exit 2",
      insideRootGuard("dir_real"),
    );
  }
  lines.push(
    `file=${shellQuote(fileName)}`,
    '[ -e "$file" ] || exit 2',
    '[ -f "$file" ] || exit 3',
    'if [ -L "$file" ]; then',
    "  if command -v realpath >/dev/null 2>&1; then",
    '    file_real=$(realpath "$file" 2>/dev/null) || exit 4',
    "  elif command -v readlink >/dev/null 2>&1; then",
    '    file_real=$(readlink -f "$file" 2>/dev/null) || exit 4',
    "  else",
    "    exit 4",
    "  fi",
    insideRootGuard("file_real"),
    "fi",
    'size=$(stat -c \'%s\' "$file" 2>/dev/null || stat -f \'%z\' "$file" 2>/dev/null || wc -c < "$file") || exit 5',
    "size=$(printf '%s' \"$size\" | tr -d '[:space:]')",
    "printf '%s\\n' \"$size\"",
    `head -c ${MAX_PREVIEW_BYTES} "$file" | base64 | tr -d '\\r\\n' | tr '+/' '-_'`,
  );
  return lines.join("\n");
}

function compareEntries(a: ProjectFileEntry, b: ProjectFileEntry): number {
  if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
  const cmp = a.name.localeCompare(b.name, undefined, {
    numeric: true,
    sensitivity: "base",
  });
  return cmp !== 0 ? cmp : a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/**
 * Decode UTF-8 bytes strictly, trimming a split trailing multi-byte sequence when the buffer was
 * truncated at a fixed byte boundary. Returns `undefined` when the bytes are not valid UTF-8.
 */
function decodeUtf8(bytes: Uint8Array, truncated: boolean): string | undefined {
  let slice = bytes;
  if (truncated && slice.length > 0) {
    // Walk back past trailing continuation bytes (10xxxxxx) to inspect the leading byte.
    let end = slice.length;
    let cont = 0;
    while (end > 0 && cont < 3 && (slice[end - 1]! & 0xc0) === 0x80) {
      end -= 1;
      cont += 1;
    }
    if (end > 0) {
      const lead = slice[end - 1]!;
      const expected =
        (lead & 0x80) === 0
          ? 1
          : (lead & 0xe0) === 0xc0
            ? 2
            : (lead & 0xf0) === 0xe0
              ? 3
              : (lead & 0xf8) === 0xf0
                ? 4
                : 0;
      if (expected > 1 && cont + 1 < expected)
        slice = slice.subarray(0, end - 1);
    }
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(slice);
  } catch {
    return undefined;
  }
}

export interface FileListing {
  files: string[];
  /** More files exist than were returned. */
  truncated: boolean;
}

export async function listProjectFiles(
  transport: SshTransport,
  path: string,
  limit = DEFAULT_FILE_LIMIT,
): Promise<FileListing> {
  const result = await transport.run(script(path), { timeoutMs: TIMEOUT_MS });
  if (result.code === 2) throw new Error(`no such directory: ${path}`);
  if (result.timedOut === true)
    throw new Error("listing the files took too long");
  if (result.code !== 0 && result.stdout === "")
    throw new Error(result.stderr.trim() || "could not list the files");
  const files = [...new Set(result.stdout.split("\n"))]
    .filter(worthListing)
    .sort(shallowFirst);
  const kept = Math.max(1, Math.min(MAX_FILE_LIMIT, Math.floor(limit)));
  return { files: files.slice(0, kept), truncated: files.length > kept };
}

export async function listProjectDirectory(
  transport: SshTransport,
  projectPath: string,
  rawRelPath = "",
  limit = DEFAULT_DIRECTORY_LIMIT,
): Promise<ProjectDirectoryListing> {
  const relPath = normalizeRelativePath(rawRelPath, true);
  const result = await transport.run(directoryScript(projectPath, relPath), {
    timeoutMs: TIMEOUT_MS,
  });
  if (result.timedOut === true)
    throw new Error("listing the directory took too long");
  if (result.code === 2)
    throw new Error(`no such directory: ${relPath || projectPath}`);
  if (result.code === 4)
    throw new Error(`path is outside the project: ${relPath}`);
  if (result.code !== 0)
    throw new Error(result.stderr.trim() || "could not list the directory");

  const entries: ProjectFileEntry[] = [];
  for (const rawLine of result.stdout.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (line === "") continue;
    const tab = line.indexOf("\t");
    if (tab !== 1) continue;
    const tag = line[0];
    const name = line.slice(2);
    if (name === "" || name === "." || name === ".." || name === ".git")
      continue;
    if (tag !== "d" && tag !== "f") continue;
    const entryPath = relPath === "" ? name : `${relPath}/${name}`;
    entries.push({
      name,
      path: entryPath,
      kind: tag === "d" ? "directory" : "file",
      ...(name.startsWith(".") ? { hidden: true } : {}),
    });
  }
  entries.sort(compareEntries);
  const kept = Math.max(1, Math.min(MAX_DIRECTORY_LIMIT, Math.floor(limit)));
  return {
    path: relPath,
    entries: entries.slice(0, kept),
    truncated: entries.length > kept,
  };
}

export async function readProjectFile(
  transport: SshTransport,
  projectPath: string,
  rawRelPath: string,
): Promise<ProjectFileContent> {
  const relPath = normalizeRelativePath(rawRelPath, false);
  const slash = relPath.lastIndexOf("/");
  const parentDir = slash < 0 ? "" : relPath.slice(0, slash);
  const fileName = slash < 0 ? relPath : relPath.slice(slash + 1);
  const result = await transport.run(
    readFileScript(projectPath, parentDir, fileName),
    { timeoutMs: TIMEOUT_MS },
  );
  if (result.timedOut === true)
    throw new Error("reading the file took too long");
  if (result.code === 2) throw new Error(`no such file: ${relPath}`);
  if (result.code === 3) throw new Error(`not a regular file: ${relPath}`);
  if (result.code === 4)
    throw new Error(`path is outside the project: ${relPath}`);
  if (result.code !== 0)
    throw new Error(result.stderr.trim() || "could not read the file");

  const newline = result.stdout.indexOf("\n");
  const sizeText = (
    newline < 0 ? result.stdout : result.stdout.slice(0, newline)
  ).trim();
  const size = Number.parseInt(sizeText, 10);
  if (!Number.isFinite(size) || size < 0)
    throw new Error(`could not determine file size: ${relPath}`);
  const payload = (newline < 0 ? "" : result.stdout.slice(newline + 1)).replace(
    /\s+/g,
    "",
  );
  const bytes = Buffer.from(payload, "base64url");
  if (bytes.includes(0)) {
    return { kind: "binary", path: relPath, size, reason: "binary" };
  }
  const truncated = size > MAX_PREVIEW_BYTES;
  const text = decodeUtf8(bytes, truncated);
  if (text === undefined) {
    return { kind: "binary", path: relPath, size, reason: "binary" };
  }
  return { kind: "text", path: relPath, text, size, truncated };
}
