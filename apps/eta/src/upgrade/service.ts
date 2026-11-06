/**
 * The host as the user's service, seen from the outside: `eta-host upgrade` runs in a shell, not in
 * the service, so it asks systemd what is installed and what state it is in.
 *
 * Only systemd: the one platform there is a release for. On any other, or with no unit installed,
 * there is no service and the upgrade only replaces the file.
 */
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { get } from "node:http";
import { homedir } from "node:os";
import process from "node:process";
import { parseArgs, promisify } from "node:util";
import { serviceArgv, serviceDefinition } from "@eta/daemon";
import { RUN_OPTIONS } from "../cli";
import { Tailscale } from "../machines/tailscale";

const run = promisify(execFile);

/** The host as a user service: one per user, like the daemon. */
export const HOST_UNIT = {
  name: "io.eta.host",
  description: "eta host",
  args: [],
};
const UNIT_FILE = `${HOST_UNIT.name}.service`;

/** A stop can take as long as systemd gives the host before it kills it. */
const SYSTEMCTL_TIMEOUT_MS = 120_000;
const UP_TIMEOUT_MS = 3000;

interface ServiceStatus {
  /** Started and not exited. */
  running: boolean;
  /** It exited on its own: waiting to be started again, or given up on. */
  crashed: boolean;
  /** Down for now: systemd will start it again, from whatever file is there then. */
  restarting: boolean;
  pid: number;
}

export interface HostService {
  /** The file the service runs. */
  readonly program: string;
  /** Whether this process runs inside the service, and goes down with it. */
  readonly inside: boolean;
  status: () => Promise<ServiceStatus>;
  stop: () => Promise<void>;
  start: () => Promise<void>;
  /** Whether what listens on the service's port says it is up. */
  up: () => Promise<boolean>;
}

const systemctl = async (...args: string[]): Promise<string> =>
  (
    await run("systemctl", ["--user", ...args], {
      timeout: SYSTEMCTL_TIMEOUT_MS,
    })
  ).stdout;

async function show(): Promise<Record<string, string>> {
  const properties = [
    "LoadState",
    "ActiveState",
    "SubState",
    "MainPID",
    "FragmentPath",
  ];
  const stdout = await systemctl(
    "show",
    UNIT_FILE,
    ...properties.flatMap((property) => ["-p", property]),
  );
  return Object.fromEntries(
    stdout
      .split("\n")
      .filter((line) => line.includes("="))
      .map((line) => {
        const at = line.indexOf("=");
        return [line.slice(0, at), line.slice(at + 1)];
      }),
  );
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

/** systemd writes the unit as `_io.eta.host.service` here: `io` is the name of a controller. */
export const inServiceCgroup = (cgroup: string): boolean =>
  cgroup.includes(UNIT_FILE);

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

function insideService(): boolean {
  try {
    return inServiceCgroup(readFileSync("/proc/self/cgroup", "utf8"));
  } catch {
    return false;
  }
}

/** The installed service, whether it is running or not; undefined when there is none. */
export async function findHostService(): Promise<HostService | undefined> {
  if (process.platform !== "linux") return undefined;
  const { path } = serviceDefinition(
    { program: "", args: [] },
    "linux",
    homedir(),
    HOST_UNIT,
  );
  let facts: Record<string, string>;
  try {
    facts = await show();
  } catch (error) {
    // No systemd here is no service. A unit nobody can be asked about is another matter: going on
    // would leave a running host on the old file and say nothing.
    if (!existsSync(path)) return undefined;
    throw new Error(
      `${path} is installed, but systemd does not answer: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (facts.LoadState !== "loaded") return undefined;
  const argv = serviceArgv(readFileSync(facts.FragmentPath ?? path, "utf8"));
  const [program] = argv ?? [];
  if (program === undefined)
    throw new Error(`no ExecStart in ${facts.FragmentPath ?? path}`);
  const url = await upUrl(argv?.slice(1) ?? []);
  return {
    program,
    inside: insideService(),
    status: async () => {
      const { ActiveState, SubState, MainPID } = await show();
      return {
        running: ActiveState === "active" && SubState === "running",
        crashed:
          ActiveState === "failed" ||
          ActiveState === "inactive" ||
          SubState === "auto-restart",
        restarting: ActiveState === "activating",
        pid: Number(MainPID ?? 0),
      };
    },
    stop: async () => {
      await systemctl("stop", UNIT_FILE);
    },
    start: async () => {
      await systemctl("start", UNIT_FILE);
    },
    up: () => askUp(url),
  };
}
