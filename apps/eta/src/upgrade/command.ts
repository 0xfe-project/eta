/* eslint-disable no-console -- a command line */
/** `eta-host upgrade`: its flags, what `--help` says, and an exit code. */
import type { UpgradeOptions } from "./upgrade";
import { homedir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import {
  BUILT_UPSTREAM,
  chooseUpstream,
  parseUpstream,
  Releases,
  upstreamLabel,
} from "@eta/releases";
import { parseFailure } from "../cli";
import { COMPILED } from "../resources";
import { listenForStop } from "../stop";
import { VERSION } from "../version";
import {
  BACKUPS_KEPT,
  savedPrerelease,
  savedToken,
  savedUpstream,
} from "./database";
import { findHostService, sameFile } from "./service";
import { readStatus, StatusWriter } from "./status";
import { isReleaseVersion, UpgradeFailure, upgradeHost } from "./upgrade";
import { cancelWorker, followWorker, startWorker } from "./worker";

const WAIT_MINUTES = 10;

const USAGE = `Usage: eta-host upgrade [version] [--repo <repository>] [--prerelease] [--check] [--force] [--wait <minutes>]
       eta-host upgrade --status | --cancel

Replace this file with a release: the one named (0.2.0, 0.2.0-rc.1), or else the latest full
release, pre-releases included when they are on under Settings, Update, or with --prerelease. A
pre-release build waits for a newer full release rather than going back to an older one. The
download is checked against SHA256SUMS and run once before anything changes, and a release older
than this build is refused.

If the service (io.eta.host) runs this file, the work is handed to a process of its own,
io.eta.host-upgrade, which the service manager runs (a systemd user unit, a launchd job, a Windows
service; the desktop app is the manager of the host it runs), and this command only follows it: closing the terminal, or killing this command or the
host, does not stop it. That process waits for working agents, stops the service,
backs up the database, swaps the file, starts it, and checks /up and the migrations. If that fails,
the old build and the database go back and the service is started again.
Otherwise only the file is replaced and restarting is up to you.

  --check             say whether there is something newer and change nothing
  --prerelease        count pre-releases (v0.3.0-rc.1) as the latest too, this once
  --force             do not wait for agents: the restart stops the ones running. An agent running
                      this counts as one of them
  --wait <minutes>    how long to wait for them, default ${WAIT_MINUTES}; then give up, changing nothing
  --repo <repository> take the release from there, this once: owner/name or a whole address
  --status            say how the last upgrade went, or where the running one is
  --cancel            stop a running upgrade, if it has not stopped the service yet

Database backups: ~/.eta/backups/upgrade-<time>-<old version>.sqlite, the newest ${BACKUPS_KEPT} are kept.
The old build stays beside this file as <file>.prev.

Where a release comes from decides whose code this host runs. The first of these that is given:

  1. --repo
  2. ETA_RELEASES_URL
  3. what was saved under Settings, Update
  4. what this build follows: ${upstreamLabel(BUILT_UPSTREAM)}. A release built by a fork follows that fork.

Each is owner/name, https://github.com/<owner>/<name>, a GitHub Enterprise API address such as
https://<host>/api/v3/repos/<owner>/<name>, or the address of another server with the same API.

A private repository needs a token. The first that is given, found again each time:
  GitHub                GH_TOKEN, GITHUB_TOKEN, one saved under Settings, Update, then
                        \`gh auth token --hostname github.com\`
  GitHub Enterprise     GH_ENTERPRISE_TOKEN, then the same, with --hostname <host>
  any other server      ETA_RELEASES_TOKEN, and none of the above

A saved token is the only one eta keeps. It is sealed under this host's key, and goes only to the
host it was saved for.

A service may not reach the keychain gh keeps its login in: then save a token under Settings, use
\`gh auth login --insecure-storage\`, or set GH_TOKEN in its environment.
`;

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDownloadProgress(
  received: number,
  total: number | undefined,
): string {
  if (total !== undefined && total > 0) {
    const percent = Math.min(100, Math.round((received / total) * 100));
    return `${percent}% (${formatBytes(received)} / ${formatBytes(total)})`;
  }
  return formatBytes(received);
}

/** Inline TTY progress line that clears cleanly before any subsequent log line. */
function createTerminalProgress(): {
  update: (received: number, total: number | undefined) => void;
  clear: () => void;
} {
  let shownWidth = 0;
  const clear = () => {
    if (shownWidth === 0 || !process.stdout.isTTY) return;
    process.stdout.write(`\r${" ".repeat(shownWidth)}\r`);
    shownWidth = 0;
  };
  const update = (received: number, total: number | undefined) => {
    if (!process.stdout.isTTY) return;
    const text = `Downloading: ${formatDownloadProgress(received, total)}`;
    const pad =
      shownWidth > text.length ? " ".repeat(shownWidth - text.length) : "";
    process.stdout.write(`\r${text}${pad}`);
    shownWidth = text.length;
  };
  return { update, clear };
}

function fail(what: string): number {
  console.error(`eta-host upgrade: ${what}\n\n${USAGE}`);
  return 2;
}

/** A service runs: the worker does it, and this only reads along until it ends or is closed. */
async function handOver(
  options: UpgradeOptions,
  waitMinutes: number,
  repo: string | undefined,
  prerelease: boolean,
): Promise<number> {
  const { dataDir, execPath, force, version, wanted } = options;
  const id = await startWorker({
    dataDir,
    program: execPath,
    from: version,
    wanted,
    repo,
    prerelease,
    force,
    waitMinutes,
  });
  const progress = createTerminalProgress();
  process.on("SIGINT", () => {
    progress.clear();
    console.log(
      "\nThe upgrade goes on without this. `eta-host upgrade --status` shows it, `--cancel` stops it if it has not stopped the service yet.",
    );
    process.exit(0);
  });
  return await followWorker(
    dataDir,
    id,
    (line) => {
      progress.clear();
      options.log(line);
    },
    (line) => {
      progress.clear();
      console.error(`eta-host upgrade: ${line}`);
    },
    undefined,
    (download) => {
      if (download === undefined) progress.clear();
      else progress.update(download.received, download.total);
    },
  );
}

/** The worker itself, in its own unit: everything it does goes to the status file. */
async function work(options: UpgradeOptions, id: string): Promise<number> {
  listenForStop();
  const writer = new StatusWriter(options.dataDir, id, options.version);
  try {
    await upgradeHost({
      ...options,
      log: (line) => {
        options.log(line);
        writer.log(line);
      },
      report: {
        target: (version) => writer.target(version),
        phase: (phase, busy) => writer.phase(phase, busy),
        progress: (received, total) => writer.progress(received, total),
        cancelled: () => writer.finish("cancelled"),
      },
    });
    writer.finish("done");
    return 0;
  } catch (error) {
    const state = error instanceof UpgradeFailure ? error.state : "failed";
    writer.finish(state, errorText(error));
    return 1;
  }
}

function showStatus(dataDir: string): number {
  const status = readStatus(dataDir);
  if (status === undefined) {
    console.log("No upgrade has run here.");
    return 0;
  }
  const to = status.to === undefined ? "" : ` to ${status.to}`;
  const detail =
    status.state === "running" &&
    status.phase === "downloading" &&
    status.download !== undefined
      ? ` (${formatDownloadProgress(status.download.received, status.download.total)})`
      : "";
  console.log(
    status.state === "running"
      ? `Upgrading from ${status.from}${to}: ${status.phase}${detail}.`
      : `The upgrade from ${status.from}${to} ended: ${status.state}.`,
  );
  if (status.error !== undefined) console.log(status.error);
  return 0;
}

/**
 * Where releases come from and which ones count, read from `dataDir` by this command and by its
 * worker alike. The worker started from the page's button is given no version and no
 * `--prerelease`: it reads the switch here, so its target is the one `check()` showed the page.
 */
export function releaseSource(
  dataDir: string,
  flags: { repo?: string | undefined; prerelease?: boolean | undefined } = {},
): Pick<UpgradeOptions, "releases" | "upstream" | "prerelease"> {
  const chosen = chooseUpstream({
    flag: flags.repo,
    saved: savedUpstream(dataDir),
  });
  const releases = new Releases({
    upstream: chosen.text,
    saved: savedToken(dataDir),
  });
  return {
    releases,
    upstream: chosen.source === "build" ? undefined : releases.upstream.label,
    prerelease: flags.prerelease === true || savedPrerelease(dataDir),
  };
}

export async function upgradeCommand(args: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      options: {
        check: { type: "boolean", default: false },
        force: { type: "boolean", default: false },
        wait: { type: "string", default: String(WAIT_MINUTES) },
        repo: { type: "string" },
        prerelease: { type: "boolean", default: false },
        status: { type: "boolean", default: false },
        cancel: { type: "boolean", default: false },
        // What `worker.ts` runs. Not in the usage.
        worker: { type: "string" },
        target: { type: "string" },
        help: { type: "boolean", short: "h", default: false },
      },
      allowPositionals: true,
      strict: true,
    });
  } catch (error) {
    return fail(parseFailure(error));
  }
  const { positionals, values } = parsed;
  if (values.help === true) {
    console.log(USAGE);
    return 0;
  }
  if (positionals.length > 1) return fail("one version at a time");
  const wanted = positionals[0]?.replace(/^v/, "");
  if (wanted !== undefined && !isReleaseVersion(wanted))
    return fail(`not a version: ${positionals[0]}`);
  const minutes = Number(values.wait);
  if (!Number.isFinite(minutes) || minutes < 0)
    return fail(`--wait: not a number of minutes: ${values.wait}`);
  if (values.repo !== undefined) {
    try {
      parseUpstream(values.repo);
    } catch (error) {
      return fail(`--repo: ${errorText(error)}`);
    }
  }
  const dataDir = join(homedir(), ".eta");
  if (values.status === true) return showStatus(dataDir);
  if (values.cancel === true) {
    const cancelled = await cancelWorker(dataDir);
    console.log(
      cancelled
        ? "Stopping the upgrade."
        : "Nothing to stop: no upgrade is running, or it has already stopped the service.",
    );
    return cancelled ? 0 : 1;
  }
  if (!COMPILED && values.check !== true) {
    console.error(
      "eta-host upgrade: this host runs from source; update the checkout instead",
    );
    return 1;
  }

  try {
    const options = {
      ...releaseSource(dataDir, {
        repo: values.repo,
        prerelease: values.prerelease,
      }),
      wanted,
      check: values.check === true,
      force: values.force === true,
      waitMs: minutes * 60_000,
      version: VERSION,
      execPath: values.target ?? process.execPath,
      dataDir,
      findService: findHostService,
      log: (line: string) => console.log(line),
    };

    if (values.worker !== undefined) return await work(options, values.worker);
    if (!options.check) {
      const service = await findHostService();
      const status = await service?.status();
      if (
        service !== undefined &&
        (status?.running === true || status?.restarting === true)
      ) {
        if (!sameFile(service.program, process.execPath))
          throw new Error(
            `the service runs ${service.program}, not this file. Run that one's upgrade.`,
          );
        return await handOver(
          options,
          minutes,
          values.repo,
          values.prerelease === true,
        );
      }
    }
    const progress = createTerminalProgress();
    try {
      await upgradeHost({
        ...options,
        log: (line) => {
          progress.clear();
          options.log(line);
        },
        report: {
          target: () => undefined,
          phase: (phase) => {
            if (phase !== "downloading") progress.clear();
          },
          progress: (received, total) => progress.update(received, total),
          cancelled: () => progress.clear(),
        },
      });
    } finally {
      progress.clear();
    }
    return 0;
  } catch (error) {
    console.error(`eta-host upgrade: ${errorText(error)}`);
    return 1;
  }
}
