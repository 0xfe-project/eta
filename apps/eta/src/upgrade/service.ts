/**
 * The host as the user's service, seen from outside it: `eta-host upgrade` runs in a shell, not in
 * the service, so it asks the computer's service manager what is installed and what state it is
 * in. `serviceManager` knows the kinds of manager; what is the host's here is asking `/up`.
 *
 * With no service installed the upgrade only replaces the file.
 */
import type {
  DetachedRunner,
  ServiceManager,
  ServiceStatus,
  ServiceUnit,
  WindowsOptions,
} from "@eta/daemon";
import { realpathSync } from "node:fs";
import { get } from "node:http";
import process from "node:process";
import { parseArgs } from "node:util";
import { detachedRunner, serviceManager } from "@eta/daemon";
import { RUN_OPTIONS } from "../cli";
import { Tailscale } from "../machines/tailscale";

/** The host as a user service: one per user, like the daemon. */
export const HOST_UNIT: ServiceUnit = {
  name: "io.eta.host",
  description: "eta host",
  args: [],
};

/** What runs the upgrade, outside the service it restarts. */
export const WORKER_NAME = "io.eta.host-upgrade";

const UP_TIMEOUT_MS = 3000;

export interface HostService {
  /** The file the service runs. */
  readonly program: string;
  /** What a person types to start it. */
  readonly startCommand: string;
  status: () => Promise<ServiceStatus>;
  stop: () => Promise<void>;
  start: () => Promise<void>;
  /** Whether what listens on the service's port says it is up. */
  up: () => Promise<boolean>;
}

const windows: WindowsOptions = {
  worker: { name: WORKER_NAME, description: "eta host upgrade" },
};

export const hostManager = (unit: ServiceUnit = HOST_UNIT): ServiceManager =>
  serviceManager(unit, windows);

export const hostRunner = (): DetachedRunner => detachedRunner(windows);

/** Whether two paths are one file; Windows's names have no case. */
export function sameFile(one: string, other: string): boolean {
  try {
    const [first, second] = [realpathSync(one), realpathSync(other)];
    return process.platform === "win32"
      ? first.toLowerCase() === second.toLowerCase()
      : first === second;
  } catch {
    return false;
  }
}

/** Where to ask a service with these flags: loopback, for a host that listens everywhere. */
export async function upUrl(args: readonly string[]): Promise<string> {
  const { values } = parseArgs({
    args: [...args],
    options: RUN_OPTIONS,
    strict: false,
    allowPositionals: true,
  });
  const port = String(values.port);
  if (port === "0")
    throw new Error(
      "the service listens on any free port, so it cannot be asked",
    );
  let host = String(values.host);
  if (host === "tailscale") {
    const address = await new Tailscale().address();
    if (address === undefined)
      throw new Error("the service listens on Tailscale, which is not up here");
    host = address;
  }
  if (host === "0.0.0.0") host = "127.0.0.1";
  if (host === "::") host = "::1";
  if (host.includes(":")) host = `[${host}]`;
  return `http://${host}:${port}/up`;
}

/**
 * `node:http`, not `fetch`: Bun's `fetch` honours `http_proxy` for anything but loopback, and a
 * proxy cannot reach a tailnet address, which would read as a host that did not come up.
 */
export const askUp = (url: string): Promise<boolean> =>
  new Promise((resolve) => {
    const request = get(url, { timeout: UP_TIMEOUT_MS }, (answer) => {
      answer.resume();
      resolve(answer.statusCode === 200);
    });
    request.on("error", () => resolve(false));
    request.on("timeout", () => {
      request.destroy();
      resolve(false);
    });
  });

/** The installed service, whether it is running or not; undefined when there is none. */
export async function findHostService(): Promise<HostService | undefined> {
  const manager = hostManager();
  const argv = await manager.installed();
  if (argv === undefined) return undefined;
  const [program] = argv;
  if (program === undefined)
    throw new Error(`${manager.name} is registered with no command`);
  const url = await upUrl(argv.slice(1));
  return {
    program,
    startCommand: manager.startCommand,
    status: manager.status,
    stop: manager.stop,
    start: manager.start,
    up: () => askUp(url),
  };
}
