/**
 * The host, the first time the app runs one here: the app no longer carries it.
 *
 * Choosing "this computer" is what downloads it, and only that: a remote connection never gets
 * here (`shell.ts`). The release is the newest whose page works in this app (`minDesktop`, in each
 * release's `eta-host.json`), from the repository the app was built to follow (`ETA_HOST_UPSTREAM`,
 * the same define the host has) or `ETA_RELEASES_URL`. A private repository is read with the token
 * the host's own upgrade would use: `GH_TOKEN`, `GITHUB_TOKEN`, then `gh auth token`.
 * `@eta/releases` does the finding, the download and the `SHA256SUMS` check, for this and for the
 * host's upgrade alike.
 *
 * The file arrives beside where it goes, under a name of its own, and only becomes the host once it
 * is whole, checked and has said its version. A download that stops, a wrong sum or a build that
 * does not run leaves nothing behind, so the next try starts clean and no half a host is ever run.
 */
import type { ReleaseFailure } from "@eta/releases";
import { chmod, mkdir, rename, rm } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import process from "node:process";
import {
  chooseUpstream,
  downloadChecked,
  hostForDesktop,
  parseUpstream,
  ReleaseError,
  Releases,
  releaseToken,
} from "@eta/releases";

/** How far a download has got, for the shell's page. */
export interface DownloadProgress {
  version: string;
  received: number;
  total: number | undefined;
}

/** Why there is no host, in the words the shell's page has for it. */
export interface DownloadFailure {
  kind: ReleaseFailure | "broken" | "disk";
  /** There was no token, and the repository may be private. */
  tokenless: boolean;
  detail: string;
}

export interface DownloadOptions {
  /** Where the host goes: `hostHome`. */
  dir: string;
  /** What the host file is called there. */
  name: string;
  appVersion: string;
  /** What the token and the upstream are read from: the login shell's, for `gh`. */
  env: NodeJS.ProcessEnv;
  onProgress: (progress: DownloadProgress) => void;
  /** Runs the downloaded file once and answers what it printed. */
  tryBuild: (file: string) => Promise<string>;
  fetch?: typeof fetch;
}

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** How often the page hears about a download: often enough to move, not so often it is all it does. */
const PROGRESS_MS = 250;

/** Download the host into `dir`; its path once it is there. Throws a `DownloadError`. */
export async function downloadHost(options: DownloadOptions): Promise<string> {
  const { appVersion, dir, env, name, onProgress, tryBuild } = options;
  const chosen = chooseUpstream({ env });
  let releases: Releases;
  try {
    const upstream = parseUpstream(chosen.text);
    releases = new Releases({
      upstream: chosen.text,
      token: () => releaseToken(upstream, env),
      // The app has no Settings to save a token in; the host's errors would point there.
      settings: false,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    });
  } catch (error) {
    throw failure(error);
  }
  const target = join(dir, name);
  // Still `.exe` on Windows: the app's Bun will not start a file there by any other name, and it
  // is run once before it becomes the host.
  const extension = extname(name);
  const part = join(
    dir,
    `${basename(name, extension)}.${String(process.pid)}.download${extension}`,
  );
  try {
    const file = await hostForDesktop(releases, appVersion);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    let last = 0;
    onProgress({ version: file.version, received: 0, total: undefined });
    await downloadChecked(releases, file, part, (received, total) => {
      const now = Date.now();
      if (now - last < PROGRESS_MS && received !== total) return;
      last = now;
      onProgress({ version: file.version, received, total });
    });
    await chmod(part, 0o755);
    const says = await tryBuild(part).catch((error: unknown) => {
      throw new DownloadError({
        kind: "broken",
        tokenless: false,
        detail: `${file.name} ${file.version} did not run: ${message(error)}`,
      });
    });
    if (/^eta-host (\S+)/.exec(says)?.[1] !== file.version)
      throw new DownloadError({
        kind: "broken",
        tokenless: false,
        detail: `${file.name} says "${says.trim() || "nothing"}", not ${file.version}`,
      });
    await rename(part, target);
    return target;
  } catch (error) {
    await rm(part, { force: true });
    throw failure(error);
  }
}

export class DownloadError extends Error {
  readonly failure: DownloadFailure;

  constructor(failure: DownloadFailure) {
    super(failure.detail);
    this.name = "DownloadError";
    this.failure = failure;
  }
}

function failure(error: unknown): DownloadError {
  if (error instanceof DownloadError) return error;
  if (error instanceof ReleaseError)
    return new DownloadError({
      kind: error.kind,
      tokenless: error.tokenless,
      detail: error.message,
    });
  // Anything else is this computer's: a directory it cannot write, a disk that is full.
  return new DownloadError({
    kind: "disk",
    tokenless: false,
    detail: message(error),
  });
}
