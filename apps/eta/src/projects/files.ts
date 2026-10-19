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
import type { SshTransport } from "@eta/ssh";
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
