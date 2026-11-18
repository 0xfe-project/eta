/**
 * Whether what was typed is a path to open as it is, rather than a name to search for.
 *
 * Adapted from Paseo (`packages/app/src/components/project-picker-options.ts`, `isOpenableProjectPath`,
 * commit `b24eab7`, Apache License 2.0; see `./LICENSE`). Changed for eta: it is asked by the
 * rules of the machine the path is on, not of the client: `C:\x` is a path on Windows and a
 * name anywhere else, and `/x` is a path on Linux and macOS but has no drive on Windows.
 */
import type { PathFlavor } from "./types";

/** POSIX absolute, `~`, a drive (`C:\`, `C:/`) or UNC (`\\server\share`), by the machine's rules. */
export function isOpenablePath(query: string, flavor: PathFlavor): boolean {
  const typed = query.trim();
  if (typed === "~" || typed.startsWith("~/")) return true;
  if (flavor === "posix") return typed.startsWith("/");
  return (
    typed.startsWith("~\\") ||
    /^[a-z]:[\\/]/i.test(typed) ||
    /^[\\/]{2}[^\\/]+[\\/]+[^\\/]+/.test(typed)
  );
}
