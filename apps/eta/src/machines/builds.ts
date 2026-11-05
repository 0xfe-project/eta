/**
 * The daemon builds this primary carries, one per platform.
 *
 * A daemon is part of the primary it serves: the primary carries a build of it for each platform
 * (`apps/daemon/scripts/build.ts` writes them with a `manifest.json`), and a daemon reporting any
 * other version is replaced with the one carried (`hub.ts`). The same files are what a new machine
 * is installed from (`install.ts`).
 *
 * Run from source the builds are the checkout's `apps/daemon/out/dist`: the manifest is read again
 * when it changes on disk, so a rebuild under a running host is noticed. No manifest means no
 * builds: daemons are left as they are.
 *
 * A compiled host carries them compressed, with the manifest as the build wrote it: `sha256` and
 * `size` are the executable a daemon gets. A build is unpacked when something asks for its file,
 * not to say which version it is, so a host that never hands one out never unpacks one.
 */
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { embeddedFiles, resource, unpack } from "../resources";

export interface DaemonBuild {
  version: string;
  platform: string;
  /** The executable on disk. */
  path: () => Promise<string>;
  sha256: string;
  size: number;
}

interface Manifest {
  version: string;
  builds: Record<string, { file: string; sha256: string; size: number }>;
}

type ManifestEntry = Manifest["builds"][string];

/** Where a set of builds comes from: a directory, or the executable. */
interface BuildSource {
  manifest: () => Manifest | undefined;
  path: (entry: ManifestEntry) => Promise<string>;
}

/** What a manifest's text says, when it says it. */
function parseManifest(text: string): Manifest | undefined {
  try {
    const value = JSON.parse(text) as Partial<Manifest>;
    return typeof value.version === "string" &&
      typeof value.builds === "object" &&
      value.builds !== null
      ? { version: value.version, builds: value.builds }
      : undefined;
  } catch {
    return undefined;
  }
}

function directorySource(dir: string): BuildSource {
  let read: { mtime: number; manifest: Manifest | undefined } | undefined;
  return {
    manifest: () => {
      const path = join(dir, "manifest.json");
      let mtime: number;
      try {
        mtime = statSync(path).mtimeMs;
      } catch {
        read = undefined;
        return undefined;
      }
      if (read?.mtime === mtime) return read.manifest;
      let manifest: Manifest | undefined;
      try {
        manifest = parseManifest(readFileSync(path, "utf8"));
      } catch {
        manifest = undefined;
      }
      read = { mtime, manifest };
      return manifest;
    },
    path: ({ file }) => Promise.resolve(join(dir, file)),
  };
}

function embeddedSource(dataDir: string): BuildSource {
  let manifest: Manifest | undefined;
  return {
    manifest: () =>
      (manifest ??= parseManifest(
        readFileSync(resource("daemon/manifest.json"), "utf8"),
      )),
    path: ({ file, size, sha256 }) =>
      unpack(dataDir, `daemon/${file}.zst`, { size, sha256 }),
  };
}

/** The builds in a directory. */
export const buildsIn = (dir: string): DaemonBuilds =>
  new DaemonBuilds(directorySource(dir));

/** The builds this host carries, or the checkout's. */
export const defaultBuilds = (dataDir: string): DaemonBuilds =>
  embeddedFiles("daemon") === undefined
    ? buildsIn(
        fileURLToPath(new URL("../../../daemon/out/dist", import.meta.url)),
      )
    : new DaemonBuilds(embeddedSource(dataDir));

export class DaemonBuilds {
  readonly #source: BuildSource;

  constructor(source: BuildSource) {
    this.#source = source;
  }

  /** The version every daemon should be; undefined when there are no builds. */
  version(): string | undefined {
    return this.#source.manifest()?.version;
  }

  /** The build for one platform, when there is one. */
  get(platform: string): DaemonBuild | undefined {
    const manifest = this.#source.manifest();
    const entry = manifest?.builds[platform];
    if (manifest === undefined || entry === undefined) return undefined;
    return {
      version: manifest.version,
      platform,
      path: () => this.#source.path(entry),
      sha256: entry.sha256,
      size: entry.size,
    };
  }
}
