/**
 * What places needs of the machine: its filesystem and its programs. The real ones by default;
 * a test hands in a filesystem with Windows paths, or a `git` that says what it is told to.
 */
import type { PlaceFailure } from "@eta/client-contracts";
import type { Dirent } from "node:fs";
import * as nodeFsModule from "node:fs";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { execa } from "execa";

export type EntryKind = "directory" | "file" | "link-directory" | "link-other";

export interface FsEntry {
  name: string;
  kind: EntryKind;
}

export interface PlaceFs {
  /** The entries of a directory. Throws a `PlaceError` (`not_found`, `denied`, `not_directory`). */
  list: (path: string) => Promise<FsEntry[]>;
  /** What is at `path`, following links; undefined when nothing is. */
  stat: (path: string) => Promise<{ directory: boolean } | undefined>;
  /** Make one directory, its parent already there. */
  mkdir: (path: string) => Promise<void>;
  /** Remove a directory and what is in it, as a clone that stopped halfway leaves it. */
  remove: (path: string) => Promise<void>;
  /** What `fdir` walks a home with for a search: `node:fs`, or a stand-in in a test. */
  walker: FSLike;
}

/** The part of `node:fs` that `fdir` reads a tree with. */
export type FSLike = Pick<
  typeof nodeFsModule,
  "readdir" | "readdirSync" | "realpath" | "realpathSync" | "stat" | "statSync"
>;

/** A failure that keeps its code across the wire (`problem`) and the link (`failure`). */
export class PlaceError extends Error {
  readonly failure: PlaceFailure;
  readonly problem: { code: string; params?: Record<string, string> };

  constructor(code: PlaceFailure["code"], detail?: string) {
    super(
      detail === undefined ? `places: ${code}` : `places: ${code}: ${detail}`,
    );
    this.name = "PlaceError";
    this.failure = detail === undefined ? { code } : { code, detail };
    this.problem =
      detail === undefined ? { code } : { code, params: { detail } };
  }
}

/** A filesystem error, by its errno, as a place problem. */
export function fsFailure(error: unknown): PlaceError {
  if (error instanceof PlaceError) return error;
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "ENOENT") return new PlaceError("not_found");
  if (code === "EACCES" || code === "EPERM") return new PlaceError("denied");
  if (code === "ENOTDIR") return new PlaceError("not_directory");
  if (code === "EEXIST") return new PlaceError("exists");
  return new PlaceError(
    "other",
    error instanceof Error ? error.message : String(error),
  );
}

function kindOf(entry: Dirent): EntryKind | "other" {
  if (entry.isDirectory()) return "directory";
  if (entry.isSymbolicLink()) return "link-other";
  if (entry.isFile()) return "file";
  return "other";
}

export const nodeFs: PlaceFs = {
  async list(path) {
    let entries: Dirent[];
    try {
      entries = await readdir(path, { withFileTypes: true });
    } catch (error) {
      throw fsFailure(error);
    }
    const out: FsEntry[] = [];
    for (const entry of entries) {
      const kind = kindOf(entry);
      if (kind === "other") continue;
      if (kind !== "link-other") {
        out.push({ name: entry.name, kind });
        continue;
      }
      // A link, or a Windows junction: what it points at decides.
      const target = await stat(join(path, entry.name)).catch(() => undefined);
      out.push({
        name: entry.name,
        kind: target?.isDirectory() === true ? "link-directory" : "link-other",
      });
    }
    return out;
  },
  async stat(path) {
    try {
      return { directory: (await stat(path)).isDirectory() };
    } catch (error) {
      const failure = fsFailure(error);
      if (
        failure.failure.code === "not_found" ||
        failure.failure.code === "not_directory"
      )
        return undefined;
      throw failure;
    }
  },
  async mkdir(path) {
    try {
      await mkdir(path);
    } catch (error) {
      throw fsFailure(error);
    }
  },
  async remove(path) {
    await rm(path, { recursive: true, force: true });
  },
  walker: nodeFsModule,
};

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  /** The program is not on the machine's PATH. */
  missing?: boolean;
  /** Stopped by the signal or the deadline. */
  aborted?: boolean;
  timedOut?: boolean;
}

export interface RunOptions {
  cwd?: string;
  env?: Record<string, string>;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** Run a program with its arguments, no shell between: nothing is quoted or interpreted. */
export type PlaceRunner = (
  command: string,
  args: readonly string[],
  options?: RunOptions,
) => Promise<RunResult>;

const MAX_OUTPUT = 4 * 1024 * 1024;

/**
 * Programs run with `execa`: no shell, the deadline and the cancel signal kill the process, a
 * program that is not on the PATH is told apart, and output beyond a few megabytes is cut.
 */
export const nodeRunner: PlaceRunner = async (command, args, options = {}) => {
  const result = await execa(command, args, {
    reject: false,
    stdin: "ignore",
    windowsHide: true,
    maxBuffer: MAX_OUTPUT,
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }),
    ...(options.signal === undefined ? {} : { cancelSignal: options.signal }),
  });
  return {
    code: result.exitCode ?? 1,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
    ...(result.code === "ENOENT" ? { missing: true } : {}),
    ...(result.isCanceled ? { aborted: true } : {}),
    ...(result.timedOut ? { timedOut: true } : {}),
  };
};

/** Whether a program's complaint is about the network. */
export function classifyNetwork(stderr: string): "network" | undefined {
  return /could not resolve host|unable to access|connection (?:timed out|refused|reset)|network is unreachable|failed to connect|could not read from remote repository\.\s*$/im.test(
    stderr,
  ) && !/permission denied|authentication|not found/i.test(stderr)
    ? "network"
    : undefined;
}
