/**
 * What Windows runs for a service: `eta-host.exe service-run --name <service> --config <file>`.
 *
 * It starts the host as a child, turns a stop into the host's stop channel and kills it past the
 * time it has, and restarts it if it crashes: a service's run loop and nothing of the host's. Being
 * the same file, it is a small process, because it loads none of the host (`apps/eta/scripts/embed.ts`
 * branches to it first).
 *
 * The host is a child, not this process, so that a restart is this process's to give and take back.
 * Windows's own restart of a crashed service cannot be cancelled, and it would land in the middle
 * of a roll-back restoring the database; and a host that hangs cannot be killed by its own timer,
 * and has no stdout as a service for a crash to be written to.
 *
 * Talking to Windows takes a thread for it. `StartServiceCtrlDispatcherW` blocks the thread that
 * calls it until the service ends, so a Worker makes the call and this thread stays free. Windows
 * then calls back on two threads: `ServiceMain` on one of its own, which only a `threadsafe`
 * callback can receive, posted here; and `HandlerEx` on the dispatcher's, the Worker's, which is
 * inside the blocking call and runs it like any other callback. That one can return `NO_ERROR`,
 * which a `threadsafe` callback cannot.
 *
 * The upgrade's worker runs the same way, once: `Once` in the config.
 */
import type { Subprocess } from "bun";
import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { connect } from "node:net";
import { homedir } from "node:os";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";
import { FFIType, JSCallback } from "bun:ffi";
import {
  assignToJob,
  createKillJob,
  registerControls,
  SERVICE_RUNNING,
  SERVICE_STOP_PENDING,
  SERVICE_STOPPED,
  STOP_CONTROLS,
  terminateJob,
  wide,
} from "./windows-api";

/** The first argument that makes the file a service, not a host. */
export const SERVICE_COMMAND = "service-run";

/** As long as systemd's default gives a host before it kills it. */
const DEFAULT_STOP_SECONDS = 90;
/** Like `RestartSec` in the systemd unit. */
const RESTART_DELAY_MS = 10_000;
const LOG_LIMIT = 10 * 1024 * 1024;
const STOP_RETRY_MS = 500;
const CHECKPOINT_MS = 1000;
const REMOVE_TRIES = 20;
const REMOVE_RETRY_MS = 250;
const RENAME_TRIES = 10;
const RENAME_RETRY_MS = 20;
const EXIT_AFTER_REPORT_MS = 200;

/** What a service runs, written by `service-windows.ts`. */
interface ShellConfig {
  argv: string[];
  env: Record<string, string>;
  log: string;
  state: string;
  /** Run once: the upgrade's worker. Otherwise kept up. */
  once: boolean;
  stopSeconds?: number;
  /** A file to delete once the run is over: the copy of the executable a worker ran from. */
  remove?: string;
}

/** What Windows cannot say: its service is this process, up while it waits to start the host. */
interface ShellState {
  state: "starting" | "running" | "backoff" | "stopping" | "stopped";
  pid: number;
  restarts: number;
  exitCode: number;
  error?: string;
}

/** The Worker: a file would need bundling as a second entry, and this is the one call it makes. */
const DISPATCHER = String.raw`
import { dlopen, FFIType, JSCallback, ptr } from "bun:ffi";
self.onmessage = ({ data }) => {
  const { symbols } = dlopen("advapi32.dll", {
    StartServiceCtrlDispatcherW: { args: [FFIType.ptr], returns: FFIType.i32 },
  });
  const handler = new JSCallback((control) => {
    postMessage({ control });
    return 0;
  }, {
    args: [FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.ptr],
    returns: FFIType.u32,
  });
  postMessage({ handler: handler.ptr });
  const name = new Uint8Array(Buffer.from(data.name + "\0", "utf16le"));
  const table = new BigUint64Array(4);
  table[0] = BigInt(ptr(name));
  table[1] = BigInt(data.serviceMain);
  const ok = symbols.StartServiceCtrlDispatcherW(ptr(table));
  postMessage({ returned: ok, keep: [handler.ptr, name.length, table.length] });
};
`;

function openLog(path: string): number {
  try {
    if (statSync(path).size > LOG_LIMIT) renameSync(path, `${path}.1`);
  } catch {
    // Not there yet.
  }
  return openSync(path, "a", 0o600);
}

class Shell {
  readonly #config: ShellConfig;
  readonly #job = createKillJob();
  readonly #pipe = `\\\\.\\pipe\\eta-stop-${randomBytes(16).toString("hex")}`;
  #report: (state: number, checkpoint: number) => void = () => undefined;
  #child: Subprocess | undefined;
  #restarts = 0;
  #again: ReturnType<typeof setTimeout> | undefined;
  #stopping = false;
  #onExit: (() => void) | undefined;

  constructor(config: ShellConfig) {
    this.#config = config;
  }

  #note(line: string): void {
    appendFileSync(
      this.#config.log,
      `[eta-service] ${new Date().toISOString()} ${line}\n`,
    );
  }

  #save(state: Omit<ShellState, "restarts">): void {
    const path = this.#config.state;
    const part = `${path}.part`;
    writeFileSync(
      part,
      JSON.stringify({ ...state, restarts: this.#restarts }),
      { mode: 0o600 },
    );
    for (let tries = 1; ; tries += 1) {
      try {
        renameSync(part, path);
        return;
      } catch (error) {
        if (tries === RENAME_TRIES) throw error;
        Bun.sleepSync(RENAME_RETRY_MS);
      }
    }
  }

  start(report: (state: number, checkpoint: number) => void): void {
    this.#report = report;
    report(SERVICE_RUNNING, 0);
    this.#spawn();
  }

  #spawn(): void {
    const { argv, env, log } = this.#config;
    this.#save({ state: "starting", pid: 0, exitCode: 0 });
    let child: Subprocess;
    const output = openLog(log);
    try {
      // Names only differ in case on Windows: what the config says replaces the service's own.
      const inherited = Object.entries(process.env).filter(
        ([name]) =>
          !Object.keys(env).some(
            (key) => key.toLowerCase() === name.toLowerCase(),
          ),
      );
      child = Bun.spawn(argv, {
        cwd: homedir(),
        env: {
          ...Object.fromEntries(inherited),
          ...env,
          ETA_STOP_PIPE: this.#pipe,
        },
        stdin: "ignore",
        stdout: output,
        stderr: output,
        windowsHide: true,
      });
      // At once: what it starts must not outlive the service, and it has had no time to start
      // anything yet.
      assignToJob(this.#job, child.pid);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.#note(`could not start ${argv[0]}: ${message}`);
      this.#save({ state: "starting", pid: 0, exitCode: 0, error: message });
      this.#exited(-1);
      return;
    } finally {
      closeSync(output);
    }
    this.#child = child;
    this.#save({ state: "running", pid: child.pid, exitCode: 0 });
    this.#note(`started ${argv[0]}: pid ${child.pid}`);
    void child.exited.then((code) => this.#exited(code));
  }

  #exited(code: number): void {
    const { argv, once } = this.#config;
    this.#child = undefined;
    // What it left behind goes with it, as with a unit's cgroup.
    terminateJob(this.#job, 1);
    if (this.#stopping) {
      this.#onExit?.();
      return;
    }
    if (once || code === 0) {
      this.#note(`${argv[0]} exited: ${code}`);
      void this.#finish(code);
      return;
    }
    this.#note(
      `${argv[0]} exited: ${code}; starting it again in ${RESTART_DELAY_MS / 1000}s`,
    );
    this.#restarts += 1;
    this.#save({ state: "backoff", pid: 0, exitCode: code });
    this.#again = setTimeout(() => this.#spawn(), RESTART_DELAY_MS);
  }

  /** Reaches the host's stop channel; false when it is not listening yet. */
  #tell(): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = connect(this.#pipe, () => {
        socket.write("stop\n", () => {
          socket.end();
          resolve(true);
        });
      });
      socket.on("error", () => resolve(false));
    });
  }

  /**
   * Asks the program to leave, and past the time it has takes it and everything it started. A run
   * with `once` has no such time: the worker decides when it can stop, and leaving the service
   * between two builds is the one thing it must not do.
   */
  async stop(): Promise<void> {
    if (this.#stopping) return;
    this.#stopping = true;
    clearTimeout(this.#again);
    const { argv, once, stopSeconds } = this.#config;
    let checkpoint = 1;
    this.#report(SERVICE_STOP_PENDING, checkpoint);
    const ticking = setInterval(() => {
      checkpoint += 1;
      this.#report(SERVICE_STOP_PENDING, checkpoint);
    }, CHECKPOINT_MS);
    if (this.#child !== undefined) {
      const child = this.#child;
      this.#save({ state: "stopping", pid: child.pid, exitCode: 0 });
      const seconds = stopSeconds ?? DEFAULT_STOP_SECONDS;
      const deadline = Date.now() + seconds * 1000;
      const gone = new Promise<void>((resolve) => {
        this.#onExit = resolve;
      });
      const asking = async (): Promise<void> => {
        let told = false;
        const late = () => !once && Date.now() >= deadline;
        while (!late()) {
          told ||= await this.#tell();
          await sleep(STOP_RETRY_MS);
        }
      };
      await Promise.race([gone, asking()]);
      if (this.#child !== undefined) {
        this.#note(`${argv[0]} did not stop in ${seconds}s: killing it`);
        terminateJob(this.#job, 1);
        await gone;
      }
    }
    clearInterval(ticking);
    await this.#finish(0);
  }

  async #finish(code: number): Promise<void> {
    const { remove } = this.#config;
    this.#save({ state: "stopped", pid: 0, exitCode: code });
    if (remove !== undefined) {
      // The file stays mapped for a moment after the process has exited.
      for (let tries = 1; tries <= REMOVE_TRIES; tries += 1) {
        try {
          rmSync(remove, { force: true });
          break;
        } catch {
          await sleep(REMOVE_RETRY_MS);
        }
      }
    }
    this.#report(SERVICE_STOPPED, 0);
    setTimeout(() => process.exit(0), EXIT_AFTER_REPORT_MS);
  }
}

/** Becomes the service called `name` and runs what the config at `path` says, until told to stop. */
export function runServiceShell(args: readonly string[]): void {
  const { values } = parseArgs({
    args: [...args],
    options: { name: { type: "string" }, config: { type: "string" } },
  });
  const { config: path, name } = values;
  if (name === undefined || path === undefined)
    throw new Error(
      `usage: ${SERVICE_COMMAND} --name <service> --config <file>`,
    );
  const config = JSON.parse(readFileSync(path, "utf8")) as ShellConfig;
  // A run's config may carry a token, and was written for that run alone.
  if (config.once) rmSync(path, { force: true });
  const shell = new Shell(config);

  const worker = new Worker(
    URL.createObjectURL(
      new Blob([DISPATCHER], { type: "application/typescript" }),
    ),
  );
  let handler = 0;
  const wideName = wide(name);
  const serviceMain = new JSCallback(
    () => {
      shell.start(registerControls(wideName, handler));
    },
    {
      args: [FFIType.u32, FFIType.ptr],
      returns: FFIType.void,
      threadsafe: true,
    },
  );
  worker.onmessage = ({ data }) => {
    const message = data as { control?: number; handler?: number };
    if (message.handler !== undefined)
      ({ handler } = message as { handler: number });
    if (message.control !== undefined && STOP_CONTROLS.has(message.control))
      void shell.stop();
  };
  worker.postMessage({ name, serviceMain: serviceMain.ptr });
  // Held for the life of the process: Windows calls these for as long as it runs.
  setInterval(() => wideName.length, 2 ** 30);
}
