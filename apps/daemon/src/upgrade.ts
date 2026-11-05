/**
 * A daemon replacing itself with the build the primary carries.
 *
 * The primary asks (`upgrade`, a `svc` call) with the version and the SHA-256 it expects. The
 * daemon fetches the bytes from the primary with its own credential, checks them, writes them
 * beside its executable and runs them once (`version`) to see that they start and are what was
 * asked for. Only then is the swap made: the running file is kept as `<exe>.prev`, the new one
 * takes its name, a marker is left in the data directory, and the process exits with
 * `RESTART_EXIT` for its service manager to start it again — systemd's `Restart=on-failure` and
 * launchd's `KeepAlive.SuccessfulExit=false` both do on a non-zero exit.
 *
 * The new build settles the marker when it starts (`settleUpgrade`): once it is let back in it
 * deletes the marker and the old file; if it is not let in in time, or has been started too many
 * times without getting there, it puts the old file back and exits for the old one to start. A
 * build that cannot start at all is caught before the swap, by the trial run.
 */
import type { DaemonInstall, DaemonPlatform } from "@eta/client-contracts";
import type { Identity } from "./identity";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { chmod, rename, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { DAEMON_DOWNLOAD_PATH } from "@eta/client-contracts";

const run = promisify(execFile);

/** The exit that asks the service manager for a restart: EX_TEMPFAIL. */
export const RESTART_EXIT = 75;

/** How long a new build has to get back in before the old one is put back. */
const SETTLE_MS = 90_000;
/** Starts of a new build that never got back in, before the old one is put back regardless. */
const MAX_STARTS = 3;

export function daemonPlatform(): DaemonPlatform {
  return `${process.platform}-${process.arch}`;
}

/**
 * How this process was started. A service manager sets something in the environment of what it
 * starts: systemd an `INVOCATION_ID`, launchd the job's label as `XPC_SERVICE_NAME`.
 */
export function installKind(
  env: NodeJS.ProcessEnv = process.env,
  execPath: string = process.execPath,
): DaemonInstall {
  if (basename(execPath).startsWith("bun")) return "source";
  if (
    (env.INVOCATION_ID ?? "") !== "" ||
    env.XPC_SERVICE_NAME === "io.eta.daemon"
  )
    return "service";
  return "binary";
}

interface Marker {
  /** The version swapped in. */
  version: string;
  /** The version it replaced. */
  from: string;
  /** Where the replaced file was kept. */
  previous: string;
  /** Times the new build has started without settling. */
  starts: number;
}

const markerPath = (dataDir: string): string => join(dataDir, "upgrade.json");

function readMarker(dataDir: string): Marker | undefined {
  try {
    const value = JSON.parse(
      readFileSync(markerPath(dataDir), "utf8"),
    ) as Partial<Marker>;
    if (
      typeof value.version !== "string" ||
      typeof value.from !== "string" ||
      typeof value.previous !== "string"
    )
      return undefined;
    return {
      version: value.version,
      from: value.from,
      previous: value.previous,
      starts: typeof value.starts === "number" ? value.starts : 0,
    };
  } catch {
    return undefined;
  }
}

export interface UpgradeOptions {
  identity: Identity;
  dataDir: string;
  /** The running build. */
  version: string;
  execPath?: string;
  install?: DaemonInstall;
  fetch?: typeof fetch;
}

/** Fetch, check and swap in a build. On success the caller exits with `RESTART_EXIT`. */
export async function upgrade(
  wanted: { version: string; sha256: string },
  options: UpgradeOptions,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const execPath = options.execPath ?? process.execPath;
  const install = options.install ?? installKind(process.env, execPath);
  if (install !== "service")
    return {
      ok: false,
      reason:
        install === "source"
          ? "this daemon runs from source; update the checkout instead"
          : "this daemon is not run by a service, so nothing would start it again; run `eta-daemon install-service`",
    };
  if (wanted.version === options.version)
    return { ok: false, reason: `already ${wanted.version}` };

  const url = new URL(options.identity.url);
  const source = `${url.origin}${DAEMON_DOWNLOAD_PATH}/${daemonPlatform()}`;
  const response = await (options.fetch ?? fetch)(source, {
    headers: {
      authorization: `Bearer ${options.identity.machineId}.${options.identity.secret}`,
    },
  });
  if (!response.ok)
    return {
      ok: false,
      reason: `the primary has no build for ${daemonPlatform()} (${response.status})`,
    };
  const bytes = new Uint8Array(await response.arrayBuffer());
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== wanted.sha256)
    return {
      ok: false,
      reason: `the build fetched is not the one asked for (sha256 ${digest})`,
    };

  // Beside the executable, so the swap is a rename on one filesystem.
  const staged = `${execPath}.next`;
  const previous = `${execPath}.prev`;
  try {
    await writeFile(staged, bytes, { mode: 0o755 });
    await chmod(staged, 0o755);
    const { stdout } = await run(staged, ["version"], { timeout: 20_000 });
    if (stdout.trim() !== wanted.version)
      throw new Error(
        `the new build says it is ${stdout.trim() || "nothing"}, not ${wanted.version}`,
      );
    await rm(previous, { force: true });
    await rename(execPath, previous);
    try {
      await rename(staged, execPath);
    } catch (error) {
      await rename(previous, execPath);
      throw error;
    }
  } catch (error) {
    await rm(staged, { force: true });
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  const marker: Marker = {
    version: wanted.version,
    from: options.version,
    previous,
    starts: 0,
  };
  await writeFile(markerPath(options.dataDir), JSON.stringify(marker), {
    mode: 0o600,
  });
  return { ok: true };
}

/**
 * At start: a marker left by an upgrade is settled. Returns a function to call once the daemon is
 * let back in; when it is not let in within `settleMs`, `rollBack` is called after the old file is
 * put back (the caller exits for the service manager to start it).
 */
export function settleUpgrade(options: {
  dataDir: string;
  version: string;
  execPath?: string;
  settleMs?: number;
  rollBack: (reason: string) => void;
  warn?: (message: string) => void;
}): { admitted: () => void; dispose: () => void } {
  const none = { admitted: () => undefined, dispose: () => undefined };
  const marker = readMarker(options.dataDir);
  if (marker === undefined) return none;
  const execPath = options.execPath ?? process.execPath;
  const path = markerPath(options.dataDir);
  // Not the build that was swapped in: the old one is back (a roll-back, or a hand). Nothing to
  // settle.
  if (marker.version !== options.version) {
    rmSync(path, { force: true });
    return none;
  }
  const putBack = (reason: string): void => {
    try {
      if (existsSync(marker.previous)) renameSync(marker.previous, execPath);
      rmSync(path, { force: true });
      options.warn?.(
        `[eta-daemon] ${marker.version} ${reason}; went back to ${marker.from}`,
      );
    } catch (error) {
      options.warn?.(
        `[eta-daemon] could not go back to ${marker.from}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }
    options.rollBack(reason);
  };
  if (marker.starts + 1 > MAX_STARTS) {
    putBack(`started ${marker.starts} times without getting back in`);
    return none;
  }
  // Now, not later: a write still in flight would bring the marker back after `admitted` removes it.
  writeFileSync(path, JSON.stringify({ ...marker, starts: marker.starts + 1 }));
  const timer = setTimeout(
    putBack,
    options.settleMs ?? SETTLE_MS,
    "did not get back in",
  );
  return {
    admitted: () => {
      clearTimeout(timer);
      rmSync(path, { force: true });
      rmSync(marker.previous, { force: true });
    },
    dispose: () => clearTimeout(timer),
  };
}
