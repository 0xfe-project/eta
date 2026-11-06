import type { Release, Releases } from "./releases";
/**
 * The host replacing its own file with a release, and the service that runs it.
 *
 * Everything that can fail without anyone noticing happens first, while the old host keeps
 * serving: the release is found, downloaded beside the executable, checked against `SHA256SUMS`,
 * run once (`--version`, `--migrations`), and its migrations are held against the database, which
 * may be ahead of a release if this host was built from a checkout. Failing here leaves everything
 * as it was.
 *
 * Then, for a running service: wait for the agents (a restart stops the ones under the host), stop
 * it, back up the database, swap the file, start it, and watch it: `/up` has to answer and go on
 * answering from one process, and every migration of the new build has to be in the database. If
 * it does not hold, the old file and the database go back and the old build is started. The backup
 * comes after the stop so going back loses nothing, and everything between the stop and the end
 * ignores signals, because leaving there means a service left on a build nobody has looked at.
 *
 * With no service running there is nothing to restart or watch: the file is replaced after a
 * backup, and the next start is the user's.
 */
import type { HostService } from "./service";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";
import {
  daemonPlatform,
  previousPath,
  stagedPath,
  swapBack,
  swapIn,
  tryBuild,
} from "@eta/daemon";
import {
  appliedMigrations,
  backupDatabase,
  busyAgents,
  restoreDatabase,
} from "./database";
import { parseSums } from "./releases";

const SUMS_FILE = "SHA256SUMS";
const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

/** The newest release that cannot say which migrations it carries. */
const LAST_WITHOUT_MIGRATIONS = "0.1.0";

/** `0.2.0` or `0.2.0-rc.1`, what a tag can be (`release.yml`). */
const RELEASE_VERSION = /^\d+\.\d+\.\d+(?:-[0-9a-z.-]+)?$/i;

export const isReleaseVersion = (version: string): boolean =>
  RELEASE_VERSION.test(version);

interface UpgradeTiming {
  /** Between looks at the service, and at the agents. */
  pollMs: number;
  /** How long a started build has to answer `/up`. */
  upMs: number;
  /** How long it then has to go on answering, from one process. */
  holdMs: number;
}

const TIMING: UpgradeTiming = { pollMs: 1000, upMs: 120_000, holdMs: 5000 };

export interface UpgradeOptions {
  /** The version asked for, without a `v`; the latest full release if not. */
  wanted: string | undefined;
  /** Say whether there is something newer and stop there. */
  check: boolean;
  /** Restart over working agents instead of waiting. */
  force: boolean;
  /** How long to wait for them. */
  waitMs: number;
  /** This build. */
  version: string;
  execPath: string;
  dataDir: string;
  releases: Releases;
  findService: () => Promise<HostService | undefined>;
  log: (line: string) => void;
  timing?: Partial<UpgradeTiming>;
}

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** One upgrade at a time on a data directory; a lock whose owner is gone is taken over. */
function takeLock(dataDir: string): () => void {
  mkdirSync(dataDir, { recursive: true });
  const path = join(dataDir, "upgrade.lock");
  for (let tries = 0; ; tries += 1) {
    try {
      const file = openSync(path, "wx", 0o600);
      writeSync(file, String(process.pid));
      closeSync(file);
      return () => rmSync(path, { force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || tries > 0)
        throw error;
    }
    const holder = Number(readFileSync(path, "utf8"));
    if (alive(holder))
      throw new Error(`another upgrade is running (pid ${holder})`);
    rmSync(path, { force: true });
  }
}

/** `handle` takes the signals until the returned function is called. */
function onSignals(handle: () => void): () => void {
  for (const signal of SIGNALS) process.on(signal, handle);
  return () => {
    for (const signal of SIGNALS) process.off(signal, handle);
  };
}

async function waitForAgents(
  options: UpgradeOptions,
  pollMs: number,
): Promise<void> {
  const { dataDir, log, waitMs } = options;
  const deadline = Date.now() + waitMs;
  let said = "";
  for (;;) {
    const busy = busyAgents(dataDir);
    if (busy.length === 0) return;
    const list = busy.join("; ");
    if (Date.now() >= deadline)
      throw new Error(
        `still working, and a restart would stop them: ${list}. Nothing has changed: run it again later, or with --force to stop them.`,
      );
    if (list !== said) {
      log(`Waiting for what a restart would stop: ${list}.`);
      said = list;
    }
    await sleep(pollMs);
  }
}

/** Throws unless the service has come up, stays up, and its database is what `migrations` says. */
async function watch(
  service: HostService,
  migrations: readonly string[] | undefined,
  dataDir: string,
  { pollMs, upMs, holdMs }: UpgradeTiming,
): Promise<void> {
  const deadline = Date.now() + upMs;
  let pid: number;
  for (;;) {
    const status = await service.status();
    if (status.crashed) throw new Error("it exited");
    if (status.running && (await service.up())) {
      ({ pid } = status);
      break;
    }
    if (Date.now() >= deadline)
      throw new Error(`/up did not answer in ${upMs / 1000}s`);
    await sleep(pollMs);
  }
  for (const until = Date.now() + holdMs; Date.now() < until; ) {
    await sleep(pollMs);
    const status = await service.status();
    if (!status.running || status.pid !== pid)
      throw new Error("it exited after coming up");
    if (!(await service.up())) throw new Error("/up stopped answering");
  }
  const applied = new Set(appliedMigrations(dataDir));
  const missing = migrations?.filter((id) => !applied.has(id)) ?? [];
  if (missing.length > 0)
    throw new Error(`migrations did not run: ${missing.join(", ")}`);
}

/** The service on the staged build, or on the old one again and an error that says what happened. */
async function replaceService(
  options: UpgradeOptions,
  service: HostService,
  version: string,
  migrations: readonly string[] | undefined,
  timing: UpgradeTiming,
): Promise<void> {
  const { dataDir, execPath, log } = options;
  const from = options.version;

  let backup: string | undefined;
  try {
    log("Stopping the service.");
    await service.stop();
    backup = backupDatabase(dataDir, from);
    if (backup !== undefined) log(`Database backed up to ${backup}.`);
    await swapIn(execPath);
  } catch (error) {
    log(`Starting ${from} again.`);
    await service.start();
    throw error;
  }

  try {
    log(`Starting ${version}.`);
    await service.start();
    await watch(service, migrations, dataDir, timing);
  } catch (error) {
    const why = message(error);
    log(`${version} did not hold: ${why}. Going back to ${from}.`);
    const restored = backup === undefined ? "" : `, database restored`;
    try {
      await service.stop();
      await swapBack(execPath);
      if (backup !== undefined) restoreDatabase(dataDir, backup);
      await service.start();
      await watch(service, undefined, dataDir, timing);
    } catch (again) {
      throw new Error(
        `${version} did not hold (${why}), and going back failed too: ${message(again)}. The old build is ${execPath} or ${previousPath(execPath)}; the database backup is ${backup ?? "not there"}. The service needs a hand.`,
      );
    }
    throw new Error(
      `${version} did not hold (${why}). The service is back on ${from}${restored}.`,
    );
  }
}

/** What the staged build carries; undefined for one too old to say, if that is safe. */
async function listMigrations(
  options: UpgradeOptions,
  version: string,
): Promise<string[] | undefined> {
  try {
    const listed = await tryBuild(stagedPath(options.execPath), [
      "--migrations",
    ]);
    return listed.split("\n").filter((line) => line !== "");
  } catch (error) {
    if (Bun.semver.order(version, LAST_WITHOUT_MIGRATIONS) > 0)
      throw new Error(`the new build did not run: ${message(error)}`);
  }
  // Releases come in order, so a newer one carries what an older one ran. A checkout's build may
  // have run anything, and nothing here would notice a database ahead of this file.
  if (!isReleaseVersion(options.version))
    throw new Error(
      `${version} cannot say which migrations it carries, and this build (${options.version}) is not a release, so the database may be ahead of it.`,
    );
  options.log(
    `${version} does not list its migrations: /up is the only check.`,
  );
  return undefined;
}

/** Download, check and try the release's file, as `<exe>.next`. */
async function stage(
  options: UpgradeOptions,
  release: Release,
): Promise<string[] | undefined> {
  const { execPath, log, releases, dataDir } = options;
  const name = `eta-host-${daemonPlatform()}`;
  const asset = release.assets.find((file) => file.name === name);
  if (asset === undefined)
    throw new Error(`${release.version} has no build for ${daemonPlatform()}`);
  const sumsAsset = release.assets.find((file) => file.name === SUMS_FILE);
  if (sumsAsset === undefined)
    throw new Error(`${release.version} has no ${SUMS_FILE}`);

  const sums = parseSums(await releases.text(sumsAsset));
  const expected = sums.get(name);
  if (expected === undefined)
    throw new Error(`${SUMS_FILE} of ${release.version} does not name ${name}`);

  const staged = stagedPath(execPath);
  log(`Downloading ${name} ${release.version}.`);
  const digest = await releases.download(asset, staged);
  if (digest !== expected)
    throw new Error(
      `the checksum of ${name} is ${digest}, not the ${expected} of ${SUMS_FILE}`,
    );

  let says: string;
  try {
    says = await tryBuild(staged, ["--version"]);
  } catch (error) {
    throw new Error(`the new build did not run: ${message(error)}`);
  }
  if (/^eta-host (\S+)/.exec(says)?.[1] !== release.version)
    throw new Error(
      `the new build says "${says || "nothing"}", not ${release.version}`,
    );

  const carried = await listMigrations(options, release.version);
  if (carried === undefined) return undefined;
  const known = new Set(carried);
  const ahead = appliedMigrations(dataDir).filter((id) => !known.has(id));
  if (ahead.length > 0)
    throw new Error(
      `the database has migrations ${release.version} does not carry: ${ahead.join(", ")}. It is ahead of that build.`,
    );
  return carried;
}

export async function upgradeHost(options: UpgradeOptions): Promise<void> {
  const { check, dataDir, execPath, findService, log, releases, wanted } =
    options;
  const from = options.version;
  const timing = { ...TIMING, ...options.timing };

  const release =
    wanted === undefined
      ? await releases.latest()
      : await releases.byVersion(wanted);
  const { version } = release;
  // Builds outside a release (a checkout's, named after a commit) have no order.
  const order = isReleaseVersion(from)
    ? Bun.semver.order(version, from)
    : undefined;

  if (version === from) {
    log(`eta-host ${from} is up to date.`);
    return;
  }
  if (check) {
    log(
      order === undefined
        ? `This build is ${from}, not a release; the release is ${version}.`
        : order > 0
          ? `${version} is available; this is ${from}.`
          : `This is ${from}, newer than ${version}.`,
    );
    return;
  }
  if (order !== undefined && order < 0)
    throw new Error(
      `${version} is older than this build (${from}), and migrations do not go back. The build this one replaced is ${previousPath(execPath)}, with the database backups in ${join(dataDir, "backups")}.`,
    );

  const service = await findService();
  const status = await service?.status();
  // Between two starts is running: what is swapped in now would start with nobody watching.
  const running =
    service !== undefined &&
    (status?.running === true || status?.restarting === true);
  if (running && service.inside)
    throw new Error(
      `this process runs inside the service, and the restart would stop the upgrade halfway. Run it from outside; an agent under the host can get out with \`systemd-run --user --scope ${execPath} upgrade --force\`, which stops that agent too.`,
    );
  if (running && realpathSync(service.program) !== realpathSync(execPath))
    throw new Error(
      `the service runs ${service.program}, not this file. Run that one's upgrade.`,
    );

  const unlock = takeLock(dataDir);
  const staged = stagedPath(execPath);
  // Giving up is free until the service is stopped; nothing is left behind.
  let freeSignals = onSignals(() => {
    rmSync(staged, { force: true });
    unlock();
    process.exit(130);
  });
  try {
    const migrations = await stage(options, release);
    if (running) {
      if (options.force) log("--force: not waiting for agents.");
      else await waitForAgents(options, timing.pollMs);
      freeSignals();
      freeSignals = onSignals(() => {
        log("Not stopping here: the service is between two builds.");
      });
      await replaceService(options, service, version, migrations, timing);
      log(`The service runs ${version}. Daemons follow when they reconnect.`);
    } else {
      const backup = backupDatabase(dataDir, from);
      if (backup !== undefined) log(`Database backed up to ${backup}.`);
      await swapIn(execPath);
      log(
        service === undefined
          ? `${execPath} is now ${version}. No service runs it: restart the host yourself.`
          : `${execPath} is now ${version}. The service is stopped: \`systemctl --user start io.eta.host\`.`,
      );
    }
    log(`The old build is ${previousPath(execPath)}.`);
  } finally {
    freeSignals();
    rmSync(staged, { force: true });
    unlock();
  }
}
