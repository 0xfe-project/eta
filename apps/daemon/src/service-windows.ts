/**
 * A service as a real Windows service. A Bun program can answer the Service Control Manager only
 * through `bun:ffi`, which is what `windows-api.ts` is for, and `windows-shell.ts` is what Windows
 * runs: this file itself, in the mode that starts the host, turns a stop into the host's stop
 * channel, and restarts it if it crashes. One file, with nothing unpacked.
 *
 * A service runs as an account, and as the installing user's it reads what that user is logged in
 * to; that takes the password once, handed to Windows and kept nowhere here, and an Administrator
 * terminal. After that the same user can stop and start it without one: the install grants that on
 * the service, and a service cannot ask for elevation.
 *
 * A detached run is a second service, registered with the first, to run once. It is the only way
 * out from under the host: what the host starts is in a job object that dies with it, and nothing
 * started inside one leaves it.
 */
import type {
  DetachedRunner,
  ServiceDefinition,
  ServiceManager,
  ServiceStatus,
  ServiceUnit,
} from "./service";
import { existsSync, readFileSync } from "node:fs";
import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, win32 } from "node:path";
import process from "node:process";
import { createInterface } from "node:readline/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { passedValues, serviceDefinition } from "./service";
import {
  checkPassword,
  currentUser,
  deleteService,
  ERROR_ACCESS_DENIED,
  ERROR_LOGON_FAILURE,
  grantLogonRight,
  isElevated,
  queryService,
  registerService,
  revokeLogonRight,
  startService,
  stdinIsConsole,
  stopService,
  wide,
  WindowsError,
  withoutEcho,
} from "./windows-api";
import { SERVICE_COMMAND } from "./windows-shell";

/** The calls this makes, for a test to stand in for. */
const windowsApi = {
  checkPassword,
  currentUser,
  deleteService,
  grantLogonRight,
  isElevated,
  queryService,
  registerService,
  revokeLogonRight,
  startService,
  stopService,
};
type Api = typeof windowsApi;

export interface WindowsOptions {
  /** The worker's service, registered and removed along with the service. */
  worker: { name: string; description: string };
  home?: string;
  api?: Api;
  /** The account's password; by default asked for on this terminal, or a line of a piped stdin. */
  password?: (
    account: string,
    check: (typed: string) => void,
  ) => Promise<string>;
}

interface ShellState {
  state: "starting" | "running" | "backoff" | "stopping" | "stopped";
  pid: number;
}

/** The file that says the install gave the logon right, so uninstalling takes back only that. */
const LOGON_RIGHT_MARK = "logon-right-granted";
/** A shell has told Windows it stopped a moment before its process, and its file, are gone. */
const RELEASE_TRIES = 40;
const RELEASE_RETRY_MS = 250;
const PASSWORD_TRIES = 3;
/** Long enough for a host to get its time to stop, be killed, and for the shell to say so. */
const STOP_WAIT_MS = 120_000;
const START_WAIT_MS = 30_000;
const POLL_MS = 200;
/** A deleted service stays until the last handle on it closes, which may be a console's. */
const CREATE_TRIES = 20;
const CREATE_RETRY_MS = 500;
/** What Windows waits before starting the shell again, if the shell itself dies. */
const SHELL_RESTART_MS = 10_000;

const adminError = (what: string): Error =>
  new Error(
    `${what} takes an Administrator terminal: open one (right-click Terminal, Run as administrator) and run this again.`,
  );

/** What a refused call means here: Windows only says the number. */
const refused = (what: string, name: string, error: unknown): unknown =>
  error instanceof WindowsError && error.code === ERROR_ACCESS_DENIED
    ? new Error(
        `${what} ${name} was refused: this account did not install it. Run this as the user who did, or in an Administrator terminal.`,
      )
    : error;

/** A command line as `CommandLineToArgvW` reads it back. */
export function commandLine(argv: readonly string[]): string {
  return argv
    .map((word) => {
      if (word !== "" && !/[\s"]/.test(word)) return word;
      const escaped = word
        .replace(/(\\*)"/g, '$1$1\\"')
        .replace(/(\\+)$/, "$1$1");
      return `"${escaped}"`;
    })
    .join(" ");
}

async function askPassword(
  account: string,
  check: (typed: string) => void,
): Promise<string> {
  const lines = createInterface({ input: process.stdin });
  try {
    if (!stdinIsConsole()) {
      const typed = await lines[Symbol.asyncIterator]().next();
      if (typed.done === true) throw new Error("no password on stdin");
      check(typed.value);
      return typed.value;
    }
    process.stderr.write(
      `The service runs as ${account}, so its agents can read your Claude, Codex and gh logins.\n`,
    );
    for (let tries = 1; ; tries += 1) {
      process.stderr.write(`Windows password for ${account}: `);
      const typed = await withoutEcho(() => lines.question(""));
      process.stderr.write("\n");
      try {
        check(typed);
        return typed;
      } catch (error) {
        const wrong =
          error instanceof WindowsError && error.code === ERROR_LOGON_FAILURE;
        if (!wrong || tries === PASSWORD_TRIES) throw error;
        process.stderr.write("That is not the password.\n");
      }
    }
  } finally {
    lines.close();
  }
}

async function onceReleased(action: () => Promise<void>): Promise<void> {
  for (let tries = 1; ; tries += 1) {
    try {
      await action();
      return;
    } catch (error) {
      if (tries === RELEASE_TRIES) throw error;
      await sleep(RELEASE_RETRY_MS);
    }
  }
}

/** Windows hands a local account back as `.\\me`, and names the same one `COMPUTER\\me`. */
function sameAccount(registered: string, account: string): boolean {
  const local = /^\.\\/.test(registered);
  const name = (text: string): string =>
    (local ? text.slice(text.indexOf("\\") + 1) : text).toLowerCase();
  return name(registered) === name(account);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Stops a service and waits for it to be gone. Not only stopped: a service says so just before its
 * process exits, and until it has, the executable it ran from cannot be replaced or deleted.
 */
async function stopAndWait(api: Api, name: string): Promise<void> {
  const { pid = 0 } = api.queryService(name);
  api.stopService(name);
  const until = Date.now() + STOP_WAIT_MS;
  while (Date.now() < until) {
    const { installed, state } = api.queryService(name);
    if ((!installed || state === "stopped") && (pid === 0 || !alive(pid)))
      return;
    await sleep(POLL_MS);
  }
  throw new Error(`${name} did not stop in ${STOP_WAIT_MS / 1000}s`);
}

/** The service's own config and the worker's, which only exists for a run. */
const serveCommand = (exe: string, name: string, config: string): string =>
  commandLine([exe, SERVICE_COMMAND, "--name", name, "--config", config]);

export function windowsManager(
  unit: ServiceUnit,
  options: WindowsOptions,
): ServiceManager {
  const { name } = unit;
  const { worker } = options;
  const api = options.api ?? windowsApi;
  const home = options.home ?? homedir();

  const definition = (command: {
    program: string;
    args: string[];
  }): ServiceDefinition => serviceDefinition(command, "win32", home, unit);
  const { path } = definition({ program: "", args: [] });
  const dir = dirname(path);
  const mark = join(dir, LOGON_RIGHT_MARK);

  const shellState = (): ShellState | undefined => {
    try {
      const { state } = JSON.parse(readFileSync(path, "utf8")) as {
        state: string;
      };
      return JSON.parse(readFileSync(state, "utf8")) as ShellState;
    } catch {
      return undefined;
    }
  };
  const stop = async (): Promise<void> => {
    try {
      await stopAndWait(api, name);
    } catch (error) {
      throw refused("Stopping", name, error);
    }
  };
  const start = async (): Promise<void> => {
    try {
      api.startService(name);
    } catch (error) {
      throw refused("Starting", name, error);
    }
    for (const until = Date.now() + START_WAIT_MS; Date.now() < until; ) {
      const { state } = api.queryService(name);
      if (state === "running") return;
      if (state === "stopped") throw new Error(`${name} stopped as it started`);
      await sleep(POLL_MS);
    }
    throw new Error(`${name} did not start in ${START_WAIT_MS / 1000}s`);
  };

  async function register(
    registration: Parameters<Api["registerService"]>[0],
  ): Promise<void> {
    for (let tries = 1; !api.registerService(registration); tries += 1) {
      if (tries === CREATE_TRIES)
        throw new Error(`${registration.name} is still being deleted`);
      await sleep(CREATE_RETRY_MS);
    }
  }

  return {
    name,
    startCommand: `sc start ${name}`,
    installed: () => {
      if (!api.queryService(name).installed) return Promise.resolve(undefined);
      let argv: string[] | undefined;
      try {
        ({ argv } = JSON.parse(readFileSync(path, "utf8")) as {
          argv?: string[];
        });
      } catch {
        // Another user's: a service of this name, with its files in that user's home.
      }
      if (argv === undefined)
        throw new Error(
          `${name} is installed, but ${path} does not say what it runs. Was it installed by another user?`,
        );
      return Promise.resolve(argv);
    },
    status: (): Promise<ServiceStatus> => {
      const { pid: shellPid, state } = api.queryService(name);
      const inner = state === "running" ? shellState() : undefined;
      const running = inner?.state === "running" && inner.pid > 0;
      // The service is the shell, and it stays up while it waits to start the program again.
      return Promise.resolve({
        running,
        crashed: state === "stopped" || inner?.state === "backoff",
        restarting:
          state === "start-pending" ||
          inner?.state === "backoff" ||
          inner?.state === "starting",
        pid: running ? inner.pid : (shellPid ?? 0),
      });
    },
    stop,
    start,
    install: async (command) => {
      // First, while nothing has changed.
      if (!api.isElevated()) throw adminError("install-service");
      const installing = definition(command);
      const { account, sid } = api.currentUser();
      const before = api.queryService(name);
      if (before.account !== undefined && !sameAccount(before.account, account))
        throw new Error(
          `${name} runs as ${before.account}, not ${account}: run uninstall-service first`,
        );
      await mkdir(dir, { recursive: true });
      let password: Uint8Array | undefined;
      if (!before.installed) {
        const typed = await (options.password ?? askPassword)(
          account,
          (attempt) => {
            const bytes = wide(attempt);
            try {
              api.checkPassword(account, bytes);
            } finally {
              bytes.fill(0);
            }
          },
        );
        password = wide(typed);
        if (api.grantLogonRight(sid)) await writeFile(mark, sid);
      }
      try {
        const common = { account, password, sid, restartMs: SHELL_RESTART_MS };
        await register({
          ...common,
          name,
          display: unit.description,
          command: serveCommand(command.program, name, path),
          automatic: true,
        });
        await register({
          ...common,
          name: worker.name,
          display: worker.description,
          command: serveCommand(
            command.program,
            worker.name,
            join(dir, `${worker.name}.json`),
          ),
          automatic: false,
        });
      } finally {
        password?.fill(0);
      }
      await stop();
      await writeFile(path, installing.content, { mode: 0o600 });
      await start();
      return installing;
    },
    uninstall: async (command) => {
      if (!api.isElevated()) throw adminError("uninstall-service");
      const removing = definition(command);
      for (const service of [worker.name, name]) {
        if (!api.queryService(service).installed) continue;
        await stopAndWait(api, service);
        api.deleteService(service);
      }
      if (existsSync(mark)) api.revokeLogonRight(readFileSync(mark, "utf8"));
      await onceReleased(() => rm(dir, { recursive: true, force: true }));
      return removing;
    },
  };
}

export function windowsRunner(options: WindowsOptions): DetachedRunner {
  const api = options.api ?? windowsApi;
  const dir = join(options.home ?? homedir(), ".eta", "service");
  return {
    start: async ({ argv, name, passEnv }) => {
      const [program, ...rest] = argv;
      if (program === undefined) throw new Error(`nothing to run for ${name}`);
      const config = join(dir, `${name}.json`);
      // From a copy, for good: the job is about to replace the file it was started from, and the
      // file of a running program can be moved but not deleted.
      const copy = join(dir, `${name}${win32.extname(program) || ".exe"}`);
      await mkdir(dir, { recursive: true });
      await copyFile(program, copy);
      await writeFile(
        config,
        JSON.stringify({
          argv: [copy, ...rest],
          env: passedValues(passEnv),
          log: join(dir, `${name}.log`),
          state: join(dir, `${name}.state.json`),
          once: true,
          remove: copy,
        }),
        { mode: 0o600 },
      );
      try {
        api.startService(name);
      } catch (error) {
        await rm(config, { force: true });
        await rm(copy, { force: true }).catch(() => undefined);
        throw refused("Starting", name, error);
      }
    },
    stop: (name) => {
      try {
        api.stopService(name);
      } catch (error) {
        throw refused("Stopping", name, error);
      }
      return Promise.resolve();
    },
  };
}
