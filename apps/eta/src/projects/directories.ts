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
 * directories, Windows junctions and Windows hidden/system directories before anything the list
 * shows by default.
 */
function script(path: string, windows: boolean): string {
  const quoted = shellQuote(path);
  const preamble = `if [ ! -e ${quoted} ]; then
  at=${quoted}
  while [ ! -e "$at" ]; do
    next=$(dirname "$at")
    [ "$next" = "$at" ] && break
    at=$next
  done
  [ -x "$at" ] || exit ${EXIT_DENIED}
  exit ${EXIT_MISSING}
fi
[ -d ${quoted} ] || exit ${EXIT_MISSING}
cd -- ${quoted} 2>/dev/null && [ -r . ] || exit ${EXIT_DENIED}`;
  const hiddenNames = windows
    ? `hidden_names=$(attrib //d 2>/dev/null | tr -d '\\r' | awk 'substr($0, 1, 21) ~ /[HS]/ { path=substr($0, 22); for (i=length(path); i>0; i--) if (substr(path, i, 1) == "\\\\") { path=substr(path, i+1); break } print path }')`
    : "";
  const markHidden = windows
    ? `  case "
$hidden_names
" in *"
$entry
"*) hidden=h ;; esac
  [ -L "$entry" ] && hidden=h`
    : "";
  const entries = `${hiddenNames}
count=0
for entry in * .[!.]* ..?*; do
  [ -d "$entry" ] || continue
  case "$entry" in .*) hidden=h ;; *) hidden=v ;; esac
${markHidden}
  if [ -e "$entry/.git" ]; then mark=g; else mark=-; fi
  printf '%s%s%s\\0' "$hidden" "$mark" "$entry"
  count=$((count + 1))
  [ "$count" -le ${MAX_ENTRIES} ] || break
done`;
  return `${preamble}
${entries}`;
}

/**
 * The machine's own kind of path. Its home says which: a Windows machine's is a drive path
 * (`C:\Users\…`), anyone else's is POSIX. How the host reaches it does not: a daemon's link is
 * not over SSH whatever the machine runs, and win32 paths on Linux or macOS turn `/home/a`
 * into `\home\a`, which no shell there can `cd` into.
 */
function pathsOf(home: string): typeof posix {
  return /^[a-z]:[\\/]/i.test(home) ? win32 : posix;
}

/** `~` is the machine's home; anything else that is not absolute names no directory. */
function absolutePath(
  raw: string,
  home: string,
  path: typeof posix,
): string | undefined {
  const expanded =
    raw === "~" ||
    raw.startsWith("~/") ||
    (path === win32 && raw.startsWith("~\\"))
      ? `${home}${raw.slice(1)}`
      : raw;
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
  const pathModule = pathsOf(home);
  const windows = pathModule === win32;
  const path = absolutePath(raw ?? home, home, pathModule);
  if (path === undefined) throw new DirectoryError("not_found");
  const command = script(path, windows);
  const result = await transport.run(command, { timeoutMs: TIMEOUT_MS });
  if (result.code === EXIT_MISSING) throw new DirectoryError("not_found");
  if (result.code === EXIT_DENIED) throw new DirectoryError("denied");
  // A cut link, a deadline, a machine that would not run it: nobody answered the question.
  if (result.code !== 0) throw new DirectoryError("offline");
  const names = result.stdout.split("\0").filter((line) => line.length > 2);
  const entries = names.slice(0, MAX_ENTRIES).map((line) => {
    const name = line.slice(2);
    return {
      name,
      hidden: line.startsWith("h"),
      git: line[1] === "g",
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
