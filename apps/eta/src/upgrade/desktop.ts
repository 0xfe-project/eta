/**
 * The desktop app as the host's service: the fourth kind beside a systemd unit, a launchd agent and
 * a Windows service.
 *
 * The app runs its host from a file in the user's directory (`~/.eta/desktop/host/eta-host`) and
 * keeps it up as long as it is open. It says so in the host's environment: the address of a
 * loopback port of its own and a token for it (`apps/desktop/src/bun/service.ts`). Through that
 * port the host is what a service manager is to anything else here: something that says whether
 * the host runs and from which file, stops it, starts it again on the same port, and runs a job
 * outside it (`eta-host upgrade --worker`), which outlives the host's stop because it is the app's
 * child, not the host's. With that, `upgrade.ts` replaces a desktop host the way it replaces a
 * service: the same download, check, backup, swap, watch and way back.
 *
 * The address and token are taken out of the environment once, at start (`takeDesktopShell`): what
 * the host runs would have them otherwise. A job the app starts is given them again by the app.
 */
import type { DetachedRunner, ServiceStatus } from "@eta/daemon";
import type { HostService } from "./service";
import process from "node:process";
import { passedValues } from "@eta/daemon";

export const DESKTOP_SERVICE_ENV = "ETA_DESKTOP_SERVICE";
export const DESKTOP_SERVICE_TOKEN_ENV = "ETA_DESKTOP_SERVICE_TOKEN";

/** Stopping waits for the host to close its sessions and database, which may take a while. */
const CALL_TIMEOUT_MS = 60_000;
const UP_TIMEOUT_MS = 3000;

export interface DesktopShell {
  /** `http://127.0.0.1:<port>`, the app's own port for this. */
  url: string;
  token: string;
}

/** What the app says about the host it runs. */
interface DesktopServiceState {
  /** The file it runs. */
  program: string;
  /** The port the host is started on, every time. */
  port: number;
  running: boolean;
  /** It exited without being stopped. */
  crashed: boolean;
  pid: number;
}

let taken: DesktopShell | undefined;

/** Read the app's address once, and take it out of the environment. Undefined outside the app. */
export function takeDesktopShell(
  env: NodeJS.ProcessEnv = process.env,
): DesktopShell | undefined {
  const url = env[DESKTOP_SERVICE_ENV];
  const token = env[DESKTOP_SERVICE_TOKEN_ENV];
  delete env[DESKTOP_SERVICE_ENV];
  delete env[DESKTOP_SERVICE_TOKEN_ENV];
  taken =
    url !== undefined && url !== "" && token !== undefined && token !== ""
      ? { url, token }
      : undefined;
  return taken;
}

async function call(
  shell: DesktopShell,
  path: string,
  body?: unknown,
): Promise<unknown> {
  const response = await fetch(`${shell.url}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      authorization: `Bearer ${shell.token}`,
      "content-type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
  });
  if (!response.ok)
    throw new Error(
      `the desktop app refused ${path}: ${response.status} ${(await response.text()).trim()}`,
    );
  return await response.json();
}

const up = async (port: number): Promise<boolean> => {
  try {
    const answer = await fetch(`http://127.0.0.1:${String(port)}/up`, {
      signal: AbortSignal.timeout(UP_TIMEOUT_MS),
    });
    return answer.status === 200;
  } catch {
    return false;
  }
};

/** The app's host, as `upgrade.ts` sees a service; undefined outside the app. */
export async function desktopService(
  shell: DesktopShell | undefined = taken,
): Promise<HostService | undefined> {
  if (shell === undefined) return undefined;
  const state = (await call(shell, "/service")) as DesktopServiceState;
  const status = async (): Promise<ServiceStatus> => {
    const now = (await call(shell, "/service")) as DesktopServiceState;
    return {
      running: now.running,
      crashed: now.crashed,
      // The app does not start a host that exited by itself: it shows that instead.
      restarting: false,
      pid: now.pid,
    };
  };
  return {
    program: state.program,
    startCommand: "quit the eta app and open it again",
    status,
    stop: async () => {
      await call(shell, "/service/stop", {});
    },
    start: async () => {
      await call(shell, "/service/start", {});
    },
    up: () => up(state.port),
  };
}

/** Jobs as the app's children; undefined outside the app. */
export function desktopRunner(
  shell: DesktopShell | undefined = taken,
): DetachedRunner | undefined {
  if (shell === undefined) return undefined;
  return {
    start: async (job) => {
      await call(shell, "/worker/start", {
        name: job.name,
        argv: job.argv,
        env: passedValues(job.passEnv),
      });
    },
    stop: async (name) => {
      await call(shell, "/worker/stop", { name });
    },
  };
}
