import type { ChildProcess } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { PassThrough } from "node:stream";
import { StringDecoder } from "node:string_decoder";

export const REQUIRED_CDP_PIPE_FLAGS = [
  "--headless=new",
  "--remote-debugging-pipe",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-background-networking",
  "--disable-sync",
] as const;

export interface CdpErrorPayload {
  code: number;
  message: string;
  data?: unknown;
}

export class CdpProtocolError extends Error {
  readonly code: number;
  readonly method: string;
  readonly data?: unknown;

  constructor(method: string, payload: CdpErrorPayload) {
    super(
      `CDP error in ${method} (${String(payload.code)}): ${payload.message}`,
    );
    this.name = "CdpProtocolError";
    this.code = payload.code;
    this.method = method;
    this.data = payload.data;
  }
}

export interface CdpSendOptions {
  sessionId?: string | undefined;
  timeoutMs?: number | undefined;
  signal?: AbortSignal | undefined;
}

export type CdpEventListener<TParams = Record<string, unknown>> = (
  params: TParams,
  sessionId?: string,
) => void;

/**
 * Injectable Chrome DevTools Protocol transport interface used by `BrowserRealmDriver`.
 * Implemented by `CdpPipeConnection` for real zero-port `--remote-debugging-pipe` Chromium
 * processes and by in-memory mocks for deterministic protocol edge-case unit tests.
 */
export interface CdpTransport {
  /** How the connection reaches the browser: extra-fd pipe, or a loopback WebSocket. */
  readonly transportKind?: "pipe" | "socket" | undefined;
  /** The isolated profile the browser was started with, when it was launched here. */
  readonly userDataDir?: string | undefined;
  send: <TResult = Record<string, unknown>>(
    method: string,
    params?: Record<string, unknown>,
    options?: CdpSendOptions,
  ) => Promise<TResult>;
  on: <TParams = Record<string, unknown>>(
    event: string,
    listener: CdpEventListener<TParams>,
  ) => () => void;
  close: () => Promise<void>;
  readonly isClosed?: boolean | undefined;
}

export interface CdpPipeConnectionOptions {
  /** Writable stream connected to Chromium's fd 3 (`--remote-debugging-pipe` input). */
  writeStream: Writable;
  /** Readable stream connected to Chromium's fd 4 (`--remote-debugging-pipe` output). */
  readStream: Readable;
  /** Optional spawned Chromium child process for lifecycle tracking and teardown. */
  childProcess?: ChildProcess | undefined;
  /** Optional isolated user profile directory path. */
  userDataDir?: string | undefined;
  /** Whether `close()` should delete `userDataDir` after the browser exits. */
  cleanupUserDataDir?: boolean | undefined;
  /** Default per-command timeout in milliseconds (default: 15000). */
  defaultTimeoutMs?: number | undefined;
  /** How this connection reaches the browser; the pipe transport is the default. */
  transportKind?: "pipe" | "socket" | undefined;
  /** Optional custom teardown callback invoked during `close()`. */
  onClose?: (() => Promise<void> | void) | undefined;
}

export interface CdpPipeLaunchOptions {
  /** Explicit path to `chrome.exe` or `msedge.exe` (auto-detected if omitted). */
  executablePath?: string | undefined;
  /**
   * Which transport to use. `"auto"` (the default) uses the extra-fd pipe where the runtime can
   * hand a child file descriptors above 2, and a loopback WebSocket where it cannot (Bun).
   */
  transport?: "auto" | "pipe" | "socket" | undefined;
  /** Explicit `--user-data-dir` path (creates an isolated temp profile dir if omitted). */
  userDataDir?: string | undefined;
  /** Base directory under which temporary profile folders are created if `userDataDir` is omitted. */
  profileBaseDir?: string | undefined;
  /** Whether to remove `userDataDir` on `close()` (defaults to `true` when auto-created). */
  cleanupUserDataDir?: boolean | undefined;
  /** Initial URL passed on the command line (default: `"about:blank"`). */
  initialUrl?: string | undefined;
  /** Additional command-line flags appended after the required zero-port CDP pipe flags. */
  extraArgs?: readonly string[] | undefined;
  /** Default command timeout in milliseconds (default: 15000). */
  defaultTimeoutMs?: number | undefined;
  /** Environment variables for the browser child process. */
  env?: NodeJS.ProcessEnv | undefined;
}

export interface FindBrowserExecutableOptions {
  platform?: string | undefined;
  env?: Record<string, string | undefined> | undefined;
  preferred?: "chrome" | "edge" | undefined;
}

/**
 * Locate a local Chromium-based browser binary (`chrome.exe` or `msedge.exe` on Windows,
 * Google Chrome / Microsoft Edge / Chromium on macOS and Linux).
 */
export function findLocalBrowserExecutable(
  options: FindBrowserExecutableOptions = {},
): string | undefined {
  const platform = options.platform ?? process.platform;
  const env =
    options.env ?? (process.env as Record<string, string | undefined>);
  const preferred = options.preferred ?? "chrome";

  if (platform === "win32") {
    const programFiles = env.ProgramFiles ?? "C:\\Program Files";
    const programFilesX86 =
      env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
    const localAppData = env.LOCALAPPDATA ?? "";

    const chromeCandidates = [
      `${programFiles}\\Google\\Chrome\\Application\\chrome.exe`,
      `${programFilesX86}\\Google\\Chrome\\Application\\chrome.exe`,
      ...(localAppData
        ? [`${localAppData}\\Google\\Chrome\\Application\\chrome.exe`]
        : []),
    ];

    const edgeCandidates = [
      `${programFiles}\\Microsoft\\Edge\\Application\\msedge.exe`,
      `${programFilesX86}\\Microsoft\\Edge\\Application\\msedge.exe`,
      ...(localAppData
        ? [`${localAppData}\\Microsoft\\Edge\\Application\\msedge.exe`]
        : []),
    ];

    const ordered =
      preferred === "edge"
        ? [...edgeCandidates, ...chromeCandidates]
        : [...chromeCandidates, ...edgeCandidates];

    for (const candidate of ordered) {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
    return undefined;
  }

  if (platform === "darwin") {
    const macCandidates =
      preferred === "edge"
        ? [
            "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/Applications/Chromium.app/Contents/MacOS/Chromium",
          ]
        : [
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
            "/Applications/Chromium.app/Contents/MacOS/Chromium",
          ];
    for (const candidate of macCandidates) {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
    return undefined;
  }

  const linuxCandidates = [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/microsoft-edge",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ];
  for (const candidate of linuxCandidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

/**
 * Construct the zero-port Chromium launch argument list with `--remote-debugging-pipe` and an
 * isolated `--user-data-dir`. Rejects any `--remote-debugging-port` flag so 0 TCP ports open.
 */
export function buildCdpPipeLaunchArgs(options: {
  userDataDir: string;
  initialUrl?: string | undefined;
  extraArgs?: readonly string[] | undefined;
}): string[] {
  if (!options.userDataDir || options.userDataDir.trim().length === 0) {
    throw new Error("userDataDir must be a non-empty path");
  }

  const extra = options.extraArgs ?? [];
  for (const arg of extra) {
    if (arg.startsWith("--remote-debugging-port")) {
      throw new Error(
        `TCP debugging port flag "${arg}" is prohibited in zero-port CdpPipeConnection`,
      );
    }
  }

  return [
    ...REQUIRED_CDP_PIPE_FLAGS,
    "--disable-extensions",
    "--disable-default-apps",
    "--disable-component-update",
    "--mute-audio",
    "--no-pings",
    "-- metrics-recording-only".replace("-- ", "--"),
    "--password-store=basic",
    `--user-data-dir=${options.userDataDir}`,
    ...extra,
    options.initialUrl ?? "about:blank",
  ];
}

interface PendingRequest {
  method: string;
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
  cleanupAbort: (() => void) | undefined;
}

interface RawCdpEnvelope {
  id?: number | undefined;
  method?: string | undefined;
  params?: Record<string, unknown> | undefined;
  result?: unknown;
  error?: CdpErrorPayload | undefined;
  sessionId?: string | undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function removeDirectoryWithRetries(
  dirPath: string,
  maxAttempts = 12,
): Promise<void> {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      if (fs.existsSync(dirPath)) {
        fs.rmSync(dirPath, { recursive: true, force: true });
      }
      return;
    } catch {
      await sleep(50);
    }
  }
}

/**
 * Zero-port Chrome DevTools Protocol connection over anonymous pipes (`fd 3` write, `fd 4` read)
 * using null-delimited (`\0`) JSON-RPC framing.
 */
export class CdpPipeConnection implements CdpTransport {
  readonly transportKind: "pipe" | "socket";
  readonly userDataDir: string | undefined;
  readonly childProcess: ChildProcess | undefined;

  private readonly writeStream: Writable;
  private readonly readStream: Readable;
  private readonly cleanupUserDataDir: boolean;
  private readonly profileParentDir: string | undefined;
  private readonly defaultTimeoutMs: number;
  private readonly onCloseCallback: (() => Promise<void> | void) | undefined;
  private readonly decoder = new StringDecoder("utf8");
  private readBuffer = "";
  private nextRequestId = 1;
  private closed = false;
  private closePromise: Promise<void> | null = null;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly listeners = new Map<
    string,
    Set<CdpEventListener<Record<string, unknown>>>
  >();

  constructor(
    options: CdpPipeConnectionOptions & {
      profileParentDir?: string | undefined;
    },
  ) {
    this.writeStream = options.writeStream;
    this.readStream = options.readStream;
    this.childProcess = options.childProcess;
    this.userDataDir = options.userDataDir;
    this.cleanupUserDataDir = options.cleanupUserDataDir ?? false;
    this.profileParentDir = options.profileParentDir;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 15_000;
    this.onCloseCallback = options.onClose;
    this.transportKind = options.transportKind ?? "pipe";

    this.readStream.on("data", (chunk: Buffer | string) => {
      this.handleChunk(chunk);
    });

    this.readStream.on("error", (err: Error) => {
      this.rejectAllPending(new Error(`CDP pipe read error: ${err.message}`));
    });

    this.readStream.on("close", () => {
      this.rejectAllPending(new Error("CDP pipe closed"));
    });

    this.writeStream.on("error", (err: Error) => {
      this.rejectAllPending(new Error(`CDP pipe write error: ${err.message}`));
    });

    if (this.childProcess) {
      this.childProcess.on("exit", (code, signal) => {
        this.rejectAllPending(
          new Error(
            `Browser process exited (code=${String(code)}, signal=${String(signal)})`,
          ),
        );
      });
      this.childProcess.on("error", (err: Error) => {
        this.rejectAllPending(
          new Error(`Browser process error: ${err.message}`),
        );
      });
    }
  }

  /**
   * Spawn a local headless Chrome or Edge browser using `--remote-debugging-pipe` (`fd 3` & `fd 4`)
   * with an isolated `--user-data-dir` and 0 TCP ports.
   */
  static launch(options: CdpPipeLaunchOptions = {}): CdpPipeConnection {
    const executablePath =
      options.executablePath ?? findLocalBrowserExecutable();
    if (!executablePath) {
      throw new Error(
        "No local Chromium browser (chrome.exe or msedge.exe) found for CdpPipeConnection",
      );
    }

    let profileParentDir: string | undefined;
    let userDataDir = options.userDataDir;
    let cleanupUserDataDir = options.cleanupUserDataDir;

    if (!userDataDir) {
      profileParentDir =
        options.profileBaseDir ?? path.join(process.cwd(), ".eta-cdp-profiles");
      fs.mkdirSync(profileParentDir, { recursive: true });
      userDataDir = path.join(profileParentDir, `profile-${randomUUID()}`);
      fs.mkdirSync(userDataDir, { recursive: true });
      if (cleanupUserDataDir === undefined) {
        cleanupUserDataDir = true;
      }
    } else {
      fs.mkdirSync(userDataDir, { recursive: true });
      if (cleanupUserDataDir === undefined) {
        cleanupUserDataDir = false;
      }
    }

    const args = buildCdpPipeLaunchArgs({
      userDataDir,
      initialUrl: options.initialUrl,
      extraArgs: options.extraArgs,
    });

    const child = spawn(executablePath, args, {
      stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"],
      env: options.env ?? process.env,
      windowsHide: true,
    });

    const pipeWrite = child.stdio[3] as Writable | null | undefined;
    const pipeRead = child.stdio[4] as Readable | null | undefined;

    if (!pipeWrite || !pipeRead) {
      child.kill();
      throw new Error("Failed to open CDP pipe file descriptors 3 and 4");
    }

    // Drain stderr if present so the child never blocks on a full stderr pipe buffer
    const stderr = child.stdio[2] as Readable | null | undefined;
    if (stderr) {
      stderr.resume();
    }

    return new CdpPipeConnection({
      writeStream: pipeWrite,
      readStream: pipeRead,
      childProcess: child,
      userDataDir,
      cleanupUserDataDir,
      profileParentDir,
      defaultTimeoutMs: options.defaultTimeoutMs,
    });
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /**
   * Send a CDP command over `fd 3` with a trailing `\0` byte and await its matching response.
   */
  send<TResult = Record<string, unknown>>(
    method: string,
    params?: Record<string, unknown>,
    options: CdpSendOptions = {},
  ): Promise<TResult> {
    if (this.closed) {
      return Promise.reject(
        new Error(`Cannot send "${method}": CDP connection is closed`),
      );
    }
    if (options.signal?.aborted) {
      return Promise.reject(
        options.signal.reason instanceof Error
          ? options.signal.reason
          : new Error(`CDP command "${method}" aborted before send`),
      );
    }

    const id = this.nextRequestId++;
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;

    return new Promise<TResult>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let cleanupAbort: (() => void) | undefined;

      if (timeoutMs > 0 && Number.isFinite(timeoutMs)) {
        timer = setTimeout(() => {
          const entry = this.pending.get(id);
          if (entry) {
            this.pending.delete(id);
            entry.cleanupAbort?.();
            reject(
              new Error(
                `CDP command "${method}" timed out after ${String(timeoutMs)}ms`,
              ),
            );
          }
        }, timeoutMs);
      }

      if (options.signal) {
        const onAbort = (): void => {
          const entry = this.pending.get(id);
          if (entry) {
            this.pending.delete(id);
            if (entry.timer) clearTimeout(entry.timer);
            const reason = options.signal?.reason;
            reject(
              reason instanceof Error
                ? reason
                : new Error(`CDP command "${method}" aborted`),
            );
          }
        };
        options.signal.addEventListener("abort", onAbort, { once: true });
        cleanupAbort = () => {
          options.signal?.removeEventListener("abort", onAbort);
        };
      }

      this.pending.set(id, {
        method,
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
        cleanupAbort,
      });

      const envelope: Record<string, unknown> = {
        id,
        method,
        params: params ?? {},
      };
      if (options.sessionId !== undefined) {
        envelope.sessionId = options.sessionId;
      }

      const raw = `${JSON.stringify(envelope)}\0`;
      try {
        this.writeStream.write(raw, "utf8", (err) => {
          if (err) {
            const entry = this.pending.get(id);
            if (entry) {
              this.pending.delete(id);
              if (entry.timer) clearTimeout(entry.timer);
              entry.cleanupAbort?.();
              reject(
                new Error(
                  `Failed to write CDP command "${method}": ${err.message}`,
                ),
              );
            }
          }
        });
      } catch (err) {
        const entry = this.pending.get(id);
        if (entry) {
          this.pending.delete(id);
          if (entry.timer) clearTimeout(entry.timer);
          entry.cleanupAbort?.();
        }
        reject(
          err instanceof Error
            ? err
            : new Error(`Failed to write CDP command "${method}"`),
        );
      }
    });
  }

  /**
   * Subscribe to a CDP event by method name (or `"*"` for all events).
   * Returns an unsubscribe function.
   */
  on<TParams = Record<string, unknown>>(
    event: string,
    listener: CdpEventListener<TParams>,
  ): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    const typedListener = listener as CdpEventListener<Record<string, unknown>>;
    set.add(typedListener);
    return () => {
      set?.delete(typedListener);
      if (set && set.size === 0) {
        this.listeners.delete(event);
      }
    };
  }

  /**
   * Discover or create a top-level `"page"` target and attach a flattened CDP session to it.
   */
  async attachToPageTarget(
    initialUrl = "about:blank",
  ): Promise<{ targetId: string; sessionId: string }> {
    const targetsResult = await this.send<{
      targetInfos?: Array<{ targetId: string; type: string; url: string }>;
    }>("Target.getTargets");

    const existingPage = targetsResult.targetInfos?.find(
      (t) => t.type === "page",
    );
    let targetId: string;
    if (existingPage) {
      targetId = existingPage.targetId;
    } else {
      const created = await this.send<{ targetId: string }>(
        "Target.createTarget",
        {
          url: initialUrl,
        },
      );
      targetId = created.targetId;
    }

    const attached = await this.send<{ sessionId: string }>(
      "Target.attachToTarget",
      {
        targetId,
        flatten: true,
      },
    );

    return {
      targetId,
      sessionId: attached.sessionId,
    };
  }

  /**
   * Gracefully close the browser (`Browser.close`), close fd 3/4, terminate the process if still
   * running, and clean up the temporary `--user-data-dir`.
   */
  async close(): Promise<void> {
    if (this.closePromise) {
      return this.closePromise;
    }
    this.closePromise = this.performClose();
    return this.closePromise;
  }

  private async performClose(): Promise<void> {
    if (!this.closed) {
      try {
        if (this.writeStream.writable && !this.writeStream.destroyed) {
          await this.send("Browser.close", {}, { timeoutMs: 1_500 });
        }
      } catch {
        // Ignore if Browser.close fails because the process is already exiting
      }
      this.closed = true;
    }

    this.rejectAllPending(new Error("CDP connection closed"));

    try {
      if (!this.writeStream.destroyed) {
        this.writeStream.end();
        this.writeStream.destroy();
      }
    } catch {
      // Ignore stream close errors
    }

    try {
      if (!this.readStream.destroyed) {
        this.readStream.destroy();
      }
    } catch {
      // Ignore stream close errors
    }

    if (this.childProcess) {
      const proc = this.childProcess;
      if (proc.exitCode === null && proc.signalCode === null) {
        const exitedGracefully = await new Promise<boolean>((resolve) => {
          const timer = setTimeout(resolve, 1_500, false);
          proc.once("exit", () => {
            clearTimeout(timer);
            resolve(true);
          });
        });

        if (!exitedGracefully && proc.exitCode === null) {
          try {
            proc.kill();
          } catch {
            // Process may have just exited
          }
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, 1_500);
            proc.once("exit", () => {
              clearTimeout(timer);
              resolve();
            });
          });
        }
      }
    }

    if (this.onCloseCallback) {
      await this.onCloseCallback();
    }

    if (this.cleanupUserDataDir && this.userDataDir) {
      await removeDirectoryWithRetries(this.userDataDir);
      if (this.profileParentDir) {
        try {
          if (
            fs.existsSync(this.profileParentDir) &&
            fs.readdirSync(this.profileParentDir).length === 0
          ) {
            fs.rmdirSync(this.profileParentDir);
          }
        } catch {
          // Ignore if another profile is active in profileParentDir
        }
      }
    }
  }

  private handleChunk(chunk: Buffer | string): void {
    const text = typeof chunk === "string" ? chunk : this.decoder.write(chunk);
    this.readBuffer += text;

    let nullIndex = this.readBuffer.indexOf("\0");
    while (nullIndex !== -1) {
      const frame = this.readBuffer.slice(0, nullIndex);
      this.readBuffer = this.readBuffer.slice(nullIndex + 1);
      if (frame.trim().length > 0) {
        this.handleRawFrame(frame);
      }
      nullIndex = this.readBuffer.indexOf("\0");
    }
  }

  private handleRawFrame(frame: string): void {
    let message: RawCdpEnvelope;
    try {
      message = JSON.parse(frame) as RawCdpEnvelope;
    } catch {
      return;
    }

    if (typeof message.id === "number") {
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      if (entry.timer) clearTimeout(entry.timer);
      entry.cleanupAbort?.();

      if (message.error) {
        entry.reject(new CdpProtocolError(entry.method, message.error));
      } else {
        entry.resolve(message.result ?? {});
      }
      return;
    }

    if (typeof message.method === "string") {
      const params = message.params ?? {};
      const specific = this.listeners.get(message.method);
      if (specific) {
        for (const listener of [...specific]) {
          listener(params, message.sessionId);
        }
      }
      const wildcard = this.listeners.get("*");
      if (wildcard) {
        for (const listener of [...wildcard]) {
          listener(
            { method: message.method, params, sessionId: message.sessionId },
            message.sessionId,
          );
        }
      }
    }
  }

  private rejectAllPending(error: Error): void {
    for (const [id, entry] of this.pending.entries()) {
      this.pending.delete(id);
      if (entry.timer) clearTimeout(entry.timer);
      entry.cleanupAbort?.();
      entry.reject(error);
    }
  }
}

/** Flags for the loopback-WebSocket transport: the port is ephemeral and loopback-only. */
export const REQUIRED_CDP_SOCKET_FLAGS = [
  "--headless=new",
  "--remote-debugging-port=0",
  "--remote-debugging-address=127.0.0.1",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-background-networking",
  "--disable-sync",
] as const;

export function buildCdpSocketLaunchArgs(options: {
  userDataDir: string;
  initialUrl?: string | undefined;
  extraArgs?: readonly string[] | undefined;
}): string[] {
  if (!options.userDataDir || options.userDataDir.trim().length === 0) {
    throw new Error("userDataDir must be a non-empty path");
  }
  const extra = options.extraArgs ?? [];
  for (const arg of extra) {
    // Any port the caller names would defeat the ephemeral one picked here.
    if (arg.startsWith("--remote-debugging-port")) {
      throw new Error(
        `TCP debugging port flag "${arg}" is not allowed; the socket transport picks its own ephemeral port`,
      );
    }
  }
  return [
    ...REQUIRED_CDP_SOCKET_FLAGS,
    "--disable-extensions",
    "--disable-default-apps",
    "--disable-component-update",
    "--mute-audio",
    "--no-pings",
    "--metrics-recording-only",
    "--password-store=basic",
    `--user-data-dir=${options.userDataDir}`,
    ...extra,
    options.initialUrl ?? "about:blank",
  ];
}

/**
 * CDP over the browser's loopback WebSocket endpoint.
 *
 * `--remote-debugging-pipe` needs a runtime that can hand a child usable descriptors 3 and 4.
 * Node can; Bun hands back placeholder sockets that never reach the browser, so on Bun (the
 * runtime eta's host is built on) the same JSON-RPC runs over an ephemeral 127.0.0.1 port that
 * the browser writes into `DevToolsActivePort`. The port is loopback-only, lives exactly as long
 * as this realm's browser process, and is never fixed or reused.
 *
 * The bookkeeping (ids, pending requests, events, timeouts) is inherited from
 * {@link CdpPipeConnection}: this class only swaps the byte transport underneath it.
 */
export class CdpSocketConnection extends CdpPipeConnection {
  private readonly socket: WebSocket;

  /** The loopback endpoint this connection talks to (ephemeral, loopback only). */
  readonly endpoint: string;

  constructor(options: {
    socket: WebSocket;
    endpoint: string;
    childProcess: ChildProcess;
    userDataDir: string;
    cleanupUserDataDir: boolean;
    profileParentDir?: string | undefined;
    defaultTimeoutMs?: number | undefined;
  }) {
    const toBrowser = new PassThrough();
    const fromBrowser = new PassThrough();
    super({
      writeStream: toBrowser,
      readStream: fromBrowser,
      childProcess: options.childProcess,
      userDataDir: options.userDataDir,
      cleanupUserDataDir: options.cleanupUserDataDir,
      transportKind: "socket",
      ...(options.profileParentDir === undefined
        ? {}
        : { profileParentDir: options.profileParentDir }),
      ...(options.defaultTimeoutMs === undefined
        ? {}
        : { defaultTimeoutMs: options.defaultTimeoutMs }),
      onClose: () => {
        try {
          options.socket.close();
        } catch {
          // Already closed with the browser.
        }
      },
    });
    this.socket = options.socket;
    this.endpoint = options.endpoint;

    // Pipe framing is null-delimited; each WebSocket message carries one whole envelope.
    toBrowser.on("data", (chunk: Buffer | string) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      for (const frame of text.split("\0")) {
        if (frame.trim().length > 0 && this.socket.readyState === 1) {
          this.socket.send(frame);
        }
      }
    });

    this.socket.addEventListener("message", (event: MessageEvent) => {
      const data = event.data;
      fromBrowser.write(
        typeof data === "string"
          ? `${data}\0`
          : Buffer.from(data as ArrayBuffer),
      );
      if (typeof data !== "string") fromBrowser.write("\0");
    });
    this.socket.addEventListener("close", () => {
      fromBrowser.end();
    });
  }
}

/**
 * Spawn a browser with an ephemeral loopback debugging port and attach over WebSocket.
 *
 * Kept out of the class's static side: a subclass whose `launch` returned a different type would
 * not be a `typeof CdpPipeConnection`.
 */
export async function launchCdpSocketConnection(
  options: CdpPipeLaunchOptions = {},
): Promise<CdpSocketConnection> {
  const executablePath = options.executablePath ?? findLocalBrowserExecutable();
  if (!executablePath) {
    throw new Error(
      "No local Chromium browser (chrome.exe or msedge.exe) found for CdpSocketConnection",
    );
  }

  let profileParentDir: string | undefined;
  let userDataDir = options.userDataDir;
  let cleanupUserDataDir = options.cleanupUserDataDir;

  if (!userDataDir) {
    profileParentDir =
      options.profileBaseDir ?? path.join(process.cwd(), ".eta-cdp-profiles");
    fs.mkdirSync(profileParentDir, { recursive: true });
    userDataDir = path.join(profileParentDir, `profile-${randomUUID()}`);
    fs.mkdirSync(userDataDir, { recursive: true });
    cleanupUserDataDir ??= true;
  } else {
    fs.mkdirSync(userDataDir, { recursive: true });
    cleanupUserDataDir ??= false;
  }

  const args = buildCdpSocketLaunchArgs({
    userDataDir,
    initialUrl: options.initialUrl,
    extraArgs: options.extraArgs,
  });

  const child = spawn(executablePath, args, {
    stdio: ["ignore", "ignore", "pipe"],
    env: options.env ?? process.env,
    windowsHide: true,
  });
  (child.stdio[2] as Readable | null | undefined)?.resume();

  const activePortFile = path.join(userDataDir, "DevToolsActivePort");
  const endpoint = await waitForDevToolsEndpoint(
    activePortFile,
    options.defaultTimeoutMs ?? 15_000,
  ).catch(async (error: unknown) => {
    child.kill();
    throw error instanceof Error
      ? error
      : new Error("Browser did not open a debugging port");
  });

  const socket = await openCdpSocket(
    endpoint,
    options.defaultTimeoutMs ?? 15_000,
  ).catch((error: unknown) => {
    child.kill();
    throw error instanceof Error ? error : new Error("CDP socket failed");
  });

  return new CdpSocketConnection({
    socket,
    endpoint,
    childProcess: child,
    userDataDir,
    cleanupUserDataDir,
    ...(profileParentDir === undefined ? {} : { profileParentDir }),
    ...(options.defaultTimeoutMs === undefined
      ? {}
      : { defaultTimeoutMs: options.defaultTimeoutMs }),
  });
}

/** Read `DevToolsActivePort` (port, then browser path) until the browser writes it. */
async function waitForDevToolsEndpoint(
  activePortFile: string,
  timeoutMs: number,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const [port, wsPath] = fs
        .readFileSync(activePortFile, "utf8")
        .split("\n")
        .map((line) => line.trim());
      if (port && wsPath) return `ws://127.0.0.1:${port}${wsPath}`;
    } catch {
      // Not written yet.
    }
    if (Date.now() > deadline) {
      throw new Error(
        `CDP debugging endpoint did not appear within ${String(timeoutMs)}ms`,
      );
    }
    await sleep(50);
  }
}

function openCdpSocket(url: string, timeoutMs: number): Promise<WebSocket> {
  return new Promise<WebSocket>((resolve, reject) => {
    const socket = new WebSocket(url);
    const timer = setTimeout(() => {
      socket.close();
      reject(
        new Error(`CDP socket did not open within ${String(timeoutMs)}ms`),
      );
    }, timeoutMs);
    socket.addEventListener(
      "open",
      () => {
        clearTimeout(timer);
        resolve(socket);
      },
      { once: true },
    );
    socket.addEventListener(
      "error",
      () => {
        clearTimeout(timer);
        reject(new Error("CDP socket failed to open"));
      },
      { once: true },
    );
  });
}

/**
 * Whether this runtime can hand a child process usable descriptors above stderr. Bun cannot:
 * `child.stdio[3]` is a placeholder that never reaches the browser, so pipe mode would hang until
 * every command timed out.
 */
export function runtimeSupportsExtraPipes(): boolean {
  return typeof (globalThis as { Bun?: unknown }).Bun === "undefined";
}

/**
 * Launch the transport this runtime can actually use. Returns a connection whose
 * `transportKind` says which one it is, so callers (and the realm view) can report it honestly.
 */
export function launchCdpConnection(
  options: CdpPipeLaunchOptions = {},
): Promise<CdpTransport> {
  const wanted = options.transport ?? "auto";
  const useSocket =
    wanted === "socket" || (wanted === "auto" && !runtimeSupportsExtraPipes());
  return useSocket
    ? launchCdpSocketConnection(options)
    : Promise.resolve(CdpPipeConnection.launch(options));
}
