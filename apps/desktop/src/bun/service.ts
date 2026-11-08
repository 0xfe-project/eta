/**
 * The local host as a service the app keeps, and the port that lets the host's upgrade use it.
 *
 * A host is kept running by a systemd unit, a launchd agent or a Windows service, or by this app:
 * the fourth kind, and the only one an upgrade has to ask over a port. `LocalHost` starts the host,
 * stops it, starts it again on the port it had, and says how it is; `startServiceServer` puts that
 * on a loopback port, behind a token, for `apps/eta/src/upgrade/desktop.ts`. The host is told both
 * in its environment (`ETA_DESKTOP_SERVICE`, `ETA_DESKTOP_SERVICE_TOKEN`), and the upgrade then
 * runs the way it does under any service: download, check, back up the database, stop, swap the
 * file, start, watch, and go back if the new build does not hold.
 *
 * The upgrade itself is the host's code, in a process of its own (`eta-host upgrade --worker`). It
 * cannot be the host's child, since it stops the host, so the host asks this app to start it, and it
 * is this app's child: it lives through the host's restart and ends with it. Only that command is
 * started: argv has to be the host's own file and `upgrade`.
 *
 * The port is the same every time the host is started again, because the page is served from it:
 * the window stays where it is, and the page's own upgrade screen waits for the host to come back
 * at the address it knows, then reloads.
 */
import type { Subprocess } from "bun";
import { Buffer } from "node:buffer";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { realpathSync } from "node:fs";
import { copyFile, readFile, rm } from "node:fs/promises";
import { connect } from "node:net";
import { join } from "node:path";
import process from "node:process";

/** What `ETA_DESKTOP_SERVICE` and its token are called in the host's environment. */
export const SERVICE_ENV = "ETA_DESKTOP_SERVICE";
export const SERVICE_TOKEN_ENV = "ETA_DESKTOP_SERVICE_TOKEN";

/** The host has this long to close its sessions and database before it is killed. */
const STOP_GRACE_MS = 10_000;
const READY_MS = 20_000;
const isWindows = process.platform === "win32";

export interface LocalHostOptions {
  /** What runs the host, flags included, without `--port`. */
  command: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** The script ahead of the host (`host.ts`), and the runtime that runs it. */
  wrapper: string;
  bun: string;
  /** Where the wrapper writes the host's first line. */
  summary: string;
}

export interface HostState {
  running: boolean;
  /** It exited without being stopped. */
  crashed: boolean;
  pid: number;
}

/**
 * A process stopped the polite way: a signal, or on Windows a line on its stop pipe. Killed after
 * `graceMs`; without it, waited for as long as it takes.
 */
async function stopProcess(
  child: Subprocess,
  pipe: string | undefined,
  graceMs?: number,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (pipe === undefined) child.kill("SIGTERM");
  else
    await new Promise<void>((resolve) => {
      const socket = connect(pipe, () => {
        socket.end("stop\n", resolve);
      });
      socket.on("error", () => {
        child.kill();
        resolve();
      });
    });
  if (graceMs === undefined) {
    await child.exited;
    return;
  }
  const gaveUp = new Promise((resolve) =>
    setTimeout(resolve, graceMs, "timeout"),
  );
  if ((await Promise.race([child.exited, gaveUp])) === "timeout") {
    child.kill("SIGKILL");
    await child.exited;
  }
}

/** A name for a stop pipe on Windows; elsewhere a signal does it. */
const stopPipe = (): string | undefined =>
  isWindows
    ? `\\\\.\\pipe\\eta-desktop-stop-${randomBytes(16).toString("hex")}`
    : undefined;

export class LocalHost {
  readonly #options: LocalHostOptions;
  #child: Subprocess | undefined;
  #pipe: string | undefined;
  #stopping = false;
  #port = 0;

  constructor(options: LocalHostOptions) {
    this.#options = options;
  }

  /** The port it listens on: 0 until the first start has said. */
  get port(): number {
    return this.#port;
  }

  /** Start it on the port it had, any free one the first time. */
  async spawn(): Promise<void> {
    const { bun, command, cwd, env, summary, wrapper } = this.#options;
    await rm(summary, { force: true });
    this.#pipe = stopPipe();
    this.#stopping = false;
    this.#child = Bun.spawn(
      [bun, wrapper, ...command, "--port", String(this.#port)],
      {
        cwd,
        env: {
          ...env,
          ETA_DESKTOP_SUMMARY: summary,
          ...(this.#pipe === undefined ? {} : { ETA_STOP_PIPE: this.#pipe }),
        },
        stdout: "inherit",
        stderr: "inherit",
      },
    );
  }

  /** The port it bound, once it has said; an error if it exited or took too long first. */
  async ready(): Promise<number> {
    const child = this.#child;
    if (child === undefined) throw new Error("the host is not running");
    const deadline = Date.now() + READY_MS;
    for (;;) {
      // The launcher owns this process's stdout, so the wrapper writes the line to a file.
      const text = await readFile(this.#options.summary, "utf8").catch(
        () => "",
      );
      if (text.includes("\n")) {
        const { port } = JSON.parse(text.slice(0, text.indexOf("\n"))) as {
          port: number;
        };
        this.#port = port;
        return port;
      }
      if (child.exitCode !== null)
        throw new Error(
          `the host exited with ${String(child.exitCode)} before it was ready`,
        );
      if (Date.now() > deadline)
        throw new Error("the host was not ready after 20s");
      await Bun.sleep(100);
    }
  }

  /** Stop it and wait: it holds the database until it has gone. */
  async stop(): Promise<void> {
    const child = this.#child;
    if (child === undefined) return;
    this.#stopping = true;
    await stopProcess(child, this.#pipe, STOP_GRACE_MS);
  }

  state(): HostState {
    const child = this.#child;
    if (child === undefined) return { running: false, crashed: false, pid: 0 };
    const exited = child.exitCode !== null || child.signalCode !== null;
    return {
      running: !exited,
      crashed: exited && !this.#stopping,
      pid: child.pid,
    };
  }
}

/** Whether two paths are one file; Windows's names have no case. */
function sameFile(one: string, other: string): boolean {
  try {
    const [first, second] = [realpathSync(one), realpathSync(other)];
    return isWindows
      ? first.toLowerCase() === second.toLowerCase()
      : first === second;
  } catch {
    return false;
  }
}

export interface ServiceServerOptions {
  host: LocalHost;
  /** The file the host runs: the only program a job may be. */
  program: string;
  /** Where a job's copy of the program goes on Windows. */
  dir: string;
  /** The environment a job starts from; what the host passes along goes over it. */
  env: NodeJS.ProcessEnv;
}

export interface ServiceServer {
  /** What the host is given, so it can find this. Never log the token. */
  env: Record<string, string>;
  /** Whether a job is running. */
  busy: () => boolean;
  /** Ask the job to stop, and wait for it as long as it takes: past the stop it does not listen. */
  finishJob: () => Promise<void>;
  close: () => void;
}

interface Job {
  name: string;
  child: Subprocess;
  pipe: string | undefined;
}

const json = (value: unknown): Response =>
  Response.json(value, { headers: { "cache-control": "no-store" } });

const stringRecord = (value: unknown): value is Record<string, string> =>
  typeof value === "object" &&
  value !== null &&
  Object.values(value).every((item) => typeof item === "string");

export function startServiceServer(
  options: ServiceServerOptions,
): ServiceServer {
  const { host, program } = options;
  const token = randomBytes(24).toString("base64url");
  const expected = Buffer.from(token);
  let job: Job | undefined;
  /** This port's own address, known once it listens. */
  let address = "";

  const jobRunning = (): boolean =>
    job !== undefined &&
    job.child.exitCode === null &&
    job.child.signalCode === null;

  const endJob = async (): Promise<void> => {
    if (job === undefined) return;
    const { child, pipe } = job;
    // A job past the point of no return ignores this and finishes; that is what it should do.
    await stopProcess(child, pipe);
  };

  async function startJob(body: unknown): Promise<Response> {
    const { argv, env, name } = (body ?? {}) as Record<string, unknown>;
    if (
      typeof name !== "string" ||
      !Array.isArray(argv) ||
      !argv.every((word) => typeof word === "string") ||
      !stringRecord(env)
    )
      return new Response("invalid", { status: 400 });
    const [file, subcommand, ...rest] = argv as string[];
    if (
      file === undefined ||
      !sameFile(file, program) ||
      subcommand !== "upgrade"
    )
      return new Response("only the host's own upgrade runs here", {
        status: 403,
      });
    // The one run of this name: a second one replaces what is left of the first.
    if (jobRunning()) await endJob();
    // On Windows a running file cannot be replaced, so the job runs from a copy of it.
    let run = file;
    if (isWindows) {
      run = join(options.dir, `${name}.exe`);
      await copyFile(file, run);
    }
    const pipe = stopPipe();
    const child = Bun.spawn([run, subcommand, ...rest], {
      env: {
        ...options.env,
        ...env,
        [SERVICE_ENV]: address,
        [SERVICE_TOKEN_ENV]: token,
        ...(pipe === undefined ? {} : { ETA_STOP_PIPE: pipe }),
      },
      stdin: "ignore",
      stdout: "inherit",
      stderr: "inherit",
    });
    job = { name, child, pipe };
    if (run !== file) void child.exited.then(() => rm(run, { force: true }));
    return json({ ok: true });
  }

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    // Stopping the host waits for it to close, which can be longer than Bun's default 10s.
    idleTimeout: 120,
    async fetch(request) {
      const supplied = Buffer.from(
        request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "",
      );
      if (
        supplied.length !== expected.length ||
        !timingSafeEqual(supplied, expected)
      )
        return new Response("authentication_failed", { status: 401 });
      // A page cannot send that header across origins without asking first, and nothing here
      // answers the asking; this is for the host and its job, never for a page.
      if (request.headers.get("origin") !== null)
        return new Response("origin_denied", { status: 403 });

      const { pathname } = new URL(request.url);
      if (request.method === "GET" && pathname === "/service")
        return json({ program, port: host.port, ...host.state() });
      if (request.method !== "POST")
        return new Response("not_found", { status: 404 });
      const body: unknown = await request.json().catch(() => undefined);
      switch (pathname) {
        case "/service/stop":
          await host.stop();
          return json({ ok: true });
        case "/service/start":
          if (host.state().running) return json({ ok: true });
          await host.spawn();
          return json({ ok: true });
        case "/worker/start":
          return await startJob(body);
        case "/worker/stop": {
          const { name } = (body ?? {}) as { name?: unknown };
          if (job !== undefined && job.name === name && jobRunning())
            void endJob();
          return json({ ok: true });
        }
        default:
          return new Response("not_found", { status: 404 });
      }
    },
  });

  address = server.url.origin;
  return {
    env: { [SERVICE_ENV]: address, [SERVICE_TOKEN_ENV]: token },
    busy: jobRunning,
    finishJob: async () => {
      if (jobRunning()) await endJob();
    },
    close: () => {
      void server.stop(true);
    },
  };
}
