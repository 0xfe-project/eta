/**
 * Stdio ↔ Streamable HTTP MCP bridge and stdio env-injection wrapper.
 *
 * Antigravity persists every `SessionOptions.mcpServers` entry (`env` and `headers` included) in
 * plain text inside its conversation database, so OAR refuses credentialed entries there
 * (`refusedSessionOptions.mcpServerCredentials`). It does pass `SessionOptions.env` to spawned
 * stdio MCP server processes without persisting `SessionOptions.env`.
 *
 * Three modes share one entrypoint (`McpBridgeLauncher` / `mcp-bridge`):
 * 1. Default (no args): forwards stdio JSON-RPC to the host's authenticated `serveMcpTools`
 *    loopback HTTP endpoint using `ETA_HOST_MCP_URL` and `ETA_HOST_MCP_TOKEN`.
 * 2. `--env-prefix <PREFIX>`: forwards stdio JSON-RPC to an HTTP plugin MCP server whose URL and
 *    headers are split into `<PREFIX>_URL`, `<PREFIX>_HNAME_<j>`, `<PREFIX>_HVAL_<j>_SECRET`.
 * 3. `exec --env-prefix <PREFIX> -- <command> [args...]`: strips all bridge variables
 *    (`ETA_HOST_MCP_*`, `ETA_MCP_*`), injects `<PREFIX>_ENAME_<j>` / `<PREFIX>_EVAL_<j>_SECRET`,
 *    and spawns the target stdio MCP server while forwarding stdio, signals, and exit code.
 */
import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { constants as osConstants } from "node:os";
import { basename, dirname, join, win32 } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const HOST_MCP_URL_ENV = "ETA_HOST_MCP_URL";
export const HOST_MCP_TOKEN_ENV = "ETA_HOST_MCP_TOKEN";
export const MCP_HTTP_BRIDGE_PREFIX = "ETA_MCP_HTTP_";
export const MCP_STDIO_BRIDGE_PREFIX = "ETA_MCP_STDIO_";

export interface McpBridgeLauncher {
  readonly command: string;
  readonly args?: readonly string[] | undefined;
}

export interface BridgedMcpServer {
  readonly server: {
    readonly name: string;
    readonly command: string;
    readonly args: readonly string[];
  };
  readonly env: Readonly<Record<string, string>>;
}

export interface McpBridgeOptions {
  args?: readonly string[];
  env?: Readonly<Record<string, string | undefined>>;
  cwd?: string;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  error?: NodeJS.WritableStream;
  fetch?: (
    ...args: Parameters<typeof globalThis.fetch>
  ) => ReturnType<typeof globalThis.fetch>;
  signal?: AbortSignal;
}

type JsonRpcId = string | number;

type ParsedBridgeCommand =
  | { readonly kind: "http"; readonly envPrefix?: string }
  | {
      readonly kind: "exec";
      readonly envPrefix: string;
      readonly command: string;
      readonly args: readonly string[];
    };

interface SpawnTarget {
  readonly command: string;
  readonly args: readonly string[];
  readonly windowsVerbatimArguments: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const WINDOWS_BATCH = /\.(?:cmd|bat)$/iu;
const CMD_META = /[()[\]%!^"`<>&|;, *?]/gu;
const DEFAULT_WINDOWS_PATHEXT = ".EXE;.CMD;.BAT;.COM";

/**
 * How this process starts the stdio MCP bridge:
 * - Compiled executables (`eta-host`, `eta-daemon`) run themselves with the `mcp-bridge`
 *   subcommand, needing no external Bun/Node installation.
 * - Source / test runs invoke the standalone CLI script with the current `bun` / `node` binary.
 */
export function defaultMcpBridge(): McpBridgeLauncher {
  const name = basename(process.execPath).toLowerCase();
  const bin = name.endsWith(".exe") ? name.slice(0, -4) : name;
  const compiled =
    import.meta.url.includes("/$bunfs/") || (bin !== "bun" && bin !== "node");
  if (compiled) return { command: process.execPath, args: ["mcp-bridge"] };
  // Resolve via `dirname` + `join` rather than a static `new URL("./mcp-bridge-cli.ts", import.meta.url)`
  // so `bun build --compile` never pulls the CLI entrypoint in as an embedded asset.
  const scriptPath = join(
    dirname(fileURLToPath(import.meta.url)),
    "mcp-bridge-cli.ts",
  );
  return { command: process.execPath, args: [scriptPath] };
}

/**
 * Wrap a credentialed HTTP plugin MCP server as a credential-free stdio bridge entry plus
 * `SessionOptions.env` variables aligned with OAR's `*_SECRET` credential redactor.
 */
export function bridgeHttpMcpServer(
  launcher: McpBridgeLauncher,
  server: {
    readonly name: string;
    readonly url: string;
    readonly headers?: Readonly<Record<string, string>>;
  },
  index: number,
): BridgedMcpServer {
  const prefix = `${MCP_HTTP_BRIDGE_PREFIX}${index}`;
  const env: Record<string, string> = {
    [`${prefix}_URL`]: server.url,
  };
  let headerIndex = 0;
  for (const [name, value] of Object.entries(server.headers ?? {})) {
    env[`${prefix}_HNAME_${headerIndex}`] = name;
    env[`${prefix}_HVAL_${headerIndex}_SECRET`] = value;
    headerIndex += 1;
  }
  return {
    server: {
      name: server.name,
      command: launcher.command,
      args: [...(launcher.args ?? []), "--env-prefix", prefix],
    },
    env,
  };
}

/**
 * Wrap a credentialed stdio plugin MCP server as a credential-free `mcp-bridge exec` entry plus
 * `SessionOptions.env` variables aligned with OAR's `*_SECRET` credential redactor.
 */
export function bridgeStdioMcpServer(
  launcher: McpBridgeLauncher,
  server: {
    readonly name: string;
    readonly command: string;
    readonly args?: readonly string[];
    readonly env?: Readonly<Record<string, string>>;
  },
  index: number,
): BridgedMcpServer {
  const prefix = `${MCP_STDIO_BRIDGE_PREFIX}${index}`;
  const env: Record<string, string> = {};
  let envIndex = 0;
  for (const [name, value] of Object.entries(server.env ?? {})) {
    env[`${prefix}_ENAME_${envIndex}`] = name;
    env[`${prefix}_EVAL_${envIndex}_SECRET`] = value;
    envIndex += 1;
  }
  return {
    server: {
      name: server.name,
      command: launcher.command,
      args: [
        ...(launcher.args ?? []),
        "exec",
        "--env-prefix",
        prefix,
        "--",
        server.command,
        ...(server.args ?? []),
      ],
    },
    env,
  };
}

function parseBridgeArgs(
  args: readonly string[],
):
  | { readonly ok: true; readonly command: ParsedBridgeCommand }
  | { readonly ok: false; readonly message: string } {
  if (args.length === 0) return { ok: true, command: { kind: "http" } };
  if (args[0] === "exec") {
    let envPrefix: string | undefined;
    let sawSeparator = false;
    let index = 1;
    while (index < args.length) {
      const arg = args[index]!;
      if (arg === "--") {
        sawSeparator = true;
        index += 1;
        break;
      }
      if (arg === "--env-prefix") {
        const value = args[index + 1];
        if (value === undefined || value === "" || value === "--") {
          return { ok: false, message: "missing value for --env-prefix" };
        }
        envPrefix = value;
        index += 2;
        continue;
      }
      if (arg.startsWith("--env-prefix=")) {
        const value = arg.slice("--env-prefix=".length);
        if (value === "") {
          return { ok: false, message: "missing value for --env-prefix" };
        }
        envPrefix = value;
        index += 1;
        continue;
      }
      return { ok: false, message: `unknown exec argument: ${arg}` };
    }
    if (!sawSeparator) {
      return { ok: false, message: "exec requires -- <command> [args...]" };
    }
    if (envPrefix === undefined) {
      return { ok: false, message: "exec requires --env-prefix <prefix>" };
    }
    const targetCommand = args[index];
    if (targetCommand === undefined || targetCommand === "") {
      return { ok: false, message: "exec requires a command after --" };
    }
    return {
      ok: true,
      command: {
        kind: "exec",
        envPrefix,
        command: targetCommand,
        args: args.slice(index + 1),
      },
    };
  }

  let envPrefix: string | undefined;
  let index = 0;
  while (index < args.length) {
    const arg = args[index]!;
    if (arg === "--env-prefix") {
      const value = args[index + 1];
      if (value === undefined || value === "") {
        return { ok: false, message: "missing value for --env-prefix" };
      }
      envPrefix = value;
      index += 2;
      continue;
    }
    if (arg.startsWith("--env-prefix=")) {
      const value = arg.slice("--env-prefix=".length);
      if (value === "") {
        return { ok: false, message: "missing value for --env-prefix" };
      }
      envPrefix = value;
      index += 1;
      continue;
    }
    return { ok: false, message: `unknown argument: ${arg}` };
  }
  return {
    ok: true,
    command: {
      kind: "http",
      ...(envPrefix === undefined ? {} : { envPrefix }),
    },
  };
}

function readIndexedEnvPairs(
  env: Readonly<Record<string, string | undefined>>,
  namePrefix: string,
  valKeyFor: (index: number) => string,
):
  | {
      readonly ok: true;
      readonly entries: readonly (readonly [string, string])[];
    }
  | { readonly ok: false; readonly message: string } {
  const indexed: {
    readonly index: number;
    readonly nameKey: string;
    readonly name: string;
  }[] = [];
  for (const [key, rawName] of Object.entries(env)) {
    if (!key.startsWith(namePrefix) || rawName === undefined) continue;
    const suffix = key.slice(namePrefix.length);
    if (!/^\d+$/u.test(suffix)) continue;
    indexed.push({ index: Number(suffix), nameKey: key, name: rawName });
  }
  indexed.sort((left, right) => left.index - right.index);
  const entries: [string, string][] = [];
  for (const item of indexed) {
    if (item.name === "") {
      return { ok: false, message: `empty variable name in ${item.nameKey}` };
    }
    const valKey = valKeyFor(item.index);
    const value = env[valKey];
    if (value === undefined) {
      return { ok: false, message: `missing ${valKey}` };
    }
    entries.push([item.name, value]);
  }
  return { ok: true, entries };
}

function isBridgeEnvKey(key: string): boolean {
  const upper = key.toUpperCase();
  return upper.startsWith("ETA_HOST_MCP_") || upper.startsWith("ETA_MCP_");
}

function isFile(filePath: string): boolean {
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function windowsEnvValue(
  env: Readonly<Record<string, string | undefined>>,
  upperName: string,
): string | undefined {
  const key = Object.keys(env)
    .sort()
    .find((candidate) => candidate.toUpperCase() === upperName);
  return key === undefined ? undefined : env[key];
}

function nonEmptyWindowsEnvValue(
  env: Readonly<Record<string, string | undefined>>,
  upperName: string,
): string | undefined {
  const value = windowsEnvValue(env, upperName)?.trim();
  return value !== undefined && value !== "" ? value : undefined;
}

function parseWindowsPathExt(raw: string | undefined): string[] {
  const source =
    raw !== undefined && raw.trim() !== "" ? raw : DEFAULT_WINDOWS_PATHEXT;
  const exts: string[] = [];
  for (const part of source.split(";")) {
    const trimmed = part.trim();
    if (trimmed === "") continue;
    exts.push(trimmed.startsWith(".") ? trimmed : `.${trimmed}`);
  }
  return exts.length > 0 ? exts : DEFAULT_WINDOWS_PATHEXT.split(";");
}

function findWindowsExecutable(
  candidateBase: string,
  exts: readonly string[],
  allowBareFile: boolean,
): string | null {
  const lower = candidateBase.toLowerCase();
  const hasKnownExt = exts.some((ext) => lower.endsWith(ext.toLowerCase()));
  if (hasKnownExt && isFile(candidateBase)) return candidateBase;
  for (const ext of exts) {
    const withExt = `${candidateBase}${ext}`;
    if (isFile(withExt)) return withExt;
  }
  if (allowBareFile && !hasKnownExt && isFile(candidateBase)) {
    return candidateBase;
  }
  return null;
}

function resolveWindowsCommand(
  command: string,
  env: Readonly<Record<string, string | undefined>>,
  cwd: string,
): string | null {
  const exts = parseWindowsPathExt(windowsEnvValue(env, "PATHEXT"));
  if (/[\\/]/u.test(command)) {
    return findWindowsExecutable(win32.resolve(cwd, command), exts, true);
  }
  const searchPath = windowsEnvValue(env, "PATH") ?? "";
  const directories = [cwd, ...searchPath.split(";")];
  for (const rawDir of directories) {
    const trimmed = rawDir.trim().replace(/^"(.*)"$/u, "$1");
    if (trimmed === "") continue;
    const candidate = win32.resolve(cwd, trimmed, command);
    const found = findWindowsExecutable(candidate, exts, false);
    if (found !== null) return found;
  }
  return null;
}

/** One cmd.exe pass; spaces and quotes are escaped too. */
function escapeCmd(text: string): string {
  return text.replaceAll(CMD_META, "^$&");
}

/** Quote for the eventual program's argv, then protect both cmd.exe passes. */
function escapeWindowsShimArgument(argument: string): string {
  let quoted = '"';
  let backslashes = 0;
  for (const character of argument) {
    if (character === "\\") {
      backslashes += 1;
      continue;
    }
    quoted +=
      "\\".repeat(character === '"' ? backslashes * 2 + 1 : backslashes) +
      character;
    backslashes = 0;
  }
  quoted += `${"\\".repeat(backslashes * 2)}"`;
  return escapeCmd(escapeCmd(quoted));
}

function resolveSpawnTarget(
  command: string,
  args: readonly string[],
  childEnv: Readonly<Record<string, string>>,
  cwd: string,
):
  | { readonly ok: true; readonly target: SpawnTarget }
  | { readonly ok: false; readonly message: string } {
  if (process.platform !== "win32") {
    return {
      ok: true,
      target: { command, args, windowsVerbatimArguments: false },
    };
  }
  const resolved = resolveWindowsCommand(command, childEnv, cwd);
  if (resolved === null) {
    return {
      ok: true,
      target: { command, args, windowsVerbatimArguments: false },
    };
  }
  if (!WINDOWS_BATCH.test(resolved)) {
    return {
      ok: true,
      target: { command: resolved, args, windowsVerbatimArguments: false },
    };
  }
  if (
    /[\r\n\0]/u.test(resolved) ||
    args.some((argument) => /[\r\n\0]/u.test(argument))
  ) {
    return {
      ok: false,
      message: `cannot pass CR, LF, or NUL arguments to Windows batch command ${command}`,
    };
  }
  // The batch path is parsed once; forwarded arguments are parsed twice by cmd.exe.
  // /s removes the outer quote pair, leaving the escaped command line intact.
  const line = [
    escapeCmd(`"${resolved}"`),
    ...args.map(escapeWindowsShimArgument),
  ].join(" ");
  const shell =
    nonEmptyWindowsEnvValue(childEnv, "COMSPEC") ??
    nonEmptyWindowsEnvValue(process.env, "COMSPEC") ??
    "cmd.exe";
  const shellArgs = ["/d", "/s", "/c", `"${line}"`];
  if (`"${shell}" ${shellArgs.join(" ")}`.length > 8191) {
    return {
      ok: false,
      message: `Windows batch command line for ${command} exceeds 8191 characters`,
    };
  }
  return {
    ok: true,
    target: {
      command: shell,
      args: shellArgs,
      windowsVerbatimArguments: true,
    },
  };
}

function exitCodeForSignal(signal: NodeJS.Signals | null): number {
  if (signal === null) return 1;
  const sigNum = osConstants.signals[signal];
  return typeof sigNum === "number" ? 128 + sigNum : 1;
}

function abortSignalOf(reason: unknown): NodeJS.Signals {
  return reason === "SIGINT" || reason === "SIGTERM" ? reason : "SIGTERM";
}

function requestIdsOf(parsed: unknown): JsonRpcId[] {
  const items = Array.isArray(parsed) ? parsed : [parsed];
  const ids: JsonRpcId[] = [];
  for (const item of items) {
    if (!isRecord(item)) continue;
    const { id } = item;
    if (typeof id === "string" || typeof id === "number") ids.push(id);
  }
  return ids;
}

function hasInitializeMethod(parsed: unknown): boolean {
  const items = Array.isArray(parsed) ? parsed : [parsed];
  return items.some((item) => isRecord(item) && item.method === "initialize");
}

function rpcErrorResponse(
  id: JsonRpcId | null,
  code: number,
  message: string,
): string {
  return JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });
}

function writeErrorResponses(
  ids: readonly JsonRpcId[],
  wasArray: boolean,
  code: number,
  message: string,
  write: (line: string) => void,
): void {
  if (ids.length === 0) return;
  if (wasArray) {
    write(
      JSON.stringify(
        ids.map((id) => ({ jsonrpc: "2.0", id, error: { code, message } })),
      ),
    );
    return;
  }
  write(rpcErrorResponse(ids[0]!, code, message));
}

function forwardSseBlock(block: string, write: (line: string) => void): void {
  const dataLines: string[] = [];
  for (const rawLine of block.split(/\r?\n/u)) {
    if (rawLine.startsWith("data:")) {
      dataLines.push(rawLine.slice(5).replace(/^ /u, ""));
    }
  }
  const payload = dataLines.join("\n").trim();
  if (payload === "") return;
  try {
    write(JSON.stringify(JSON.parse(payload)));
  } catch {
    write(payload.replaceAll(/[\r\n]+/gu, " "));
  }
}

async function forwardSseResponse(
  response: Response,
  write: (line: string) => void,
): Promise<void> {
  if (response.body === null) {
    const text = await response.text();
    for (const block of text.split(/\r?\n\r?\n/u)) {
      forwardSseBlock(block, write);
    }
    return;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let match = /\r?\n\r?\n/u.exec(buffer);
    while (match !== null) {
      const block = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
      forwardSseBlock(block, write);
      match = /\r?\n\r?\n/u.exec(buffer);
    }
  }
  buffer += decoder.decode();
  if (buffer.trim() !== "") forwardSseBlock(buffer, write);
}

async function runExecBridge(
  parsedCommand: Extract<ParsedBridgeCommand, { readonly kind: "exec" }>,
  options: McpBridgeOptions,
): Promise<number> {
  const env = options.env ?? process.env;
  const error = options.error ?? process.stderr;
  const cwd = options.cwd ?? process.cwd();

  const parsedEnv = readIndexedEnvPairs(
    env,
    `${parsedCommand.envPrefix}_ENAME_`,
    (index) => `${parsedCommand.envPrefix}_EVAL_${index}_SECRET`,
  );
  if (!parsedEnv.ok) {
    error.write(`[eta-mcp-bridge] ${parsedEnv.message}\n`);
    return 1;
  }

  const childEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || isBridgeEnvKey(key)) continue;
    childEnv[key] = value;
  }
  for (const [name, value] of parsedEnv.entries) {
    if (process.platform === "win32") {
      const upper = name.toUpperCase();
      for (const existing of Object.keys(childEnv)) {
        if (existing !== name && existing.toUpperCase() === upper) {
          delete childEnv[existing];
        }
      }
    }
    childEnv[name] = value;
  }

  const resolvedTarget = resolveSpawnTarget(
    parsedCommand.command,
    parsedCommand.args,
    childEnv,
    cwd,
  );
  if (!resolvedTarget.ok) {
    error.write(`[eta-mcp-bridge] ${resolvedTarget.message}\n`);
    return 1;
  }

  if (options.signal?.aborted === true) {
    return exitCodeForSignal(abortSignalOf(options.signal.reason));
  }

  const customInput = options.input;
  const customOutput = options.output;
  const customError = options.error;
  const { target } = resolvedTarget;

  const child = spawn(target.command, [...target.args], {
    env: childEnv,
    cwd,
    stdio: [
      customInput !== undefined ? "pipe" : "inherit",
      customOutput !== undefined ? "pipe" : "inherit",
      customError !== undefined ? "pipe" : "inherit",
    ],
    windowsHide: true,
    windowsVerbatimArguments: target.windowsVerbatimArguments,
  });

  if (customInput !== undefined && child.stdin !== null) {
    child.stdin.on("error", () => undefined);
    customInput.pipe(child.stdin);
  }
  if (customOutput !== undefined && child.stdout !== null) {
    child.stdout.pipe(customOutput, { end: false });
  }
  if (customError !== undefined && child.stderr !== null) {
    child.stderr.pipe(customError, { end: false });
  }

  const sendSignal = (sig: NodeJS.Signals): void => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    try {
      child.kill(sig);
    } catch {
      // Child already exited or cannot be signalled.
    }
  };

  let attachedProcessHandlers = false;
  const onSigint = (): void => sendSignal("SIGINT");
  const onSigterm = (): void => sendSignal("SIGTERM");
  const attachProcessSignals = (): void => {
    if (attachedProcessHandlers) return;
    attachedProcessHandlers = true;
    process.on("SIGINT", onSigint);
    process.on("SIGTERM", onSigterm);
  };

  const onAbort = (): void => {
    sendSignal(abortSignalOf(options.signal?.reason));
    // Once the single-shot AbortSignal has fired, still forward later signals if the child stays up.
    attachProcessSignals();
  };

  if (options.signal !== undefined) {
    if (options.signal.aborted) onAbort();
    else options.signal.addEventListener("abort", onAbort, { once: true });
  } else {
    attachProcessSignals();
  }

  try {
    return await new Promise<number>((resolve) => {
      let settled = false;
      const finish = (code: number): void => {
        if (settled) return;
        settled = true;
        resolve(code);
      };
      child.once("error", (caught) => {
        const message =
          caught instanceof Error ? caught.message : String(caught);
        error.write(
          `[eta-mcp-bridge] failed to spawn ${parsedCommand.command}: ${message}\n`,
        );
        finish(1);
      });
      child.once("close", (code, termSignal) => {
        if (code !== null) {
          finish(code);
          return;
        }
        finish(exitCodeForSignal(termSignal));
      });
    });
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
    if (attachedProcessHandlers) {
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
    }
    if (customInput !== undefined && child.stdin !== null) {
      customInput.unpipe(child.stdin);
    }
  }
}

async function runHttpBridge(
  envPrefix: string | undefined,
  options: McpBridgeOptions,
): Promise<number> {
  const env = options.env ?? process.env;
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const error = options.error ?? process.stderr;
  const fetchImpl = options.fetch ?? globalThis.fetch;

  let url: string | undefined;
  const extraHeaders: Record<string, string> = {};

  if (envPrefix === undefined) {
    url = env[HOST_MCP_URL_ENV]?.trim();
    const token = env[HOST_MCP_TOKEN_ENV]?.trim();
    if (
      url === undefined ||
      url === "" ||
      token === undefined ||
      token === ""
    ) {
      error.write(
        `[eta-mcp-bridge] missing ${HOST_MCP_URL_ENV} or ${HOST_MCP_TOKEN_ENV}\n`,
      );
      return 1;
    }
    extraHeaders.authorization = `Bearer ${token}`;
  } else {
    const urlKey = `${envPrefix}_URL`;
    url = env[urlKey]?.trim();
    if (url === undefined || url === "") {
      error.write(`[eta-mcp-bridge] missing ${urlKey}\n`);
      return 1;
    }
    const parsedHeaders = readIndexedEnvPairs(
      env,
      `${envPrefix}_HNAME_`,
      (index) => `${envPrefix}_HVAL_${index}_SECRET`,
    );
    if (!parsedHeaders.ok) {
      error.write(`[eta-mcp-bridge] ${parsedHeaders.message}\n`);
      return 1;
    }
    for (const [rawName, value] of parsedHeaders.entries) {
      const normalized = rawName.trim().toLowerCase();
      if (normalized === "") {
        error.write(`[eta-mcp-bridge] empty header name for ${envPrefix}\n`);
        return 1;
      }
      extraHeaders[normalized] = value;
    }
  }

  const targetUrl = url;
  const controller = new AbortController();
  const onAbort = (): void => controller.abort();
  if (options.signal !== undefined) {
    if (options.signal.aborted) controller.abort();
    else options.signal.addEventListener("abort", onAbort, { once: true });
  }

  const writeLine = (line: string): void => {
    if ((output as { writableEnded?: boolean }).writableEnded === true) return;
    try {
      output.write(`${line}\n`);
    } catch {
      // Output closed while shutting down.
    }
  };

  let sessionId: string | undefined;
  let initializing: Promise<void> | undefined;
  const pending = new Set<Promise<void>>();

  const forwardLine = async (
    line: string,
    parsed: unknown,
    isInit: boolean,
  ): Promise<void> => {
    const ids = requestIdsOf(parsed);
    const wasArray = Array.isArray(parsed);
    if (!isInit && initializing !== undefined) {
      await initializing.catch(() => undefined);
    }
    try {
      const response = await fetchImpl(targetUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...extraHeaders,
          ...(sessionId === undefined ? {} : { "mcp-session-id": sessionId }),
        },
        body: line,
        signal: controller.signal,
      });
      const nextSession = response.headers.get("mcp-session-id");
      if (nextSession !== null && nextSession !== "") sessionId = nextSession;

      if (response.status === 202 || response.status === 204) {
        await response.body?.cancel().catch(() => undefined);
        return;
      }

      if (!response.ok) {
        const bodyText = await response.text().catch(() => "");
        if (ids.length === 0) return;
        const trimmed = bodyText.trim();
        if (trimmed !== "") {
          try {
            const parsedError: unknown = JSON.parse(trimmed);
            if (isRecord(parsedError) && "error" in parsedError) {
              const reply =
                !wasArray && parsedError.id === null
                  ? { ...parsedError, id: ids[0] }
                  : parsedError;
              writeLine(JSON.stringify(reply));
              return;
            }
          } catch {
            // Fall through to synthetic JSON-RPC error.
          }
        }
        writeErrorResponses(
          ids,
          wasArray,
          -32603,
          `HTTP ${response.status}${trimmed === "" ? "" : `: ${trimmed}`}`,
          writeLine,
        );
        return;
      }

      const contentType = response.headers.get("content-type") ?? "";
      if (contentType.includes("text/event-stream")) {
        await forwardSseResponse(response, writeLine);
        return;
      }

      const bodyText = await response.text();
      const trimmed = bodyText.trim();
      if (trimmed === "") return;
      try {
        writeLine(JSON.stringify(JSON.parse(trimmed)));
      } catch {
        writeLine(trimmed.replaceAll(/[\r\n]+/gu, " "));
      }
    } catch (caught) {
      if (controller.signal.aborted) return;
      const message = caught instanceof Error ? caught.message : String(caught);
      writeErrorResponses(ids, wasArray, -32603, message, writeLine);
    }
  };

  const dispatch = (line: string): void => {
    if (line.trim() === "") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      writeLine(rpcErrorResponse(null, -32700, "parse error"));
      return;
    }
    const isInit = hasInitializeMethod(parsed);
    const work = forwardLine(line, parsed, isInit).finally(() => {
      pending.delete(work);
    });
    pending.add(work);
    if (isInit) {
      const gate = work.finally(() => {
        if (initializing === gate) initializing = undefined;
      });
      initializing = gate;
    }
  };

  try {
    await new Promise<void>((resolve, reject) => {
      if (controller.signal.aborted) {
        resolve();
        return;
      }
      let buffer = "";
      const listeners: {
        data?: (chunk: string | Buffer) => void;
        end?: () => void;
        error?: (caught: unknown) => void;
        abort?: () => void;
      } = {};
      const cleanup = (): void => {
        if (listeners.data !== undefined) input.off("data", listeners.data);
        if (listeners.end !== undefined) {
          input.off("end", listeners.end);
          input.off("close", listeners.end);
        }
        if (listeners.error !== undefined) input.off("error", listeners.error);
        if (listeners.abort !== undefined)
          controller.signal.removeEventListener("abort", listeners.abort);
      };
      listeners.data = (chunk: string | Buffer): void => {
        buffer +=
          typeof chunk === "string"
            ? chunk
            : Buffer.from(chunk).toString("utf8");
        for (
          let nl = buffer.indexOf("\n");
          nl >= 0;
          nl = buffer.indexOf("\n")
        ) {
          const line = buffer.slice(0, nl).replace(/\r$/u, "");
          buffer = buffer.slice(nl + 1);
          dispatch(line);
        }
      };
      listeners.end = (): void => {
        cleanup();
        const trailing = buffer.replace(/\r$/u, "");
        buffer = "";
        if (trailing.trim() !== "") dispatch(trailing);
        resolve();
      };
      listeners.error = (caught: unknown): void => {
        cleanup();
        reject(caught);
      };
      listeners.abort = (): void => {
        cleanup();
        resolve();
      };
      input.on("data", listeners.data);
      input.once("end", listeners.end);
      input.once("close", listeners.end);
      input.once("error", listeners.error);
      controller.signal.addEventListener("abort", listeners.abort, {
        once: true,
      });
      input.resume?.();
    });
    await Promise.allSettled(pending);
    return 0;
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * Run the MCP bridge:
 * - No args: stdio ↔ Streamable HTTP bridge for host tools (`ETA_HOST_MCP_URL` / `ETA_HOST_MCP_TOKEN`).
 * - `--env-prefix <PREFIX>`: stdio ↔ Streamable HTTP bridge for a plugin MCP server.
 * - `exec --env-prefix <PREFIX> -- <command> [args...]`: stdio env-injection wrapper.
 */
export async function runMcpBridge(
  options: McpBridgeOptions = {},
): Promise<number> {
  const error = options.error ?? process.stderr;
  const parsed = parseBridgeArgs(options.args ?? []);
  if (!parsed.ok) {
    error.write(`[eta-mcp-bridge] ${parsed.message}\n`);
    return 1;
  }
  if (parsed.command.kind === "exec") {
    return await runExecBridge(parsed.command, options);
  }
  return await runHttpBridge(parsed.command.envPrefix, options);
}
