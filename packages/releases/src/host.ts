/**
 * A host release, from finding one to a checked file on disk. The host's own upgrade
 * (`apps/eta/src/upgrade/upgrade.ts`) and the desktop app's first download
 * (`apps/desktop/src/bun/download.ts`) both go through here.
 *
 * Which release the app may take is the host's to say: each release since the contract carries
 * `eta-host.json` with the oldest desktop app its page works in (`@eta/client-contracts/desktop`),
 * so the app reads that and not the 390MB beside it. A release without one is older than the app
 * running hosts it downloads, and is not offered.
 */
import type { Release, ReleaseAsset, Releases } from "./releases";
import { rm } from "node:fs/promises";
import process from "node:process";
import { desktopTooOld } from "@eta/client-contracts/desktop";
import { parseSums, ReleaseError } from "./releases";

const SUMS_FILE = "SHA256SUMS";
const MANIFEST_FILE = "eta-host.json";
/** Host releases looked at for one this app can run, newest first. */
const CANDIDATES = 10;

/** What a release calls a computer: `release.yml`'s names, not Node's. */
export const hostAsset = (
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string =>
  platform === "win32"
    ? `eta-host-windows-${arch}.exe`
    : `eta-host-${platform}-${arch}`;

/** A release's file for this computer, and the sum it was published with. */
export interface HostFile {
  name: string;
  version: string;
  asset: ReleaseAsset;
  sha256: string;
}

/** `release`'s host for `platform`, with its sum; throws when the release has none. */
export async function hostFile(
  releases: Releases,
  release: Release,
  name: string = hostAsset(),
): Promise<HostFile> {
  const asset = release.assets.find((file) => file.name === name);
  if (asset === undefined)
    throw new ReleaseError(
      "none",
      `${release.version} has no build for this computer: ${name}`,
    );
  const sumsAsset = release.assets.find((file) => file.name === SUMS_FILE);
  if (sumsAsset === undefined)
    throw new ReleaseError("none", `${release.version} has no ${SUMS_FILE}`);
  const sha256 = parseSums(await releases.text(sumsAsset)).get(name);
  if (sha256 === undefined)
    throw new ReleaseError(
      "none",
      `${SUMS_FILE} of ${release.version} does not name ${name}`,
    );
  return { name, version: release.version, asset, sha256 };
}

/**
 * `file` into `path`, checked; nothing at `path` unless it is the file that was published. What
 * goes wrong partway leaves nothing behind either.
 */
export async function downloadChecked(
  releases: Releases,
  file: HostFile,
  path: string,
  onProgress?: (received: number, total: number | undefined) => void,
): Promise<void> {
  let digest: string;
  try {
    digest = await releases.download(file.asset, path, onProgress);
  } catch (error) {
    await rm(path, { force: true });
    throw error;
  }
  if (digest !== file.sha256) {
    await rm(path, { force: true });
    throw new ReleaseError(
      "checksum",
      `the checksum of ${file.name} is ${digest}, not the ${file.sha256} of ${SUMS_FILE}`,
    );
  }
}

/** What `eta-host --version --json` says, as a release publishes it. */
interface HostManifest {
  version: string;
  minDesktop: string;
}

/**
 * The newest host release an app of `appVersion` can run, and its file for this computer. One
 * whose page needs a newer app, or that does not say, is passed over for the one before it.
 */
export async function hostForDesktop(
  releases: Releases,
  appVersion: string,
  name: string = hostAsset(),
): Promise<HostFile> {
  const candidates = (await releases.hosts()).slice(0, CANDIDATES);
  let newest: string | undefined;
  for (const release of candidates) {
    const manifest = release.assets.find((file) => file.name === MANIFEST_FILE);
    if (manifest === undefined) continue;
    let says: HostManifest;
    try {
      says = JSON.parse(await releases.text(manifest)) as HostManifest;
    } catch (error) {
      if (error instanceof SyntaxError) continue;
      throw error;
    }
    if (typeof says.minDesktop !== "string") continue;
    if (desktopTooOld(appVersion, says.minDesktop)) {
      newest ??= `${release.version} needs the app ${says.minDesktop}`;
      continue;
    }
    return await hostFile(releases, release, name);
  }
  throw new ReleaseError(
    "none",
    newest === undefined
      ? `${releases.upstream.label} has no host release this app can run`
      : `${releases.upstream.label} has no host release this app ${appVersion} can run: ${newest}`,
  );
}
