/**
 * What an artifact is made of: a list of files.
 *
 * They are read out of a directory on this machine's disk, judged here, and only then stored. The
 * rules here hold for every kind of artifact: every path a clean relative path, no links, within
 * limits. What else makes them a site is the kind's (`kinds/`). Files that fail any rule are
 * refused whole, with a message that says what to fix: an artifact that is half there looks like a
 * working site, and that is worse than none.
 */
import { lstat, readdir, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { zipSync } from "fflate";

/** What a site may hold. */
export interface SiteLimits {
  /** Files in it (directories do not count). */
  files: number;
  /** Their total size in bytes. */
  bytes: number;
}

export const DEFAULT_LIMITS: SiteLimits = {
  files: 5000,
  bytes: 100 * 1024 * 1024,
};

/** A refusal a person can act on: the site is not one, the artifact is not theirs, and so on. */
export class ArtifactError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArtifactError";
  }
}

export interface SiteFile {
  /** A clean relative path with `/` separators. */
  name: string;
  bytes: Uint8Array;
}

/** Somebody's tooling, not the site. */
const SKIPPED = new Set([".git", "node_modules", ".DS_Store"]);

const mib = (bytes: number): string =>
  `${Math.round((bytes / 1024 / 1024) * 10) / 10} MiB`;

/** A filesystem failure, said as a refusal the publisher can act on. */
async function ask<T>(what: string, pending: Promise<T>): Promise<T> {
  try {
    return await pending;
  } catch (error) {
    throw new ArtifactError(
      `${what}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Read a directory as a site. A relative `path` is taken against `cwd`.
 *
 * Symbolic links are refused rather than followed: a site that has one is a site whose contents
 * depend on where it was packed. `.git` and `node_modules` are left out. The limits are checked
 * against the sizes the filesystem reports, before a file is read, so a huge tree is refused
 * without being loaded.
 */
export async function collectSite(
  cwd: string,
  path: string,
  limits: SiteLimits,
  signal?: AbortSignal,
): Promise<SiteFile[]> {
  const absolute = isAbsolute(path) ? path : resolve(cwd, path);
  // The directory itself may be reached through a link; what is inside it may not.
  const root = await ask(`cannot read ${path}`, realpath(absolute));
  const info = await ask(`cannot read ${path}`, stat(root));
  if (!info.isDirectory()) {
    throw new ArtifactError(
      `${path} is not a directory: publish a directory that has index.html at its root`,
    );
  }

  const files: SiteFile[] = [];
  let declared = 0;
  const walk = async (directory: string, prefix: string): Promise<void> => {
    signal?.throwIfAborted();
    const entries = await ask(
      `cannot read ${prefix === "" ? path : prefix}`,
      readdir(directory, { withFileTypes: true }),
    );
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (SKIPPED.has(entry.name)) continue;
      const name = `${prefix}${entry.name}`;
      const full = join(directory, entry.name);
      if (entry.isSymbolicLink())
        throw new ArtifactError(`symbolic links cannot be published: ${name}`);
      if (entry.isDirectory()) {
        await walk(full, `${name}/`);
        continue;
      }
      if (files.length >= limits.files)
        throw new ArtifactError(
          `a site may have at most ${limits.files} files`,
        );
      declared += (await ask(`cannot read ${name}`, lstat(full))).size;
      if (declared > limits.bytes)
        throw new ArtifactError(
          `a site may be at most ${mib(limits.bytes)} in all`,
        );
      files.push({
        name,
        bytes: new Uint8Array(
          await ask(`cannot read ${name}`, readFile(full, { signal })),
        ),
      });
    }
  };
  await walk(root, "");
  return files;
}

/** A clean relative path under the site's root, the same on every system. */
function checkName(name: string): void {
  if (name === "" || name.length > 1024)
    throw new ArtifactError(`not a usable path: ${JSON.stringify(name)}`);
  if (/[\\\0:]/.test(name)) {
    throw new ArtifactError(
      `a path may not have a backslash, a colon or a NUL: ${JSON.stringify(name)}`,
    );
  }
  for (const part of name.split("/")) {
    if (part === "" || part === "." || part === ".." || part.length > 255)
      throw new ArtifactError(
        `a path must be a clean path under the root: ${JSON.stringify(name)}`,
      );
  }
}

/**
 * Judge the files, whole, before a byte of them is stored. Throws an `ArtifactError` saying what to
 * fix; returns their total size.
 */
export function checkFiles(
  files: readonly SiteFile[],
  limits: SiteLimits,
): number {
  if (files.length > limits.files)
    throw new ArtifactError(`a site may have at most ${limits.files} files`);
  const seen = new Set<string>();
  let total = 0;
  for (const file of files) {
    checkName(file.name);
    if (seen.has(file.name))
      throw new ArtifactError(`the same file twice: ${file.name}`);
    seen.add(file.name);
    total += file.bytes.byteLength;
  }
  if (total > limits.bytes)
    throw new ArtifactError(
      `a site may be at most ${mib(limits.bytes)} in all`,
    );
  return total;
}

/** The ZIP of a site: what the user downloads. */
export function packSite(files: readonly SiteFile[]): Uint8Array {
  return zipSync(Object.fromEntries(files.map((f) => [f.name, f.bytes])));
}
