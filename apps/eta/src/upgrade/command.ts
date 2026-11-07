/* eslint-disable no-console -- a command line */
/** `eta-host upgrade`: its flags, what `--help` says, and an exit code. */
import type { UpgradeOptions } from "./upgrade";
import { homedir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import { parseFailure } from "../cli";
import { COMPILED } from "../resources";
import { listenForStop } from "../stop";
import { VERSION } from "../version";
import { BACKUPS_KEPT, savedToken, savedUpstream } from "./database";
import { Releases } from "./releases";
import { findHostService, sameFile } from "./service";
import { readStatus, StatusWriter } from "./status";
import { isReleaseVersion, UpgradeFailure, upgradeHost } from "./upgrade";
import {
  BUILT_UPSTREAM,
  chooseUpstream,
  parseUpstream,
  upstreamLabel,
} from "./upstream";
import { cancelWorker, followWorker, startWorker } from "./worker";

const WAIT_MINUTES = 10;

const USAGE = `Usage: eta-host upgrade [version] [--repo <repository>] [--check] [--force] [--wait <minutes>]
       eta-host upgrade --status | --cancel

Replace this file with a release, the latest full one unless given a version; a pre-release has to
be named (0.2.0-rc.1). The download is checked against SHA256SUMS and run once before anything
changes, and a release older than this build is refused.

If the service (io.eta.host) runs this file, the work is handed to a process of its own,
io.eta.host-upgrade, which the service manager runs (a systemd user unit, a launchd job, a Windows
service; the desktop app is the manager of the host it runs), and this command only follows it: closing the terminal, or killing this command or the
host, does not stop it. That process waits for working agents, stops the service,
backs up the database, swaps the file, starts it, and checks /up and the migrations. If that fails,
the old build and the database go back and the service is started again.
Otherwise only the file is replaced and restarting is up to you.

  --check             say whether there is something newer and change nothing
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

function fail(what: string): number {
  console.error(`eta-host upgrade: ${what}\n\n${USAGE}`);
  return 2;
}

/** A service runs: the worker does it, and this only reads along until it ends or is closed. */
async function handOver(
  options: UpgradeOptions,
  waitMinutes: number,
  repo: string | undefined,
): Promise<number> {
  const { dataDir, execPath, force, version, wanted } = options;
  const id = await startWorker({
    dataDir,
    program: execPath,
    from: version,
    wanted,
    repo,
    force,
    waitMinutes,
  });
  process.on("SIGINT", () => {
    console.log(
      "\nThe upgrade goes on without this. `eta-host upgrade --status` shows it, `--cancel` stops it if it has not stopped the service yet.",
    );
    process.exit(0);
  });
  return await followWorker(dataDir, id, options.log, (line) =>
    console.error(`eta-host upgrade: ${line}`),
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
  console.log(
    status.state === "running"
      ? `Upgrading from ${status.from}${to}: ${status.phase}.`
      : `The upgrade from ${status.from}${to} ended: ${status.state}.`,
  );
  if (status.error !== undefined) console.log(status.error);
  return 0;
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
    const chosen = chooseUpstream({
      flag: values.repo,
      saved: savedUpstream(dataDir),
    });
    const releases = new Releases({
      upstream: chosen.text,
      saved: savedToken(dataDir),
    });
    const options = {
      wanted,
      check: values.check === true,
      force: values.force === true,
      waitMs: minutes * 60_000,
      version: VERSION,
      execPath: values.target ?? process.execPath,
      dataDir,
      releases,
      upstream: chosen.source === "build" ? undefined : releases.upstream.label,
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
        return await handOver(options, minutes, values.repo);
      }
    }
    await upgradeHost(options);
    return 0;
  } catch (error) {
    console.error(`eta-host upgrade: ${errorText(error)}`);
    return 1;
  }
}
