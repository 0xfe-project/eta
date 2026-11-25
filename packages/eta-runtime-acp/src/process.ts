/**
 * One ACP agent as a child process, and the connection to it.
 *
 * The agent speaks ACP on its stdin and stdout, one JSON-RPC message a line. This starts it, says
 * `initialize`, and from then on is the one place that knows the SDK: everything else in the
 * package asks through `request` / `notify` and hears through the two handlers.
 *
 * What eta tells the agent about itself: it serves neither `fs/*` nor `terminal/*`, so an agent
 * uses its own file and shell access, and it does not sign in for the agent.
 */
import type {
  InitializeRequest,
  InitializeResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
} from "@agentclientprotocol/sdk";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { spawn } from "node:child_process";
import process from "node:process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

const { methods } = acp;

export { methods };

export interface AcpLaunch {
  command: string;
  args: readonly string[];
  env: Readonly<Record<string, string>>;
  cwd: string;
}

export interface AcpHandlers {
  /** A `session/update` from the agent. */
  update: (notification: SessionNotification) => void;
  /** A `session/request_permission`; what is answered goes back to the agent. */
  permission: (
    request: RequestPermissionRequest,
  ) => Promise<RequestPermissionResponse>;
}

export interface AcpProcessOptions {
  warn?: (message: string) => void;
  /** How long the agent may take to answer `initialize`. Default twenty seconds. */
  timeoutMs?: number;
  /** What the agent's stderr lines are told under. */
  label?: string;
}

/** The agent could not be started, or did not answer `initialize`. */
export class AcpStartError extends Error {
  /** `missing`: there is no such command. `error`: anything else. */
  readonly kind: "missing" | "error";

  constructor(message: string, kind: "missing" | "error") {
    super(message);
    this.name = "AcpStartError";
    this.kind = kind;
  }
}

const CLIENT_INFO = { name: "eta", title: "eta", version: "0.1.0" };

/** The last lines of what the agent wrote to stderr: why it died, usually. */
const STDERR_KEPT = 8;
/** How many stderr lines one process may put in the log before the rest are dropped. */
const STDERR_LOGGED = 200;

export class AcpProcess {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #connection: acp.ClientConnection;
  readonly init: InitializeResponse;
  #gone = false;
  readonly #stderr: string[];

  private constructor(
    child: ChildProcessWithoutNullStreams,
    connection: acp.ClientConnection,
    init: InitializeResponse,
    stderr: string[],
  ) {
    this.#child = child;
    this.#connection = connection;
    this.init = init;
    this.#stderr = stderr;
    const gone = (): void => {
      this.#gone = true;
    };
    child.once("exit", gone);
    void connection.closed.then(gone, gone);
  }

  /** Start the agent and shake hands. Throws `AcpStartError` when that does not work. */
  static async start(
    launch: AcpLaunch,
    handlers: AcpHandlers,
    options: AcpProcessOptions = {},
  ): Promise<AcpProcess> {
    const warn = options.warn ?? (() => undefined);
    const label = options.label ?? launch.command;
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(launch.command, [...launch.args], {
        cwd: launch.cwd,
        env: { ...process.env, ...launch.env },
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      throw startError(launch.command, error);
    }
    const stderr: string[] = [];
    let logged = 0;
    let rest = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      const lines = `${rest}${chunk}`.split(/\r?\n/);
      rest = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim() === "") continue;
        stderr.push(line);
        if (stderr.length > STDERR_KEPT) stderr.shift();
        if (logged++ < STDERR_LOGGED)
          warn(`[eta-runtime-acp] ${label}: ${line}`);
      }
    });
    // A pipe the agent closed must not take the host down with an unhandled error.
    child.stdin.on("error", () => undefined);
    // Why the process is not there, when it is not: the closed pipe usually says so first, and
    // says less.
    let died: AcpStartError | undefined;
    const failed = new Promise<never>((_resolve, reject) => {
      child.once("error", (error) => {
        died ??= startError(launch.command, error);
        reject(died);
      });
      child.once("exit", (code, signal) => {
        died ??= new AcpStartError(
          `${launch.command} exited before it answered (${signal ?? `code ${code}`})${tail(stderr)}`,
          "error",
        );
        reject(died);
      });
    });
    // Rejections after the handshake have nobody waiting on them.
    failed.catch(() => undefined);
    const connection = acp
      .client({ name: CLIENT_INFO.name })
      .onNotification(methods.client.session.update, ({ params }) => {
        handlers.update(params);
      })
      .onRequest(
        methods.client.session.requestPermission,
        async ({ params }) => await handlers.permission(params),
      )
      .connect(
        acp.ndJsonStream(
          Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
          Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>,
        ),
      );
    connection.closed.catch(() => undefined);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const hello: InitializeRequest = {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
        clientInfo: CLIENT_INFO,
      };
      const asked = connection.agent.request(methods.agent.initialize, hello);
      const init = await Promise.race([
        asked,
        failed,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new AcpStartError(
                  `${launch.command} did not answer initialize in time${tail(stderr)}`,
                  "error",
                ),
              ),
            options.timeoutMs ?? 20_000,
          );
        }),
      ]);
      if (init.protocolVersion !== acp.PROTOCOL_VERSION)
        throw new AcpStartError(
          `${launch.command} speaks ACP protocol version ${init.protocolVersion}; eta speaks ${acp.PROTOCOL_VERSION}`,
          "error",
        );
      return new AcpProcess(child, connection, init, stderr);
    } catch (error) {
      await killTree(child);
      connection.close();
      if (died === undefined && !(error instanceof AcpStartError))
        await new Promise((resolve) => setTimeout(resolve, 100));
      void kill(child);
      if (died !== undefined) throw died;
      if (error instanceof AcpStartError) throw error;
      throw new AcpStartError(
        `${launch.command} did not answer initialize: ${messageOf(error)}${tail(stderr)}`,
        "error",
      );
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /** The process is gone, or the connection is closed: nothing more can be asked of it. */
  get lost(): boolean {
    return this.#gone || this.#connection.signal.aborted;
  }

  /** What the agent last wrote to stderr, for an error that should say why. */
  get lastWords(): string {
    return tail(this.#stderr);
  }

  get agent(): acp.ClientContext {
    return this.#connection.agent;
  }

  /** Let the process go: close its input, then make sure it ends. */
  async stop(): Promise<void> {
    this.#gone = true;
    await killTree(this.#child);
    this.#connection.close();
    await kill(this.#child);
  }
}

function startError(command: string, error: unknown): AcpStartError {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "ENOENT")
    return new AcpStartError(`${command} is not installed`, "missing");
  if (code === "EACCES")
    return new AcpStartError(`${command} cannot be executed`, "missing");
  return new AcpStartError(
    `${command} could not be started: ${messageOf(error)}`,
    "error",
  );
}

function tail(stderr: readonly string[]): string {
  return stderr.length === 0 ? "" : `: ${stderr.slice(-3).join(" | ")}`;
}

export function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "message" in error)
    return String((error as { message: unknown }).message);
  return String(error);
}

/**
 * On Windows, end a child and everything it started, and wait for that. A signal there ends only
 * the process itself, and an agent started through a shim leaves its real process behind, still
 * in the directory it was started in. It goes before the pipes are closed: a parent that has
 * exited can no longer be asked for its children. Elsewhere there is nothing to do here.
 */
async function killTree(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (process.platform !== "win32" || child.pid === undefined) return;
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    })
      .once("error", () => resolve())
      .once("close", () => resolve());
  });
}

/** End a child: its stdin first (an agent on stdio exits on EOF), then the signals. */
async function kill(child: ChildProcessWithoutNullStreams): Promise<void> {
  // One that never started has nothing to end, and will never say it exited.
  if (child.pid === undefined) return;
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const hard = setTimeout(() => child.kill("SIGKILL"), 2_000);
    child.once("exit", () => {
      clearTimeout(hard);
      resolve();
    });
    child.stdin.end();
    child.kill("SIGTERM");
  });
}
