/**
 * The daemon builds this primary carries, one per platform.
 *
 * A daemon is part of the primary it serves: the primary carries a build of it for each platform
 * (`apps/daemon/scripts/build.ts` writes them with a `manifest.json`), and a daemon reporting any
 * other version is replaced with the one carried (`hub.ts`). The same files are what a new machine
 * is installed from (`install.ts`).
 *
 * Run from source the builds are the checkout's `apps/daemon/out/dist`; a compiled host keeps them
 * beside itself in `daemon/`. The manifest is read again when it changes on disk, so a rebuild
 * under a running host is noticed. No manifest means no builds: daemons are left as they are.
 */
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { resourcePath } from "../resources";

export interface DaemonBuild {
  version: string;
  platform: string;
  path: string;
  sha256: string;
  size: number;
}

interface Manifest {
  version: string;
  builds: Record<string, { file: string; sha256: string; size: number }>;
}

/** Where the builds are by default. */
export const defaultBuildsDir = (): string =>
  resourcePath("daemon", new URL("../../../daemon/out/dist", import.meta.url));

export class DaemonBuilds {
  readonly #dir: string | undefined;
  #read: { mtime: number; manifest: Manifest | undefined } | undefined;

  constructor(dir: string | undefined) {
    this.#dir = dir;
  }

  /** The version every daemon should be; undefined when there are no builds. */
  version(): string | undefined {
    return this.#manifest()?.version;
  }

  /** The build for one platform, when there is one. */
  get(platform: string): DaemonBuild | undefined {
    const manifest = this.#manifest();
    const entry = manifest?.builds[platform];
    if (
      manifest === undefined ||
      entry === undefined ||
      this.#dir === undefined
    )
      return undefined;
    return {
      version: manifest.version,
      platform,
      path: join(this.#dir, entry.file),
      sha256: entry.sha256,
      size: entry.size,
    };
  }

  #manifest(): Manifest | undefined {
    if (this.#dir === undefined) return undefined;
    const path = join(this.#dir, "manifest.json");
    let mtime: number;
    try {
      mtime = statSync(path).mtimeMs;
    } catch {
      this.#read = undefined;
      return undefined;
    }
    if (this.#read?.mtime === mtime) return this.#read.manifest;
    let manifest: Manifest | undefined;
    try {
      const value = JSON.parse(readFileSync(path, "utf8")) as Partial<Manifest>;
      manifest =
        typeof value.version === "string" &&
        typeof value.builds === "object" &&
        value.builds !== null
          ? { version: value.version, builds: value.builds }
          : undefined;
    } catch {
      manifest = undefined;
    }
    this.#read = { mtime, manifest };
    return manifest;
  }
}
