/**
 * The process that restarts the service, which cannot be the one that asked.
 *
 * Both ways in live under something the restart kills or can kill: the host itself for the page's
 * button, and for `eta-host upgrade` a shell that may be an agent under the host, or a terminal
 * that goes away. So neither does the work: it hands it to a transient user unit of its own
 * (`io.eta.host-upgrade`), a sibling of the service in systemd and not its child. Stopping the
 * service kills every process in the service's cgroup, and this one is not there.
 *
 * What asked then only reads `upgrade-status.json`. The unit runs `eta-host upgrade --worker <id>`
 * from the file about to be replaced, which is fine: the process keeps the file it started from.
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { abandonUpgrade, announceUpgrade, readStatus } from "./status";

const exec = promisify(execFile);

const WORKER_UNIT = "io.eta.host-upgrade";
const FOLLOW_MS = 300;

/** What the worker needs from the environment of whoever started it. A user unit starts bare. */
const PASSED_ENV = [
  "PATH",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
  "GH_CONFIG_DIR",
  "XDG_CONFIG_HOME",
  "ETA_RELEASES_URL",
  "ETA_RELEASES_TOKEN",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
] as const;

/** Before these end the service has not been touched, so stopping the worker changes nothing. */
const CANCELLABLE = new Set(["starting", "downloading", "waiting"]);

export interface WorkerRequest {
  dataDir: string;
  /** The file to run: the one the service runs. */
  program: string;
  /** The build that file is. */
  from: string;
  wanted?: string | undefined;
  /** `--repo`, for this upgrade alone. */
  repo?: string | undefined;
  force: boolean;
  waitMinutes: number;
  run?: typeof exec;
}

/** Start the worker, or find the one running; its id. */
export async function startWorker(request: WorkerRequest): Promise<string> {
  const { dataDir, force, from, program, repo, waitMinutes, wanted } = request;
  const running = readStatus(dataDir);
  if (running?.state === "running") return running.id;
  const id = randomUUID();
  announceUpgrade(dataDir, id, from);
  // A name alone takes the value from this process, so a token is not on any command line. A stop
  // goes to the worker alone, not to the `systemctl` it may be waiting for, and waits as long as it
  // takes: past the point of no return the worker ignores it, and a kill there would leave the
  // service down with nobody watching.
  const started = (request.run ?? exec)("systemd-run", [
    "--user",
    `--unit=${WORKER_UNIT}`,
    "--collect",
    "--quiet",
    "--property=KillMode=mixed",
    "--property=TimeoutStopSec=infinity",
    ...PASSED_ENV.filter((name) => process.env[name] !== undefined).map(
      (name) => `--setenv=${name}`,
    ),
    "--",
    program,
    "upgrade",
    ...(wanted === undefined ? [] : [wanted]),
    ...(repo === undefined ? [] : ["--repo", repo]),
    ...(force ? ["--force"] : []),
    "--wait",
    String(waitMinutes),
    "--worker",
    id,
  ]);
  try {
    await started;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    abandonUpgrade(dataDir, id, message);
    throw error;
  }
  return id;
}

/** Stop a worker that has not touched the service yet; false when it is too late, or nothing runs. */
export async function cancelWorker(
  dataDir: string,
  run: typeof exec = exec,
): Promise<boolean> {
  const status = readStatus(dataDir);
  if (status?.state !== "running" || !CANCELLABLE.has(status.phase))
    return false;
  await run("systemctl", ["--user", "stop", "--no-block", WORKER_UNIT]);
  return true;
}

/** Print what a worker says as it says it, until it ends; the exit code it comes to. */
export async function followWorker(
  dataDir: string,
  id: string,
  log: (line: string) => void,
  fail: (line: string) => void,
  pollMs: number = FOLLOW_MS,
): Promise<number> {
  let shown = 0;
  for (;;) {
    const status = readStatus(dataDir);
    if (status?.id !== id) {
      fail("the upgrade's status is gone");
      return 1;
    }
    for (const line of status.log.slice(shown)) log(line);
    shown = status.log.length;
    if (status.state === "done") return 0;
    if (status.state !== "running") {
      fail(status.error ?? `the upgrade ended: ${status.state}`);
      return 1;
    }
    await sleep(pollMs);
  }
}
