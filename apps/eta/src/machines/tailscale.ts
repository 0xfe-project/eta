/**
 * What Tailscale on this computer knows and serves: the nodes of the tailnet, who is behind an
 * address, and Tailscale Serve HTTPS configuration.
 *
 * Read through the `tailscale` command (`status --json`, `whois --json`, `ip -4`, `serve`), which
 * every platform has and whose JSON is stable; there is no JavaScript SDK for the local node. On
 * macOS the command lives inside the app when it is not on the PATH. No command, or a node that is
 * not up, is "no tailnet": discovery is empty and nobody is let in on the tailnet's word.
 *
 * Tailscale Serve management, route/holder parsing, stderr classification, and HTTPS probing are
 * adapted from pingdotgg/t3code (`packages/tailscale/src/tailscale.ts`,
 * `apps/server/src/cli/pair.ts`; Copyright (c) 2026 T3 Tools Inc., MIT).
 */
import type { ClientRequest, IncomingMessage } from "node:http";
import type { RequestOptions } from "node:https";
import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import https from "node:https";
import net from "node:net";
import process from "node:process";
import {
  formatHostForUrl,
  isLoopbackHost,
  isTailscaleInterface,
  isTailscaleIpv4Address,
  isTailscaleIpv6Address,
  normalizeHostname,
} from "./direct-endpoints";

export { isTailscaleInterface, isTailscaleIpv4Address, isTailscaleIpv6Address };

export const DEFAULT_TAILSCALE_SERVE_PORT = 443;

const TAILSCALE_STATUS_TIMEOUT_MS = 3_500;
const TAILSCALE_SERVE_TIMEOUT_MS = 10_000;
const TAILSCALE_KILL_GRACE_MS = 500;
export const TAILSCALE_PROBE_TIMEOUT_MS = 8_000;
export const TAILSCALE_PROBE_ATTEMPTS = 5;
export const TAILSCALE_PROBE_RETRY_DELAY_MS = 1_000;
const LISTENER_PROBE_TIMEOUT_MS = 500;
const MAX_PROBE_BODY_BYTES = 16 * 1024;
const MAX_STDOUT_BYTES = 16 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;

/**
 * Failure kinds we can name without quoting the CLI. Anything unrecognized becomes `"unknown"`
 * rather than falling back to raw text — stderr can contain auth keys (`tskey-…`) and node names.
 */
export type TailscaleStderrDiagnostic =
  | "no-existing-handler"
  | "not-logged-in"
  | "not-running"
  | "permission-denied"
  | "unsupported-target"
  | "unknown";

const STDERR_DIAGNOSTIC_PATTERNS: ReadonlyArray<
  readonly [RegExp, Exclude<TailscaleStderrDiagnostic, "unknown">]
> = [
  [/handler does not exist/i, "no-existing-handler"],
  [/not logged in|logged out|needs? login/i, "not-logged-in"],
  // Only answers that confirm no daemon; a dial can also fail for want of permission. Windows
  // reports a missing service as its pipe not being found, without the usual prefix.
  [
    /doesn't appear to be running|tailscaled\.service not running|tailscale is stopped|tailscaled: the system cannot find the file specified|failed to connect to local tailscale[\s\S]*(?:connection refused|no such file or directory|cannot find the file)/i,
    "not-running",
  ],
  [
    /permission denied|access denied|must be root|operation not permitted/i,
    "permission-denied",
  ],
  // The macOS apps, and tailscaled without SO_MARK, proxy only to localhost, 127.0.0.1 and ::1.
  [/doesn't support connecting to remote destinations/i, "unsupported-target"],
];

export function stderrDiagnosticOf(
  stderr: string,
): TailscaleStderrDiagnostic | undefined {
  if (stderr.trim().length === 0) return undefined;
  return (
    STDERR_DIAGNOSTIC_PATTERNS.find(([pattern]) => pattern.test(stderr))?.[1] ??
    "unknown"
  );
}

export type TailscaleDiagnosticKind =
  | TailscaleStderrDiagnostic
  | "https-disabled"
  | "magic-dns-missing"
  | "port-occupied"
  | "not-installed";

/** Concise, actionable user-facing message for a Tailscale diagnostic without quoting stderr. */
export function tailscaleDiagnosticMessage(
  diagnostic: TailscaleDiagnosticKind | undefined,
  options: {
    readonly platform?: NodeJS.Platform;
    readonly servePort?: number;
    readonly localHost?: string;
  } = {},
): string {
  const platform = options.platform ?? process.platform;
  switch (diagnostic) {
    case "not-installed":
      return "Tailscale is not installed on this host.";
    case "not-running":
      return "Tailscale is not running. Start Tailscale (or tailscaled) and try again.";
    case "not-logged-in":
      return "Tailscale is not logged in. Run `tailscale up` and try again.";
    case "magic-dns-missing":
      return "This machine has no MagicDNS name. Run `tailscale up` and enable MagicDNS.";
    case "https-disabled":
      return "Tailscale Serve needs HTTPS enabled on the tailnet. Enable HTTPS certificates at https://login.tailscale.com/admin/dns.";
    case "permission-denied":
      return platform === "linux"
        ? "Tailscale refused the Serve config because this user is not its operator. Run `sudo tailscale set --operator=$USER` once, then try again."
        : "Tailscale refused the Serve config due to permissions. Check your Tailscale client permissions and try again.";
    case "unsupported-target":
      return options.localHost !== undefined
        ? `This Tailscale install can only proxy to localhost, and the host listens on ${options.localHost}. Bind to 127.0.0.1 or 0.0.0.0 and try again.`
        : "This Tailscale install can only proxy to localhost (127.0.0.1 or ::1).";
    case "port-occupied":
      return options.servePort !== undefined
        ? `HTTPS port ${options.servePort} on the tailnet is already used by another service. Try another port such as 8443.`
        : "That HTTPS port on the tailnet is already used by another service. Try another port such as 8443.";
    case "no-existing-handler":
      return "No Tailscale Serve handler exists on that port.";
    case "unknown":
    case undefined:
      return options.servePort !== undefined
        ? `tailscale serve failed for HTTPS port ${options.servePort}. Run \`tailscale serve --https=${options.servePort} --bg <local-url>\` by hand to see why.`
        : "Could not talk to Tailscale. Check `tailscale status`.";
  }
}

export type TailscaleErrorCode =
  | "spawn"
  | "exit"
  | "timeout"
  | "parse"
  | "https-disabled"
  | "not-installed";

/**
 * Structured Tailscale error. For non-zero exits, raw stderr and command arguments are never
 * retained on the error object so secrets such as `tskey-…` cannot leak into logs or responses.
 */
export class TailscaleError extends Error {
  readonly code: TailscaleErrorCode;
  readonly subcommand?: string;
  readonly exitCode?: number;
  readonly stdoutLength?: number;
  readonly stderrLength?: number;
  readonly diagnostic?: TailscaleStderrDiagnostic;
  readonly timeoutMs?: number;

  constructor(
    code: TailscaleErrorCode,
    message: string,
    details: {
      readonly subcommand?: string;
      readonly exitCode?: number;
      readonly stdoutLength?: number;
      readonly stderrLength?: number;
      readonly diagnostic?: TailscaleStderrDiagnostic;
      readonly timeoutMs?: number;
      readonly cause?: unknown;
    } = {},
  ) {
    super(
      message,
      details.cause === undefined ? undefined : { cause: details.cause },
    );
    this.name = "TailscaleError";
    this.code = code;
    if (details.subcommand !== undefined) this.subcommand = details.subcommand;
    if (details.exitCode !== undefined) this.exitCode = details.exitCode;
    if (details.stdoutLength !== undefined)
      this.stdoutLength = details.stdoutLength;
    if (details.stderrLength !== undefined)
      this.stderrLength = details.stderrLength;
    if (details.diagnostic !== undefined) this.diagnostic = details.diagnostic;
    if (details.timeoutMs !== undefined) this.timeoutMs = details.timeoutMs;
  }
}

/** One node of the tailnet, as discovery shows it. */
interface TailnetNode {
  /** The stable node id: what a machine row remembers. */
  node: string;
  /** Its hostname. */
  name: string;
  /** Its MagicDNS name, without the trailing dot; empty when MagicDNS is off. */
  dnsName: string;
  addresses: string[];
  os: string;
  online: boolean;
  /** The login of the user it belongs to; null for a tagged node, which belongs to no user. */
  login: string | null;
  tags: string[];
}

interface TailnetSelf extends TailnetNode {
  /**
   * `tailscale serve --https` needs the `https` capability from `Self.CapMap`.
   * `null` when the CLI omits `CapMap`, so callers still attempt serve.
   */
  httpsServeEnabled: boolean | null;
}

export interface TailnetStatus {
  running: boolean;
  self: TailnetSelf;
  peers: TailnetNode[];
  httpsServeEnabled: boolean | null;
}

export interface ParsedTailscaleStatus {
  /**
   * `tailscale down` keeps `Self` from the last netmap, so the DNS name alone
   * does not mean the tailnet is reachable. `null` when the CLI omits BackendState.
   */
  readonly running: boolean | null;
  readonly backendState: string | null;
  readonly magicDnsName: string | null;
  readonly tailnetIpv4Addresses: readonly string[];
  readonly httpsServeEnabled: boolean | null;
}

/** Who is behind an address, as Tailscale tells it. */
export interface TailnetWho {
  node: string;
  name: string;
  /** Null for a tagged node. */
  login: string | null;
  tags: string[];
}

/** Runs the command with arguments and gives its standard output. */
export type TailscaleRunner = (args: string[]) => Promise<string>;

/** A Serve route: a web handler at `mount` on `servePort`, or a TCP forward without one. */
export interface TailscaleServeRoute {
  readonly servePort: number;
  readonly mount?: string;
  /** The machine name a web route serves under. */
  readonly host?: string;
  /** A target, such as a name, that may dial this server or another service on the same port. */
  readonly ambiguous?: string;
  /** The Tailscale Service it belongs to, or `foreground` for a `tailscale serve` still running. */
  readonly owner?: string;
}

/** A handler at the root of a Serve port: this server's, or another with the loopback port it dials. */
export type TailscaleServeRootHolder =
  | { readonly ours: true }
  | {
      readonly ours: false;
      readonly loopback?: { readonly host: string; readonly port: number };
    };

export type TailscaleServeRootHolderStatus = "none" | "ours" | "dead" | "other";

const MAC_APP = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";

function resolveTailscaleBinary(): string | null {
  return (
    Bun.which("tailscale") ??
    (process.platform === "win32" ? Bun.which("tailscale.exe") : null) ??
    (process.platform === "darwin" && existsSync(MAC_APP) ? MAC_APP : null)
  );
}

interface SpawnOptions {
  readonly timeoutMs: number;
  readonly captureStdout: boolean;
  readonly killGraceMs?: number;
}

function spawnTailscale(
  binary: string,
  args: readonly string[],
  options: SpawnOptions,
): Promise<string> {
  const subcommand = args[0] ?? "tailscale";
  const killGraceMs = options.killGraceMs ?? TAILSCALE_KILL_GRACE_MS;

  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(binary, [...args], {
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (cause) {
      reject(
        new TailscaleError(
          "spawn",
          `Failed to spawn tailscale ${subcommand}.`,
          { subcommand, cause },
        ),
      );
      return;
    }

    let settled = false;
    let timedOut = false;
    let stdout = "";
    let stdoutLength = 0;
    let stderr = "";
    let stderrLength = 0;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => {
        child.kill("SIGKILL");
      }, killGraceMs);
      killTimer.unref?.();
    }, options.timeoutMs);
    timer.unref?.();

    const cleanupTimers = (): void => {
      clearTimeout(timer);
      if (killTimer !== undefined) clearTimeout(killTimer);
    };

    // Always drain stdout so a long success summary never fills the pipe and blocks exit.
    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutLength += chunk.length;
      if (options.captureStdout && stdoutLength <= MAX_STDOUT_BYTES) {
        stdout += chunk.toString("utf8");
      }
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      stderrLength += chunk.length;
      if (stderr.length < MAX_STDERR_BYTES) {
        stderr += chunk.toString("utf8");
      }
    });

    child.once("error", (cause) => {
      if (settled) return;
      settled = true;
      cleanupTimers();
      reject(
        new TailscaleError(
          "spawn",
          `Failed to spawn tailscale ${subcommand}.`,
          { subcommand, cause },
        ),
      );
    });

    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      cleanupTimers();
      if (timedOut) {
        reject(
          new TailscaleError(
            "timeout",
            `tailscale ${subcommand} timed out after ${options.timeoutMs}ms.`,
            { subcommand, timeoutMs: options.timeoutMs },
          ),
        );
        return;
      }
      if (code !== 0) {
        const diagnostic = stderrDiagnosticOf(stderr);
        reject(
          new TailscaleError(
            "exit",
            `tailscale ${subcommand} exited with code ${code ?? -1}.`,
            {
              subcommand,
              exitCode: code ?? -1,
              stdoutLength,
              stderrLength,
              ...(diagnostic === undefined ? {} : { diagnostic }),
            },
          ),
        );
        return;
      }
      resolve(stdout);
    });
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface RawNode {
  ID?: string;
  HostName?: string;
  DNSName?: string;
  TailscaleIPs?: string[];
  OS?: string;
  Online?: boolean;
  UserID?: number;
  Tags?: string[];
  CapMap?: unknown;
}

interface RawStatus {
  BackendState?: unknown;
  Self?: RawNode;
  Peer?: Record<string, RawNode>;
  User?: Record<string, { LoginName?: string }>;
}

/** `::ffff:100.64.0.1` is `100.64.0.1`. */
function plainAddress(address: string): string {
  return address.startsWith("::ffff:") ? address.slice(7) : address;
}

function readHttpsServeEnabled(capMap: unknown): boolean | null {
  return isRecord(capMap) ? Object.hasOwn(capMap, "https") : null;
}

/** Parse `tailscale status --json` into status/capability facts, or undefined on invalid JSON. */
export function parseTailscaleStatus(
  rawStatusJson: string,
): ParsedTailscaleStatus | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawStatusJson);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;

  const self = isRecord(parsed.Self) ? parsed.Self : undefined;
  const rawDnsName = self?.DNSName;
  const trimmedDns =
    typeof rawDnsName === "string" ? rawDnsName.trim().replace(/\.$/u, "") : "";
  const magicDnsName = trimmedDns.length > 0 ? trimmedDns : null;

  const tailnetIpv4Addresses: string[] = [];
  if (Array.isArray(self?.TailscaleIPs)) {
    for (const address of self.TailscaleIPs) {
      if (typeof address === "string" && isTailscaleIpv4Address(address)) {
        tailnetIpv4Addresses.push(address);
      }
    }
  }

  const backendState =
    typeof parsed.BackendState === "string" ? parsed.BackendState : null;

  return {
    running:
      parsed.BackendState === undefined
        ? null
        : parsed.BackendState === "Running",
    backendState,
    magicDnsName,
    tailnetIpv4Addresses,
    httpsServeEnabled: readHttpsServeEnabled(self?.CapMap),
  };
}

/** Build the Tailscale Serve HTTPS origin URL for a MagicDNS name and Serve port. */
export function buildTailscaleHttpsBaseUrl(input: {
  readonly magicDnsName: string;
  readonly servePort?: number;
}): string {
  const host = input.magicDnsName.trim().replace(/\.$/u, "");
  const url = new URL(`https://${host}`);
  const servePort = input.servePort ?? DEFAULT_TAILSCALE_SERVE_PORT;
  if (servePort !== DEFAULT_TAILSCALE_SERVE_PORT) {
    url.port = String(servePort);
  }
  return url.origin;
}

/**
 * The `tailscale` arguments that turn `route` off; a foreground route has none, since it ends with
 * its command. A web route ALWAYS names its path (`--set-path=...`): without one the CLI removes
 * every handler on the port.
 */
export function tailscaleServeOffArgs(
  route: TailscaleServeRoute,
): string[] | undefined {
  if (route.owner === "foreground") return undefined;
  return [
    "serve",
    ...(route.owner === undefined ? [] : [`--service=${route.owner}`]),
    ...(route.mount === undefined
      ? [`--tcp=${route.servePort}`]
      : [`--https=${route.servePort}`, `--set-path=${route.mount}`]),
    "off",
  ];
}

/**
 * Whether a proxy to `hostname` dials `bindHost`. `0.0.0.0` reaches 127.0.0.1. `[::]` may reach
 * either loopback, since Go dials `::` and then 0.0.0.0 (golang/go#18806), and a name such as
 * `localhost` may resolve to whatever the server binds.
 */
function reaches(
  hostname: string,
  bindHost: string,
): "exact" | "either" | undefined {
  let address = normalizeHostname(hostname);
  // Compare IPv6 by value: 0:0:0:0:0:ffff:7f00:1 is ::ffff:7f00:1.
  if (address.includes(":") && URL.canParse(`http://[${address}]`)) {
    address = normalizeHostname(new URL(`http://[${address}]`).hostname);
  }
  // An IPv4-mapped address can be written as hex, such as ::ffff:7f00:1 for 127.0.0.1.
  const mapped = /^::ffff:([\da-f]{1,4}):([\da-f]{1,4})$/u.exec(address);
  if (mapped !== null) {
    const high = Number.parseInt(mapped[1]!, 16);
    const low = Number.parseInt(mapped[2]!, 16);
    address = [high >>> 8, high & 0xff, low >>> 8, low & 0xff].join(".");
  } else if (address.startsWith("::ffff:")) {
    address = address.slice("::ffff:".length);
  }
  // Strict, as Go's ParseIP is; anything else, such as `127.1` or `box.1`, goes to the resolver.
  const literal =
    address.includes(":") ||
    /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?!$)|$)){4}$/u.test(address);
  if (!literal) return "either";
  if (address === "::") {
    return bindHost === "127.0.0.1" || bindHost === "::1"
      ? "either"
      : undefined;
  }
  return (address === "0.0.0.0" ? "127.0.0.1" : address) === bindHost
    ? "exact"
    : undefined;
}

/** The URL Tailscale's proxy dials for a handler's `Proxy`, expanded as its `expandProxyArg` does. */
function expandProxy(proxy: string): string {
  if (/^\d+$/u.test(proxy)) return `http://127.0.0.1:${proxy}`;
  if (proxy.startsWith("https+insecure://"))
    return `https://${proxy.slice("https+insecure://".length)}`;
  if (/^(?:https?:\/\/|unix:)/u.test(proxy)) return proxy;
  return `http://${proxy}`;
}

/**
 * The host and port a proxy target dials, read as Go's url.Parse reads it rather than as a WHATWG
 * URL, which rejects `box.1` and rewrites `127.1`; none for a Unix socket.
 */
function dialedHostPort(
  url: string,
): { readonly host: string; readonly port: string } | undefined {
  const match =
    /^(https?|tcp):\/\/(?:[^@/?#]*@)?(\[[^\]]*\]|[^/?#:]*)(?::(\d*))?/iu.exec(
      url,
    );
  if (match === null) return undefined;
  const [, scheme = "", host = "", port] = match;
  return {
    host,
    port: port || (scheme.toLowerCase() === "https" ? "443" : "80"),
  };
}

function reachesTarget(
  url: string,
  target: { readonly host: string; readonly port: number },
):
  | { readonly reach: "exact" | "either"; readonly hostname: string }
  | undefined {
  const dialed = dialedHostPort(url);
  // Go reads the port as a decimal number, so 03773 is 3773.
  if (dialed === undefined || Number(dialed.port) !== target.port)
    return undefined;
  const reach = reaches(dialed.host, target.host);
  return reach === undefined ? undefined : { reach, hostname: dialed.host };
}

function decodeServeStatusJson(
  rawServeStatusJson: string,
): Record<string, unknown> | null | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawServeStatusJson);
  } catch {
    return undefined;
  }
  if (parsed === null) return null;
  if (!isRecord(parsed)) return undefined;
  return parsed;
}

/**
 * The Serve routes that forward to the server bound at `target`, or undefined when the status
 * cannot be read.
 */
export function parseTailscaleServeRoutesTo(
  rawServeStatusJson: string,
  target: { readonly host: string; readonly port: number },
): TailscaleServeRoute[] | undefined {
  const status = decodeServeStatusJson(rawServeStatusJson);
  if (status === undefined) return undefined;

  const routesIn = (config: unknown, owner?: string): TailscaleServeRoute[] => {
    if (!isRecord(config)) return [];
    const scope = owner === undefined ? {} : { owner };
    const reached = (url: string) => {
      const found = reachesTarget(url, target);
      if (found === undefined) return undefined;
      return found.reach === "either" ? { ambiguous: found.hostname } : {};
    };

    const tcp: TailscaleServeRoute[] = [];
    if (isRecord(config.TCP)) {
      for (const [port, handler] of Object.entries(config.TCP)) {
        if (!isRecord(handler) || typeof handler.TCPForward !== "string")
          continue;
        if (handler.TCPForward.startsWith("unix:")) continue;
        const reach = reached(`tcp://${handler.TCPForward}`);
        const servePort = Number(port);
        if (reach !== undefined && Number.isInteger(servePort)) {
          tcp.push({ servePort, ...reach, ...scope });
        }
      }
    }

    const web: TailscaleServeRoute[] = [];
    if (isRecord(config.Web)) {
      for (const [hostPort, site] of Object.entries(config.Web)) {
        if (!isRecord(site) || !isRecord(site.Handlers)) continue;
        const separator = hostPort.lastIndexOf(":");
        if (separator === -1) continue;
        const servePort = Number(hostPort.slice(separator + 1));
        if (!Number.isInteger(servePort)) continue;
        const host = hostPort.slice(0, separator);
        for (const [mount, handler] of Object.entries(site.Handlers)) {
          if (!isRecord(handler) || typeof handler.Proxy !== "string") continue;
          const reach = reached(expandProxy(handler.Proxy));
          if (reach !== undefined) {
            web.push({ servePort, mount, host, ...reach, ...scope });
          }
        }
      }
    }

    return [...tcp, ...web];
  };

  const routes: TailscaleServeRoute[] = [...routesIn(status)];
  if (status !== null && isRecord(status.Services)) {
    for (const [name, service] of Object.entries(status.Services)) {
      routes.push(...routesIn(service, name));
    }
  }
  if (status !== null && isRecord(status.Foreground)) {
    for (const session of Object.values(status.Foreground)) {
      routes.push(...routesIn(session, "foreground"));
    }
  }
  return routes;
}

/**
 * What answers at the root of `servePort` outside any Tailscale Service, where
 * `ensureServe` publishes, or undefined when the status cannot be read.
 */
export function parseTailscaleServeRootHolders(
  rawServeStatusJson: string,
  servePort: number,
  target: { readonly host: string; readonly port: number },
): TailscaleServeRootHolder[] | undefined {
  const config = decodeServeStatusJson(rawServeStatusJson);
  if (config === undefined) return undefined;
  if (config === null) return [];

  const holders: TailscaleServeRootHolder[] = [];
  if (isRecord(config.TCP)) {
    const tcpEntry = config.TCP[String(servePort)];
    if (isRecord(tcpEntry) && typeof tcpEntry.TCPForward === "string") {
      holders.push({ ours: false });
    }
  }

  if (isRecord(config.Web)) {
    for (const [hostPort, site] of Object.entries(config.Web)) {
      if (!isRecord(site) || !isRecord(site.Handlers)) continue;
      const root = site.Handlers["/"];
      const port = Number(hostPort.slice(hostPort.lastIndexOf(":") + 1));
      if (port !== servePort || !isRecord(root)) continue;
      if (typeof root.Proxy !== "string") {
        holders.push({ ours: false });
        continue;
      }
      const url = expandProxy(root.Proxy);
      if (reachesTarget(url, target) !== undefined) {
        holders.push({ ours: true });
        continue;
      }
      const dialed = dialedHostPort(url);
      holders.push(
        dialed !== undefined && isLoopbackHost(dialed.host)
          ? {
              ours: false,
              loopback: {
                host: normalizeHostname(dialed.host),
                port: Number(dialed.port),
              },
            }
          : { ours: false },
      );
    }
  }

  return holders;
}

function hasListenerOnHost(
  port: number,
  host: string,
  timeoutMs = LISTENER_PROBE_TIMEOUT_MS,
): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port, timeout: timeoutMs });
    let settled = false;
    const settle = (listening: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(listening);
    };
    socket.once("connect", () => settle(true));
    socket.once("timeout", () => settle(false));
    socket.once("error", () => settle(false));
  });
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type HttpsRequestFn = (
  options: RequestOptions,
  callback: (res: IncomingMessage) => void,
) => ClientRequest;

export interface ProbeHttpsEndpointInput {
  readonly baseUrl: string;
  readonly expectedHostId: string;
  /** Optional Tailnet IPv4 (`100.x.y.z`) for direct TCP connect with SNI & Host header. */
  readonly tailnetIpv4?: string;
  readonly path?: string;
  readonly attempts?: number;
  readonly delayMs?: number;
  readonly timeoutMs?: number;
  /** Optional trusted CA certificates (for TLS tests using local self-signed servers). */
  readonly ca?: string | Buffer | ReadonlyArray<string | Buffer>;
  /** Tests only: override `https.request`. */
  readonly request?: HttpsRequestFn;
  readonly sleep?: (ms: number) => Promise<void>;
}

type ProbeOutcome =
  | { readonly kind: "match"; readonly matched: boolean }
  | { readonly kind: "http-retry" }
  | { readonly kind: "transport-error" };

function probeHttpsOnce(input: {
  readonly requestFn: HttpsRequestFn;
  readonly connectHost: string;
  readonly port: number;
  readonly path: string;
  readonly hostHeader: string;
  readonly servername: string | undefined;
  readonly expectedHostId: string;
  readonly timeoutMs: number;
  readonly ca?: string | Buffer | ReadonlyArray<string | Buffer>;
}): Promise<ProbeOutcome> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let req: ClientRequest | undefined;

    const finish = (outcome: ProbeOutcome): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve(outcome);
    };

    try {
      const ca =
        input.ca === undefined
          ? undefined
          : typeof input.ca === "string" || Buffer.isBuffer(input.ca)
            ? input.ca
            : [...input.ca];
      const options: RequestOptions = {
        host: input.connectHost,
        port: input.port,
        path: input.path,
        method: "GET",
        agent: false,
        rejectUnauthorized: true,
        timeout: input.timeoutMs,
        headers: {
          host: input.hostHeader,
          accept: "application/json",
          connection: "close",
        },
        ...(input.servername === undefined
          ? {}
          : { servername: input.servername }),
        ...(ca === undefined ? {} : { ca }),
      };

      req = input.requestFn(options, (res) => {
        const status = res.statusCode ?? 0;
        if (status < 200 || status >= 300) {
          res.once("error", () => undefined);
          finish({ kind: "http-retry" });
          res.destroy();
          return;
        }

        const chunks: Buffer[] = [];
        let size = 0;

        res.on("data", (chunk: Buffer | string) => {
          const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
          size += buf.length;
          if (size > MAX_PROBE_BODY_BYTES) {
            finish({ kind: "http-retry" });
            res.destroy();
            req?.destroy();
            return;
          }
          chunks.push(buf);
        });

        res.on("end", () => {
          if (!res.complete) {
            finish({ kind: "transport-error" });
            return;
          }
          try {
            const parsed: unknown = JSON.parse(
              Buffer.concat(chunks).toString("utf8"),
            );
            if (isRecord(parsed) && typeof parsed.hostId === "string") {
              finish({
                kind: "match",
                matched: parsed.hostId === input.expectedHostId,
              });
              return;
            }
          } catch {
            // Non-JSON 200 response; retry until attempts are exhausted.
          }
          finish({ kind: "http-retry" });
        });

        res.on("close", () => {
          if (!settled && !res.complete) {
            finish({ kind: "transport-error" });
          }
        });

        res.on("error", () => {
          finish({ kind: "transport-error" });
        });
      });

      timer = setTimeout(() => {
        req?.destroy(new Error("HTTPS probe timed out"));
        finish({ kind: "transport-error" });
      }, input.timeoutMs);
      timer.unref?.();

      req.on("timeout", () => {
        req?.destroy(new Error("HTTPS probe socket timed out"));
        finish({ kind: "transport-error" });
      });

      req.on("error", () => {
        finish({ kind: "transport-error" });
      });

      req.end();
    } catch {
      finish({ kind: "transport-error" });
    }
  });
}

/**
 * Probe `/.well-known/eta/host` over the Tailscale HTTPS endpoint using `node:https` directly
 * (bypassing `http_proxy`/`https_proxy`). When `tailnetIpv4` is supplied, connects directly to
 * the Tailnet IPv4 with TLS SNI + `Host` set to the MagicDNS name (falling back to `url.hostname`
 * on transport failure) so probing works even when MagicDNS resolution fails locally. Retries by
 * default (5 attempts, 8s timeout, 1s delay) to tolerate initial Let's Encrypt cert provisioning.
 * Never throws.
 */
export async function probeHttpsEndpoint(
  input: ProbeHttpsEndpointInput,
): Promise<boolean> {
  const path = input.path ?? "/.well-known/eta/host";
  const attempts = Math.max(1, input.attempts ?? TAILSCALE_PROBE_ATTEMPTS);
  const delayMs = Math.max(0, input.delayMs ?? TAILSCALE_PROBE_RETRY_DELAY_MS);
  const timeoutMs = Math.max(1, input.timeoutMs ?? TAILSCALE_PROBE_TIMEOUT_MS);
  const requestFn = input.request ?? https.request;
  const sleep = input.sleep ?? defaultSleep;

  let probeUrl: URL;
  try {
    probeUrl = new URL(path, input.baseUrl);
  } catch {
    return false;
  }
  if (probeUrl.protocol !== "https:") return false;

  const urlHost = probeUrl.hostname.replace(/^\[|\]$/gu, "");
  if (urlHost === "") return false;
  const port =
    probeUrl.port === "" ? DEFAULT_TAILSCALE_SERVE_PORT : Number(probeUrl.port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return false;

  const requestPath = `${probeUrl.pathname}${probeUrl.search}`;
  const servername = net.isIP(urlHost) === 0 ? urlHost : undefined;
  const hostHeader = probeUrl.host;

  const targets: string[] = [];
  const candidateIp = input.tailnetIpv4?.trim();
  if (candidateIp !== undefined && net.isIPv4(candidateIp)) {
    targets.push(candidateIp);
  }
  if (!targets.includes(urlHost)) {
    targets.push(urlHost);
  }

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const attemptDeadline = Date.now() + timeoutMs;

    for (const connectHost of targets) {
      const remainingMs = attemptDeadline - Date.now();
      if (remainingMs <= 0) break;

      const outcome = await probeHttpsOnce({
        requestFn,
        connectHost,
        port,
        path: requestPath,
        hostHeader,
        servername,
        expectedHostId: input.expectedHostId,
        timeoutMs: remainingMs,
        ...(input.ca === undefined ? {} : { ca: input.ca }),
      });

      if (outcome.kind === "match") {
        return outcome.matched;
      }
      if (outcome.kind === "http-retry") {
        // Endpoint answered over HTTPS; retry after delay instead of hitting DNS fallback.
        break;
      }
    }

    if (attempt + 1 < attempts && delayMs > 0) {
      await sleep(delayMs);
    }
  }

  return false;
}

function wrapRunnerError(
  error: unknown,
  subcommand: string,
  timeoutMs: number,
): TailscaleError {
  if (error instanceof TailscaleError) return error;
  if (typeof error === "object" && error !== null) {
    const record = error as {
      code?: unknown;
      exitCode?: unknown;
      stderr?: unknown;
      stdout?: unknown;
      killed?: unknown;
      timedOut?: unknown;
    };
    if (record.timedOut === true || record.killed === true) {
      return new TailscaleError(
        "timeout",
        `tailscale ${subcommand} timed out after ${timeoutMs}ms.`,
        { subcommand, timeoutMs },
      );
    }
    const exitCode =
      typeof record.exitCode === "number"
        ? record.exitCode
        : typeof record.code === "number"
          ? record.code
          : undefined;
    const stderr =
      typeof record.stderr === "string" ? record.stderr : undefined;
    if (exitCode !== undefined || stderr !== undefined) {
      const diagnostic =
        stderr === undefined ? undefined : stderrDiagnosticOf(stderr);
      const stdoutLength =
        typeof record.stdout === "string" ? record.stdout.length : 0;
      const stderrLength = stderr?.length ?? 0;
      // Intentionally omit raw stderr and cause so auth keys (tskey-...) cannot leak.
      return new TailscaleError(
        "exit",
        `tailscale ${subcommand} exited with code ${exitCode ?? 1}.`,
        {
          subcommand,
          exitCode: exitCode ?? 1,
          stdoutLength,
          stderrLength,
          ...(diagnostic === undefined ? {} : { diagnostic }),
        },
      );
    }
  }
  return new TailscaleError(
    "spawn",
    `Failed to spawn tailscale ${subcommand}.`,
    { subcommand, cause: error },
  );
}

export class Tailscale {
  readonly #binary: string | null;
  readonly #run: TailscaleRunner | undefined;
  readonly #hasListener: (port: number, host: string) => Promise<boolean>;

  constructor(
    options: {
      run?: TailscaleRunner | undefined;
      binary?: string | undefined;
      hasListener?:
        | ((port: number, host: string) => Promise<boolean>)
        | undefined;
    } = {},
  ) {
    this.#run = options.run;
    this.#binary =
      options.run === undefined
        ? (options.binary ?? resolveTailscaleBinary())
        : null;
    this.#hasListener = options.hasListener ?? hasListenerOnHost;
  }

  /** Whether there is a `tailscale` command at all. */
  get installed(): boolean {
    return this.#run !== undefined || this.#binary !== null;
  }

  async #exec(
    args: readonly string[],
    options: { readonly timeoutMs: number; readonly captureStdout: boolean },
  ): Promise<string> {
    const subcommand = args[0] ?? "tailscale";
    if (this.#run !== undefined) {
      try {
        return await this.#run([...args]);
      } catch (error) {
        throw wrapRunnerError(error, subcommand, options.timeoutMs);
      }
    }
    if (this.#binary === null) {
      throw new TailscaleError(
        "not-installed",
        "Tailscale is not installed on this host.",
        { subcommand },
      );
    }
    return spawnTailscale(this.#binary, args, options);
  }

  /**
   * Read parsed Tailscale status facts (including when stopped or missing capabilities).
   * Throws `TailscaleError` with structured `diagnostic` when the CLI fails.
   */
  async readStatus(): Promise<ParsedTailscaleStatus> {
    const raw = await this.#exec(["status", "--json"], {
      timeoutMs: TAILSCALE_STATUS_TIMEOUT_MS,
      captureStdout: true,
    });
    const parsed = parseTailscaleStatus(raw);
    if (parsed === undefined) {
      throw new TailscaleError(
        "parse",
        "Failed to decode tailscale status JSON.",
        {
          subcommand: "status",
        },
      );
    }
    return parsed;
  }

  /** The tailnet as this node sees it; undefined when there is no command or the node is not up. */
  async status(): Promise<TailnetStatus | undefined> {
    if (!this.installed) return undefined;
    let raw: RawStatus;
    try {
      const stdout = await this.#exec(["status", "--json"], {
        timeoutMs: TAILSCALE_STATUS_TIMEOUT_MS,
        captureStdout: true,
      });
      raw = JSON.parse(stdout) as RawStatus;
    } catch {
      return undefined;
    }
    if (raw.BackendState !== "Running" || raw.Self === undefined)
      return undefined;
    const users = raw.User ?? {};
    const nodeOf = (node: RawNode, online: boolean): TailnetNode => {
      const tags = node.Tags ?? [];
      const login =
        tags.length > 0 || node.UserID === undefined
          ? null
          : (users[String(node.UserID)]?.LoginName ?? null);
      return {
        node: node.ID ?? "",
        name: node.HostName ?? "",
        dnsName: (node.DNSName ?? "").replace(/\.$/, ""),
        addresses: node.TailscaleIPs ?? [],
        os: node.OS ?? "",
        online,
        login,
        tags,
      };
    };
    const httpsServeEnabled = readHttpsServeEnabled(raw.Self.CapMap);
    return {
      running: true,
      httpsServeEnabled,
      self: {
        ...nodeOf(raw.Self, true),
        httpsServeEnabled,
      },
      peers: Object.values(raw.Peer ?? {})
        .map((peer) => nodeOf(peer, peer.Online === true))
        .sort((a, b) => a.name.localeCompare(b.name)),
    };
  }

  /** Who is behind a tailnet address; undefined when it is not one Tailscale knows. */
  async whois(address: string): Promise<TailnetWho | undefined> {
    if (!this.installed) return undefined;
    try {
      const stdout = await this.#exec(
        ["whois", "--json", plainAddress(address)],
        {
          timeoutMs: TAILSCALE_STATUS_TIMEOUT_MS,
          captureStdout: true,
        },
      );
      const raw = JSON.parse(stdout) as {
        Node?: {
          StableID?: string;
          ID?: string;
          Name?: string;
          Tags?: string[];
        };
        UserProfile?: { LoginName?: string };
      };
      if (raw.Node === undefined) return undefined;
      const tags = raw.Node.Tags ?? [];
      return {
        node: raw.Node.StableID ?? String(raw.Node.ID ?? ""),
        name: (raw.Node.Name ?? "").replace(/\.$/, ""),
        login: tags.length > 0 ? null : (raw.UserProfile?.LoginName ?? null),
        tags,
      };
    } catch {
      return undefined;
    }
  }

  /** This node's IPv4 address on the tailnet; undefined without one. */
  async address(): Promise<string | undefined> {
    if (!this.installed) return undefined;
    try {
      const first = (
        await this.#exec(["ip", "-4"], {
          timeoutMs: TAILSCALE_STATUS_TIMEOUT_MS,
          captureStdout: true,
        })
      )
        .trim()
        .split("\n")[0]
        ?.trim();
      return first === undefined || first === "" ? undefined : first;
    } catch {
      return undefined;
    }
  }

  /**
   * Whether the node behind an address is one of the user's own: it belongs to the same login as
   * this node, and is not a tagged node (which belongs to no one). Its node id when it is.
   */
  async ownNode(address: string): Promise<{ node: string } | undefined> {
    const [status, who] = await Promise.all([
      this.status(),
      this.whois(address),
    ]);
    if (status === undefined || who === undefined) return undefined;
    // This very node is not another machine of the user's: it is a proxy in front of the host (a
    // request from the internet that a local Caddy passed on) or a process on this computer, and
    // whoever is behind it is not known.
    if (who.node === status.self.node) return undefined;
    if (who.login === null || who.tags.length > 0) return undefined;
    if (status.self.login === null || who.login !== status.self.login)
      return undefined;
    return { node: who.node };
  }

  /** The Serve routes that forward to the server bound at `target` on this machine. */
  async readServeRoutesTo(target: {
    readonly host: string;
    readonly port: number;
  }): Promise<TailscaleServeRoute[]> {
    const stdout = await this.#exec(["serve", "status", "--json"], {
      timeoutMs: TAILSCALE_STATUS_TIMEOUT_MS,
      captureStdout: true,
    });
    const routes = parseTailscaleServeRoutesTo(stdout, target);
    if (routes === undefined) {
      throw new TailscaleError(
        "parse",
        "Failed to decode tailscale serve status JSON.",
        {
          subcommand: "serve",
        },
      );
    }
    return routes;
  }

  /**
   * Who holds the root of `servePort`: nobody, the server at `target`, only dead loopback ports
   * (an unclean exit leaves one), or another live server or app, whose route must be left alone.
   */
  async readServeRootHolder(
    servePort: number,
    target: { readonly host: string; readonly port: number },
  ): Promise<TailscaleServeRootHolderStatus> {
    const stdout = await this.#exec(["serve", "status", "--json"], {
      timeoutMs: TAILSCALE_STATUS_TIMEOUT_MS,
      captureStdout: true,
    });
    const holders = parseTailscaleServeRootHolders(stdout, servePort, target);
    if (holders === undefined) {
      throw new TailscaleError(
        "parse",
        "Failed to decode tailscale serve status JSON.",
        {
          subcommand: "serve",
        },
      );
    }
    if (holders.length === 0) return "none";
    if (holders.some((holder) => holder.ours)) return "ours";
    const live = await Promise.all(
      holders.map((holder) =>
        holder.ours || holder.loopback === undefined
          ? Promise.resolve(true)
          : this.#hasListener(holder.loopback.port, holder.loopback.host),
      ),
    );
    return live.includes(true) ? "other" : "dead";
  }

  /**
   * Configure a persistent background Tailscale Serve HTTPS proxy to `localHost:localPort`.
   * Pre-checks `Self.CapMap.https` so missing HTTPS capability fails fast instead of hanging or
   * silently exiting 0 without writing config.
   */
  async ensureServe(input: {
    readonly localPort: number;
    readonly servePort?: number;
    readonly localHost?: string;
  }): Promise<void> {
    // Without the capability `tailscale serve` prints an enablement notice and exits 0, or blocks
    // on it, having configured nothing either way.
    let status: ParsedTailscaleStatus | undefined;
    try {
      status = await this.readStatus();
    } catch {
      // Older or degraded status read: still attempt `tailscale serve` so its own error surfaces.
    }
    if (status?.httpsServeEnabled === false) {
      throw new TailscaleError(
        "https-disabled",
        tailscaleDiagnosticMessage("https-disabled"),
        { subcommand: "serve" },
      );
    }
    const servePort = input.servePort ?? DEFAULT_TAILSCALE_SERVE_PORT;
    const localHost = input.localHost ?? "127.0.0.1";
    await this.#exec(
      [
        "serve",
        "--bg",
        `--https=${servePort}`,
        `http://${formatHostForUrl(localHost)}:${input.localPort}`,
      ],
      {
        timeoutMs: TAILSCALE_SERVE_TIMEOUT_MS,
        captureStdout: false,
      },
    );
  }

  /**
   * Remove the web handler at `mount` (default `"/"`) on `servePort`. ALWAYS passes `--set-path`
   * so sibling routes on the same Serve port are never wiped.
   */
  async disableServe(
    input: { readonly servePort?: number; readonly mount?: string } = {},
  ): Promise<void> {
    const args = tailscaleServeOffArgs({
      servePort: input.servePort ?? DEFAULT_TAILSCALE_SERVE_PORT,
      mount: input.mount ?? "/",
    })!;
    await this.#exec(args, {
      timeoutMs: TAILSCALE_SERVE_TIMEOUT_MS,
      captureStdout: false,
    });
  }
}
