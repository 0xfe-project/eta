import type { SiteFile } from "./zip";
/**
 * Where an artifact's bytes live (REFACTOR.md §9, P3.2).
 *
 * One prefix per version: `artifacts/<artifact>/<version>/archive.zip` is the package as uploaded,
 * and `files/<path>` are the files extracted from it — a preview reads the extracted ones, a
 * download reads the archive. AXP put these in S3 with an adapter in front; here they are files
 * under the data directory, and the whole of what a different backend would have to replace is
 * this module.
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

export class ArtifactObjects {
  readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  /** Where a version's bytes are; the prefix an S3 backend would name. */
  versionDir(artifactId: string, version: number): string {
    return join(this.root, artifactId, String(version));
  }

  /**
   * Write a version's files, then its archive.
   *
   * The archive last on purpose: a version whose archive is there but whose files are not would
   * preview as a half-empty site, and the archive is what tells a reader the upload completed.
   */
  async writeVersion(input: {
    artifactId: string;
    version: number;
    archive: Uint8Array;
    files: readonly SiteFile[];
  }): Promise<void> {
    const base = this.versionDir(input.artifactId, input.version);
    for (const file of input.files) {
      const target = this.#under(base, join("files", file.name));
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, file.bytes);
    }
    await writeFile(join(base, "archive.zip"), input.archive);
  }

  /** One extracted file, or `undefined` when the version has no such file. */
  async file(
    artifactId: string,
    version: number,
    name: string,
  ): Promise<Uint8Array | undefined> {
    return await this.#read(
      this.#under(this.versionDir(artifactId, version), join("files", name)),
    );
  }

  async archive(
    artifactId: string,
    version: number,
  ): Promise<Uint8Array | undefined> {
    return await this.#read(
      join(this.versionDir(artifactId, version), "archive.zip"),
    );
  }

  /** Take a version's bytes away: what a failed publish and a delete both need. */
  async removeVersion(artifactId: string, version: number): Promise<void> {
    await rm(this.versionDir(artifactId, version), {
      recursive: true,
      force: true,
    });
  }

  async removeArtifact(artifactId: string): Promise<void> {
    await rm(join(this.root, artifactId), { recursive: true, force: true });
  }

  async #read(path: string): Promise<Uint8Array | undefined> {
    try {
      return new Uint8Array(await readFile(path));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  /**
   * A path inside a version's prefix, or a refusal.
   *
   * The site check already refuses `..` and absolute paths, so this is the second lock on the same
   * door: a file name reaches the filesystem from an upload, and "it was validated upstream" is
   * how a traversal gets in.
   */
  #under(base: string, relative: string): string {
    const target = resolve(base, relative);
    const root = resolve(base);
    if (target !== root && !target.startsWith(root + sep)) {
      throw new Error(`artifact path escapes its version: ${relative}`);
    }
    return target;
  }
}
