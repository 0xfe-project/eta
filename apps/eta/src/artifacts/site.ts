/**
 * What an artifact is made of: a static site, as a list of files.
 *
 * It is read out of a directory through the session's own execution environment (so a session on
 * another machine publishes what is on its machine), judged here, and only then stored. The rules
 * about what a site is are the product's: an `index.html` at the root, every path a clean relative
 * path, no links, within limits. A site that fails any of them is refused whole, with a message
 * that says what to fix: an artifact that is half there looks like a working site, and that is
 * worse than none.
 */
import type { ExecutionEnv } from "@eta/harness";
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

/** What the environment answers, without naming its `Result` type. */
type Answer<T> =
  | { ok: true; value: T }
  | { ok: false; error: { message: string } };

async function ask<T>(what: string, pending: Promise<Answer<T>>): Promise<T> {
  const answer = await pending;
  if (!answer.ok) throw new ArtifactError(`${what}: ${answer.error.message}`);
  return answer.value;
}

/**
 * Read a directory as a site through an execution environment.
 *
 * Symbolic links are refused rather than followed: a site that has one is a site whose contents
 * depend on where it was packed. `.git` and `node_modules` are left out. The limits are checked
 * against the sizes the environment reports, before a file is read, so a huge tree is refused
 * without being loaded.
 */
export async function collectSite(
  env: ExecutionEnv,
  path: string,
  limits: SiteLimits,
  signal?: AbortSignal,
): Promise<SiteFile[]> {
  const options = { signal };
  // The directory itself may be reached through a link; what is inside it may not.
  const root = await ask(
    `cannot read ${path}`,
    env.canonicalPath(path, options),
  );
  const info = await ask(`cannot read ${path}`, env.fileInfo(root, options));
  if (info.kind !== "directory") {
    throw new ArtifactError(
      `${path} is not a directory: publish a directory that has index.html at its root`,
    );
  }

  const files: SiteFile[] = [];
  let declared = 0;
  const walk = async (directory: string, prefix: string): Promise<void> => {
    const entries = await ask(
      `cannot read ${prefix === "" ? path : prefix}`,
      env.listDir(directory, options),
    );
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (SKIPPED.has(entry.name)) continue;
      const name = `${prefix}${entry.name}`;
      if (entry.kind === "symlink")
        throw new ArtifactError(`symbolic links cannot be published: ${name}`);
      if (entry.kind === "directory") {
        await walk(entry.path, `${name}/`);
        continue;
      }
      if (files.length >= limits.files)
        throw new ArtifactError(
          `a site may have at most ${limits.files} files`,
        );
      declared += entry.size;
      if (declared > limits.bytes)
        throw new ArtifactError(
          `a site may be at most ${mib(limits.bytes)} in all`,
        );
      files.push({
        name,
        bytes: await ask(
          `cannot read ${name}`,
          env.readBinaryFile(entry.path, options),
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
 * Judge a site, whole, before a byte of it is stored. Throws an `ArtifactError` saying what to
 * fix; returns the files' total size.
 */
export function checkSite(
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
  if (!seen.has("index.html")) {
    // The common mistake is a directory one level too high; say how to fix it.
    for (const name of seen) {
      const parts = name.split("/");
      if (parts.length === 2 && parts[1] === "index.html") {
        throw new ArtifactError(
          `index.html must be at the root of the site, and it is in ${parts[0]}/: publish ${parts[0]} itself`,
        );
      }
    }
    throw new ArtifactError("the root of the site has no index.html");
  }
  return total;
}

/** The ZIP of a site: what the user downloads. */
export function packSite(files: readonly SiteFile[]): Uint8Array {
  return zipSync(Object.fromEntries(files.map((f) => [f.name, f.bytes])));
}
