/**
 * Managed `cloudflared` tunnel for Tailscale-free HTTPS access to a loopback host.
 *
 * `eta-host` stays bound to `127.0.0.1:<port>` while `cloudflared` opens outbound connections to
 * Cloudflare's edge — nothing binds `:443` or collides with existing host services.
 *
 * Two modes:
 * - **Quick Tunnel** (`--tunnel`): ephemeral `https://<slug>.trycloudflare.com` URL parsed from
 *   `cloudflared`'s stdout/stderr (both banner text and JSON lines), zero Cloudflare account needed.
 * - **Named Tunnel** (`--tunnel-token` / `ETA_TUNNEL_TOKEN`): connects an existing tunnel using
 *   `TUNNEL_TOKEN` in the child process environment (never CLI argv, so `ps` does not expose it),
 *   paired with `--public-url` / `ETA_PUBLIC_URL` for the external URL.
 */
import { spawn } from "node:child_process";
import process from "node:process";

export type TunnelConfig =
  | { readonly mode: "quick" }
  | {
      readonly mode: "named";
      readonly token: string;
      readonly publicUrl?: string | undefined;
    };

/** Minimal child-process handle required by the tunnel manager (satisfied by `ChildProcess`). */
export interface TunnelChild {
  readonly stdout: NodeJS.ReadableStream | null;
  readonly stderr: NodeJS.ReadableStream | null;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  kill: (signal?: NodeJS.Signals | number) => boolean;
  on: ((event: "error", listener: (error: Error) => void) => unknown) &
    ((
      event: "exit",
      listener: (code: number | null, signal: NodeJS.Signals | null) => void,
    ) => unknown);
  off: ((event: "error", listener: (error: Error) => void) => unknown) &
    ((
      event: "exit",
      listener: (code: number | null, signal: NodeJS.Signals | null) => void,
    ) => unknown);
}

export type TunnelSpawn = (
  command: string,
  args: readonly string[],
  options: {
    stdio: ["ignore", "pipe", "pipe"];
    env: NodeJS.ProcessEnv;
  },
) => TunnelChild;

export interface CloudflaredTunnelOptions {
  config: TunnelConfig;
  /** Local HTTP origin to forward traffic to, e.g. `http://127.0.0.1:8787`. */
  targetUrl: string;
  /** `cloudflared` executable name or absolute path. Defaults to `"cloudflared"`. */
  binary?: string | undefined;
  /** Maximum time to wait for tunnel readiness, in milliseconds. Defaults to 30_000. */
  startupTimeoutMs?: number | undefined;
  /** Grace period between `SIGTERM` and `SIGKILL` during `stop()`, in milliseconds. Defaults to 5_000. */
  stopGraceMs?: number | undefined;
  /** Base environment for the child process. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv | undefined;
  /** Injectable process spawner for deterministic tests. */
  spawn?: TunnelSpawn | undefined;
  /** Non-fatal warnings (e.g. missing `--public-url` or unexpected exit after startup). */
  warn?: ((message: string) => void) | undefined;
  /** Called if `cloudflared` exits unexpectedly after startup (never called on `stop()`). */
  onExit?:
    | ((details: {
        code: number | null;
        signal: NodeJS.Signals | null;
      }) => void)
    | undefined;
}

export interface ManagedTunnel {
  readonly mode: "quick" | "named";
  /** External HTTPS origin of the tunnel, when known. */
  readonly url: string | undefined;
  /** Stop the `cloudflared` child process cleanly (`SIGTERM` then `SIGKILL` fallback). */
  stop: () => Promise<void>;
}

const DEFAULT_BINARY = "cloudflared";
const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
const DEFAULT_STOP_GRACE_MS = 5_000;
const EXIT_DRAIN_MS = 50;
const MAX_RECENT_LINES = 12;

const QUICK_TUNNEL_URL_RE =
  /https:\/\/([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)\.trycloudflare\.com(?![a-z0-9.-])(?::\d+)?(?:\/[^\s"'`|)}\]]*)?/gi;
const RESERVED_TRYCLOUDFLARE_SUBDOMAINS = new Set(["api", "www", "update"]);
const NAMED_TUNNEL_READY_RE =
  /registered tunnel connection|connection\s+\S+\s+registered/i;

const defaultSpawn: TunnelSpawn = (command, args, options) =>
  spawn(command, [...args], options);

function errorCodeOf(error: unknown): string | undefined {
  if (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }
  return undefined;
}

function isProcessGoneError(error: unknown): boolean {
  const code = errorCodeOf(error);
  return code === "ESRCH" || code === "EPERM";
}

function formatSpawnError(binary: string, error: unknown): Error {
  const code = errorCodeOf(error);
  if (code === "ENOENT") {
    return new Error(
      `cloudflared is not installed or not on PATH (could not run "${binary}"). Install cloudflared (https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) and retry.`,
    );
  }
  const detail = error instanceof Error ? error.message : String(error);
  return new Error(`failed to start cloudflared ("${binary}"): ${detail}`);
}

function redactSecret(text: string, secret: string | undefined): string {
  if (secret === undefined || secret === "") return text;
  return text.split(secret).join("***");
}

function collectStrings(value: unknown, out: string[]): void {
  if (typeof value === "string") {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out);
  } else if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) collectStrings(item, out);
  }
}

function findQuickTunnelOriginInText(text: string): string | undefined {
  QUICK_TUNNEL_URL_RE.lastIndex = 0;
  for (const match of text.matchAll(QUICK_TUNNEL_URL_RE)) {
    const raw = match[0];
    const label = match[1]?.toLowerCase();
    if (label === undefined || RESERVED_TRYCLOUDFLARE_SUBDOMAINS.has(label)) {
      continue;
    }
    try {
      const parsed = new URL(raw);
      if (parsed.protocol === "https:") return parsed.origin;
    } catch {
      // Keep scanning in case a later token is a valid URL.
    }
  }
  return undefined;
}

/**
 * Parse a `https://<slug>.trycloudflare.com` origin from one line of `cloudflared` output.
 * Supports both the standard ASCII banner and structured JSON log lines, while ignoring
 * Cloudflare's own API hostnames such as `api.trycloudflare.com`.
 */
export function extractQuickTunnelUrl(line: string): string | undefined {
  const trimmed = line.trim();
  if (trimmed === "") return undefined;
  if (trimmed.startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      const strings: string[] = [];
      collectStrings(parsed, strings);
      for (const text of strings) {
        const found = findQuickTunnelOriginInText(text);
        if (found !== undefined) return found;
      }
    } catch {
      // Not valid JSON; fall back to plain-text scanning.
    }
  }
  return findQuickTunnelOriginInText(trimmed);
}

/**
 * Detect when `cloudflared tunnel run` has registered at least one edge connection.
 * Supports both text logs and JSON log lines.
 */
export function isNamedTunnelReadyLine(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed === "") return false;
  if (trimmed.startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      const strings: string[] = [];
      collectStrings(parsed, strings);
      if (strings.some((text) => NAMED_TUNNEL_READY_RE.test(text))) {
        return true;
      }
    } catch {
      // Not valid JSON; fall back to plain-text scanning.
    }
  }
  return NAMED_TUNNEL_READY_RE.test(trimmed);
}

/** Validate and normalize a tunnel `--public-url` to its `http(s)://host[:port]` origin. */
export function normalizeTunnelPublicUrl(raw: string): string {
  const trimmed = raw.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`invalid --public-url for tunnel: ${raw}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      `invalid --public-url for tunnel (must use http or https): ${raw}`,
    );
  }
  return parsed.origin;
}

function resolveNamedConfig(
  config: Extract<TunnelConfig, { mode: "named" }>,
  warn: (message: string) => void,
): { token: string; externalUrl: string | undefined } {
  const token = config.token.trim();
  if (token === "") {
    throw new Error("cloudflared named tunnel requires a non-empty token");
  }
  if (config.publicUrl === undefined || config.publicUrl.trim() === "") {
    warn(
      "[eta] cloudflared named tunnel started without --public-url (or ETA_PUBLIC_URL); set it so pairing links and origin checks know your external URL.",
    );
    return { token, externalUrl: undefined };
  }
  const externalUrl = normalizeTunnelPublicUrl(config.publicUrl);
  if (!externalUrl.startsWith("https://")) {
    warn(
      `[eta] --public-url (${externalUrl}) for cloudflared tunnel is not https://; browsers and mobile clients expect https://.`,
    );
  }
  return { token, externalUrl };
}

/**
 * Start a managed `cloudflared` tunnel and resolve once it is ready.
 * Caller owns stopping the returned handle (e.g. from `host.close()`).
 */
export async function startCloudflaredTunnel(
  options: CloudflaredTunnelOptions,
): Promise<ManagedTunnel> {
  const binary = options.binary ?? DEFAULT_BINARY;
  const startupTimeoutMs =
    options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
  const stopGraceMs = options.stopGraceMs ?? DEFAULT_STOP_GRACE_MS;
  const spawnFn = options.spawn ?? defaultSpawn;
  const warn = options.warn ?? (() => undefined);

  let args: string[];
  const childEnv: NodeJS.ProcessEnv = { ...(options.env ?? process.env) };
  delete childEnv.ETA_TUNNEL_TOKEN;

  let secretToken: string | undefined;
  let namedExternalUrl: string | undefined;

  if (options.config.mode === "quick") {
    delete childEnv.TUNNEL_TOKEN;
    args = ["tunnel", "--no-autoupdate", "--url", options.targetUrl];
  } else {
    const resolved = resolveNamedConfig(options.config, warn);
    secretToken = resolved.token;
    namedExternalUrl = resolved.externalUrl;
    // Pass the tunnel token strictly via child process env, never CLI argv.
    childEnv.TUNNEL_TOKEN = resolved.token;
    args = ["tunnel", "--no-autoupdate", "run"];
  }

  let child: TunnelChild;
  try {
    child = spawnFn(binary, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: childEnv,
    });
  } catch (error) {
    throw formatSpawnError(binary, error);
  }

  let exited = child.exitCode !== null || child.signalCode !== null;
  let stopping = false;
  let stopPromise: Promise<void> | undefined;

  const stop = (): Promise<void> => {
    stopping = true;
    if (exited || child.exitCode !== null || child.signalCode !== null) {
      exited = true;
      return Promise.resolve();
    }
    stopPromise ??= new Promise<void>((resolve) => {
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const finish = (): void => {
        exited = true;
        if (killTimer !== undefined) {
          clearTimeout(killTimer);
          killTimer = undefined;
        }
        child.off("exit", finish);
        child.off("error", finish);
        resolve();
      };
      child.on("exit", finish);
      child.on("error", finish);
      try {
        child.kill("SIGTERM");
      } catch (error) {
        if (isProcessGoneError(error)) {
          finish();
          return;
        }
      }
      if (exited || child.exitCode !== null || child.signalCode !== null) {
        finish();
        return;
      }
      killTimer = setTimeout(() => {
        killTimer = undefined;
        if (exited || child.exitCode !== null || child.signalCode !== null) {
          finish();
          return;
        }
        try {
          child.kill("SIGKILL");
        } catch (error) {
          if (isProcessGoneError(error)) {
            finish();
          }
        }
      }, stopGraceMs);
    });
    return stopPromise;
  };

  return await new Promise<ManagedTunnel>((resolve, reject) => {
    let settled = false;
    const recentLines: string[] = [];
    const streamEndPromises: Promise<void>[] = [];
    let startupTimer: ReturnType<typeof setTimeout> | undefined;

    const recordLine = (line: string): void => {
      const cleaned = redactSecret(line.trim(), secretToken);
      if (cleaned === "") return;
      recentLines.push(cleaned);
      if (recentLines.length > MAX_RECENT_LINES) {
        recentLines.splice(0, recentLines.length - MAX_RECENT_LINES);
      }
    };

    const tailSummary = (): string => {
      if (recentLines.length === 0) return "";
      return `: ${recentLines.slice(-4).join(" | ")}`;
    };

    const clearStartupTimer = (): void => {
      if (startupTimer !== undefined) {
        clearTimeout(startupTimer);
        startupTimer = undefined;
      }
    };

    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      clearStartupTimer();
      reject(error);
    };

    const succeed = (url: string | undefined): void => {
      if (settled) return;
      settled = true;
      clearStartupTimer();
      resolve({
        mode: options.config.mode,
        url,
        stop,
      });
    };

    const handleLine = (line: string): void => {
      recordLine(line);
      if (settled || exited) return;
      if (options.config.mode === "quick") {
        const discovered = extractQuickTunnelUrl(line);
        if (discovered !== undefined) {
          succeed(discovered);
        }
      } else if (isNamedTunnelReadyLine(line)) {
        succeed(namedExternalUrl);
      }
    };

    const attachStream = (stream: NodeJS.ReadableStream | null): void => {
      if (stream === null) return;
      let remainder = "";
      streamEndPromises.push(
        new Promise<void>((done) => {
          const flush = (): void => {
            if (remainder !== "") {
              const tail = remainder;
              remainder = "";
              handleLine(tail);
            }
            done();
          };
          stream.on("data", (chunk: unknown) => {
            remainder += typeof chunk === "string" ? chunk : String(chunk);
            const parts = remainder.split(/\r?\n/);
            remainder = parts.pop() ?? "";
            for (const line of parts) handleLine(line);
          });
          stream.on("end", flush);
          stream.on("close", flush);
          stream.on("error", flush);
        }),
      );
    };

    attachStream(child.stdout);
    attachStream(child.stderr);

    child.on("error", (error: Error) => {
      if (!settled) {
        fail(formatSpawnError(binary, error));
        return;
      }
      if (!stopping) {
        warn(
          `[eta] cloudflared tunnel error: ${redactSecret(error.message, secretToken)}`,
        );
      }
    });

    child.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
      exited = true;
      const reason =
        signal !== null ? `signal ${signal}` : `exit code ${code ?? "unknown"}`;
      const drainOutput = (): Promise<void> =>
        streamEndPromises.length === 0
          ? Promise.resolve()
          : Promise.race([
              Promise.all(streamEndPromises).then(() => undefined),
              new Promise<void>((done) => setTimeout(done, EXIT_DRAIN_MS)),
            ]);
      if (!settled) {
        void drainOutput().then(() => {
          fail(
            new Error(
              `cloudflared exited before tunnel was ready (${reason})${tailSummary()}`,
            ),
          );
        });
        return;
      }
      if (!stopping) {
        void drainOutput().then(() => {
          warn(
            `[eta] cloudflared tunnel exited unexpectedly (${reason})${tailSummary()}`,
          );
          options.onExit?.({ code, signal });
        });
      }
    });

    startupTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      startupTimer = undefined;
      void stop().finally(() => {
        reject(
          new Error(
            `timed out waiting for cloudflared tunnel after ${startupTimeoutMs}ms${tailSummary()}`,
          ),
        );
      });
    }, startupTimeoutMs);
  });
}
