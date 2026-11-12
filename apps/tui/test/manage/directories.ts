/**
 * `projects.directories` answered from a temporary directory tree, for the `/new` tests. The
 * host lists directories with a POSIX shell script, which does not run on a Windows primary, so
 * the tests answer it here, keeping its contract: the home when no path is given or `~`, the
 * entries sorted by name whatever the case, `git` for a directory holding `.git`, the project at
 * a path when the test says there is one, and `problem.code` `not_found` for a missing path.
 */
import type { ProjectResults } from "@eta/client-contracts";
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { WireError } from "../../src/connection/wire";

export interface DirectoryTree {
  home: string;
  /** Absolute path to project id. */
  projects?: Map<string, string>;
  /** Lists at most this many entries and says it was truncated. */
  limit?: number;
}

export function listDirectories(tree: DirectoryTree) {
  return async (args: unknown): Promise<ProjectResults["directories"]> => {
    const asked = (args as { path?: string }).path;
    const path =
      asked === undefined || asked === "~" ? tree.home : resolve(asked);
    if (!existsSync(path) || !statSync(path).isDirectory())
      throw new WireError("server", "directory: not_found", {
        code: "not_found",
      });
    const names = readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
    const limit = tree.limit ?? Number.POSITIVE_INFINITY;
    const parent = dirname(path) === path ? null : dirname(path);
    return {
      path,
      home: tree.home,
      parent,
      entries: names.slice(0, limit).map((name) => ({
        name,
        hidden: name.startsWith("."),
        git: existsSync(join(path, name, ".git")),
        projectId: tree.projects?.get(join(path, name)) ?? null,
      })),
      truncated: names.length > limit,
    };
  };
}
