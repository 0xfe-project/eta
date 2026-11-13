/**
 * A host this TUI starts for itself and stops when done: `eta-host --port 0` as a child process,
 * ready once it prints its startup summary (`apps/eta/src/main.ts`), a JSON line with the port.
 */
import type { Subprocess } from "bun";
import type { HostProgram } from "./types";
import { connect } from "node:net";
import process from "node:process";

/** How many lines of the child's output are kept for the user to read when it fails. */
const OUTPUT_LINES = 200;
/** How long to wait for the rest of the output once a child that never got ready has ended. */
const DRAIN_AFTER_EXIT_MS = 1_000;

export interface TemporaryHost {
  /** `http://127.0.0.1:<port>`. */
  readonly url: string;
  readonly pid: number;
  /** The exit code; null when a signal ended it. */
  readonly exited: Promise<number | null>;
  /** The last lines it printed, stdout and stderr in the order they came. */
  output: () => string;
  /** Called once with the exit code when it ends, however it ends. */
  onExit: (listener: (code: number | null) => void) => void;
  /**
   * Ask it to stop (SIGTERM; on Windows a line on its stop pipe), kill it after `waitMs`, and
   * resolve once it has ended. Calling again waits for the same end.
   */
  stop: (waitMs: number) => Promise<void>;
  /** Kill it now, without waiting: for the last moment of the process, where nothing awaits. */
  killNow: () => void;
}

export type LaunchResult =
  | { ok: true; host: TemporaryHost }
  | { ok: false; output: string };

/** The last lines of a stream of text, split as they arrive. */
class OutputTail {
  private readonly lines: string[] = [];
  add(line: string): void {
    this.lines.push(line);
    if (this.lines.length > OUTPUT_LINES) this.lines.shift();
  }

  text(): string {
    return this.lines.join("\n");
  }
}

/** The port of the host's startup summary, when `line` is one. */
export function summaryPort(line: string): number | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    return undefined;
  const port = (parsed as { port?: unknown }).port;
  return typeof port === "number" && Number.isInteger(port) && port > 0
    ? port
    : undefined;
}

/** Reads a stream to its end, line by line. Never throws. */
async function readLines(
  stream: ReadableStream<Uint8Array>,
  onLine: (line: string) => void,
): Promise<void> {
  const decoder = new TextDecoder();
  let pending = "";
  try {
    for await (const chunk of stream) {
      pending += decoder.decode(chunk, { stream: true });
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? "";
      for (const line of lines) onLine(line);
    }
  } catch {
    // A pipe torn down under a killed child; what was read is kept.
  }
  pending += decoder.decode();
  if (pending !== "") onLine(pending);
}

function stopPipeName(): string {
  return `\\\\.\\pipe\\eta-tui-${process.pid}-${crypto.randomUUID()}`;
}

const delay = (ms: number) =>
  new Promise<"late">((resolve) => setTimeout(resolve, ms, "late"));

/** How long to wait between tries on a stop pipe nobody listens on yet. */
const PIPE_RETRY_MS = 100;

/** Writes one line to the host's stop pipe; false when nobody listens on it. */
function writeStopLine(pipe: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(pipe, () => {
      socket.end("stop\n");
      resolve(true);
    });
    socket.on("error", () => resolve(false));
  });
}

// The host prints its summary before it listens on the pipe (`apps/eta/src/main.ts`), so a
// stop asked for right after the start finds no pipe yet: try again until it is there, the
// host has ended, or the stop's time is up and the kill takes over.
async function requestStopOverPipe(
  pipe: string,
  until: { ended: () => boolean; deadline: number },
): Promise<void> {
  while (!until.ended() && Date.now() < until.deadline) {
    if (await writeStopLine(pipe)) return;
    await delay(PIPE_RETRY_MS);
  }
}

/**
 * Start `[command, ...args, "--port", "0"]` with no stdin and its output piped, read to the end
 * so the child never blocks on a full pipe. The child does not get the signals of eta's terminal. Ready at the first stdout line that is a JSON object
 * with a positive integer `port`. Fails, with the output, if the child ends first or `startMs`
 * passes (the child is killed then).
 */
export async function launchTemporaryHost(options: {
  program: HostProgram;
  env: NodeJS.ProcessEnv;
  startMs: number;
  platform?: NodeJS.Platform;
  /** Aborting kills the child; the launch then fails. */
  signal?: AbortSignal;
}): Promise<LaunchResult> {
  const platform = options.platform ?? process.platform;
  const pipe = platform === "win32" ? stopPipeName() : undefined;
  const tail = new OutputTail();
  let child: Subprocess<"ignore", "pipe", "pipe">;
  try {
    child = Bun.spawn(
      [options.program.command, ...options.program.args, "--port", "0"],
      {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        // The terminal sends Ctrl+C (and, on POSIX, the hangup of a closing terminal) to every
        // process in eta's process group or on its console, the editor eta hands the terminal to
        // included. Out of them the host stops only when eta asks. POSIX: a session of its own.
        // Windows: with no stdio inherited, a hidden window gives it a console of its own, which
        // the programs it starts share, so they open no console windows either.
        ...(platform === "win32" ? { windowsHide: true } : { detached: true }),
        env:
          pipe === undefined
            ? options.env
            : { ...options.env, ETA_STOP_PIPE: pipe },
      },
    );
  } catch (error) {
    return {
      ok: false,
      output: error instanceof Error ? error.message : String(error),
    };
  }

  let ready: (port: number) => void = () => undefined;
  const readyPort = new Promise<number>((resolve) => {
    ready = resolve;
  });
  const drained = Promise.all([
    readLines(child.stdout, (line) => {
      tail.add(line);
      const port = summaryPort(line);
      if (port !== undefined) ready(port);
    }),
    readLines(child.stderr, (line) => tail.add(line)),
  ]);
  const exited = child.exited.then(() => child.exitCode);
  const abort = () => child.kill("SIGKILL");
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted === true) abort();

  const first = await Promise.race([
    readyPort,
    exited.then(() => "exited" as const),
    delay(options.startMs),
  ]);
  options.signal?.removeEventListener("abort", abort);
  if (first === "late") {
    child.kill("SIGKILL");
    await exited;
    await Promise.race([drained, delay(DRAIN_AFTER_EXIT_MS)]);
    return { ok: false, output: tail.text() };
  }
  if (first === "exited") {
    await Promise.race([drained, delay(DRAIN_AFTER_EXIT_MS)]);
    return { ok: false, output: tail.text() };
  }
  return { ok: true, host: runningHost(child, first, exited, tail, pipe) };
}

function runningHost(
  child: Subprocess<"ignore", "pipe", "pipe">,
  port: number,
  exited: Promise<number | null>,
  tail: OutputTail,
  pipe: string | undefined,
): TemporaryHost {
  let stopping: Promise<void> | undefined;
  let ended = false;
  void exited.then(() => {
    ended = true;
  });
  return {
    url: `http://127.0.0.1:${port}`,
    pid: child.pid,
    exited,
    output: () => tail.text(),
    onExit(listener) {
      void exited.then(listener);
    },
    stop(waitMs) {
      if (stopping !== undefined) return stopping;
      stopping = (async () => {
        if (ended) return;
        if (pipe === undefined) child.kill("SIGTERM");
        else
          void requestStopOverPipe(pipe, {
            ended: () => ended,
            deadline: Date.now() + waitMs,
          });
        const outcome = await Promise.race([exited, delay(waitMs)]);
        if (outcome === "late") {
          child.kill("SIGKILL");
          await exited;
        }
      })();
      return stopping;
    },
    killNow() {
      if (!ended) child.kill("SIGKILL");
    },
  };
}
