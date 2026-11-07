/**
 * The process that restarts the service, which cannot be the one that asked.
 *
 * Both ways in live under something the restart kills or can kill: the host itself for the page's
 * button, and for `eta-host upgrade` a shell that may be an agent under the host, or a terminal
 * that goes away. So neither does the work: it hands it to the service manager, as a run of its
 * own named `io.eta.host-upgrade` (`DetachedRunner`), and stopping the service does not reach that.
 *
 * What asked then only reads `upgrade-status.json`. The run is `eta-host upgrade --worker <id>`
 * from the file about to be replaced, which is fine: the process keeps the file it started from.
 * On Windows it is a copy of the file: `--target` is always what is replaced.
 */
import type { DetachedRunner } from "@eta/daemon";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { hostRunner, WORKER_NAME } from "./service";
import { abandonUpgrade, announceUpgrade, readStatus } from "./status";

const FOLLOW_MS = 300;

/** What the worker needs from the environment of whoever started it. A service starts bare. */
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
  runner?: DetachedRunner;
}

/** Start the worker, or find the one running; its id. */
export async function startWorker(request: WorkerRequest): Promise<string> {
  const { dataDir, force, from, program, repo, waitMinutes, wanted } = request;
  const running = readStatus(dataDir);
  if (running?.state === "running") return running.id;
  const id = randomUUID();
  announceUpgrade(dataDir, id, from);
  try {
    await (request.runner ?? hostRunner()).start({
      name: WORKER_NAME,
      argv: [
        program,
        "upgrade",
        ...(wanted === undefined ? [] : [wanted]),
        ...(repo === undefined ? [] : ["--repo", repo]),
        ...(force ? ["--force"] : []),
        "--wait",
        String(waitMinutes),
        "--worker",
        id,
        "--target",
        program,
      ],
      passEnv: PASSED_ENV,
    });
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
  runner: DetachedRunner = hostRunner(),
): Promise<boolean> {
  const status = readStatus(dataDir);
  if (status?.state !== "running" || !CANCELLABLE.has(status.phase))
    return false;
  await runner.stop(WORKER_NAME);
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
