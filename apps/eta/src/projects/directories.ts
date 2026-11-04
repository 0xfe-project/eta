/**
 * The directories in a directory, for choosing one to add as a project.
 *
 * Asked of the machine by one shell script, the way the project's files are (`files.ts`), so the
 * primary and a daemon have one implementation. `ExecutionEnv.listDir` is not that script: it stats
 * every file and asks nothing about the directories it finds, so it would cost a round trip per
 * entry to a daemon, and over a shell an unreadable directory reads as an empty one.
 *
 * The script's built-ins do the work, so a directory of a hundred thousand files spawns nothing per
 * file. `[ -d ]` follows links, which makes a link to a directory a directory. Names go out
 * NUL-terminated (a name can hold a newline) and nothing else about a file goes out at all.
 *
 * A path is normalized by its text, not resolved through its links, the way `projects.create` keeps
 * it, so a path chosen here is the key a project is already known by.
 */
import type {
  DirectoryEntry,
  DirectoryProblem,
  ProjectResults,
} from "@eta/client-contracts";
import type { SshTransport } from "@eta/ssh";
import { posix, win32 } from "node:path";
import { shellQuote } from "@eta/ssh";

/** More than a person scans; past it the list says so and the filter or a typed path takes over. */
const MAX_ENTRIES = 1000;
const TIMEOUT_MS = 15_000;
/** The script's own exit codes, apart from any code a shell or a transport comes up with. */
const EXIT_MISSING = 66;
const EXIT_DENIED = 77;

/** A listing that failed for a reason the client words itself; `problem` is what it reads. */
export class DirectoryError extends Error {
  readonly problem: { code: DirectoryProblem };

  constructor(code: DirectoryProblem) {
    super(`directory: ${code}`);
    this.problem = { code };
  }
}

/**
 * What is missing behind a directory that cannot be searched is hidden, not missing, so the nearest
 * path that exists says which of the two it is. Visible names come first, so a cap cuts dot
 * directories before anything the list shows by default.
 */
function script(path: string): string {
  const quoted = shellQuote(path);
  return `if [ ! -e ${quoted} ]; then
  at=${quoted}
  while [ "$at" != / ]; do
    at=\${at%/*}
    at=\${at:-/}
    [ -e "$at" ] && break
  done
  [ -x "$at" ] || exit ${EXIT_DENIED}
  exit ${EXIT_MISSING}
fi
[ -d ${quoted} ] || exit ${EXIT_MISSING}
cd -- ${quoted} 2>/dev/null && [ -r . ] || exit ${EXIT_DENIED}
count=0
for entry in * .[!.]* ..?*; do
  [ -d "$entry" ] || continue
  if [ -e "$entry/.git" ]; then mark=g; else mark=-; fi
  printf '%s%s\\0' "$mark" "$entry"
  count=$((count + 1))
  [ "$count" -le ${MAX_ENTRIES} ] || break
done`;
}

/** `~` is the machine's home; anything else that is not absolute names no directory. */
function absolutePath(
  raw: string,
  home: string,
  local: boolean,
): string | undefined {
  const expanded =
    raw === "~" || raw.startsWith("~/") ? `${home}${raw.slice(1)}` : raw;
  const path = local ? win32 : posix;
  // `/` is the machine's root on POSIX and the Git Bash root on Windows. Keep it textual so the
  // chooser's cross-machine result shape does not turn the root into the current drive.
  if (expanded === "/") return "/";
  if (!path.isAbsolute(expanded) || expanded.includes("\0")) return undefined;
  return path.resolve(expanded);
}

/** By name whatever the case, the order a person reads; the raw name settles a tie. */
function byName(a: DirectoryEntry, b: DirectoryEntry): number {
  const left = a.name.toLowerCase();
  const right = b.name.toLowerCase();
  if (left !== right) return left < right ? -1 : 1;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

export async function listDirectories(
  transport: SshTransport,
  raw: string | undefined,
  projectAt: ReadonlyMap<string, string>,
): Promise<ProjectResults["directories"]> {
  const home = transport.home;
  const local = transport.overSsh === false;
  const path = absolutePath(raw ?? home, home, local);
  if (path === undefined) throw new DirectoryError("not_found");
  const result = await transport.run(script(path), { timeoutMs: TIMEOUT_MS });
  if (result.code === EXIT_MISSING) throw new DirectoryError("not_found");
  if (result.code === EXIT_DENIED) throw new DirectoryError("denied");
  // A cut link, a deadline, a machine that would not run it: nobody answered the question.
  if (result.code !== 0) throw new DirectoryError("offline");
  const names = result.stdout.split("\0").filter((line) => line.length > 1);
  const pathModule = local ? win32 : posix;
  const entries = names.slice(0, MAX_ENTRIES).map((line) => {
    const name = line.slice(1);
    return {
      name,
      hidden: name.startsWith("."),
      git: line.startsWith("g"),
      projectId: projectAt.get(pathModule.join(path, name)) ?? null,
    };
  });
  return {
    path,
    home,
    parent:
      path === "/" || pathModule.dirname(path) === path
        ? null
        : pathModule.dirname(path),
    entries: entries.sort(byName),
    truncated: names.length > MAX_ENTRIES,
  };
}
