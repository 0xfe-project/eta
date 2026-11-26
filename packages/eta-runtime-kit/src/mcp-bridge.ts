/**
 * Stdio ↔ Streamable HTTP MCP bridge.
 *
 * Antigravity persists every `SessionOptions.mcpServers` entry (`env` and `headers` included) in
 * plain text inside its conversation database, so OAR refuses credentialed entries there
 * (`refusedSessionOptions.mcpServerCredentials`). It does pass `SessionOptions.env` to spawned
 * stdio MCP server processes without persisting `SessionOptions.env`.
 *
 * This bridge runs as a credential-free stdio MCP server entry (`{ name: "eta", command, args }`)
 * and forwards newline-delimited JSON-RPC over stdin/stdout to the host's authenticated
 * `serveMcpTools` loopback HTTP endpoint using `ETA_HOST_MCP_URL` and `ETA_HOST_MCP_TOKEN` from
 * its inherited environment.
 */
import { Buffer } from "node:buffer";
import { basename, dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const HOST_MCP_URL_ENV = "ETA_HOST_MCP_URL";
export const HOST_MCP_TOKEN_ENV = "ETA_HOST_MCP_TOKEN";

export interface McpBridgeLauncher {
  readonly command: string;
  readonly args?: readonly string[] | undefined;
}

export interface McpBridgeOptions {
  env?: Readonly<Record<string, string | undefined>>;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  error?: NodeJS.WritableStream;
  fetch?: (
    ...args: Parameters<typeof globalThis.fetch>
  ) => ReturnType<typeof globalThis.fetch>;
  signal?: AbortSignal;
}

type JsonRpcId = string | number;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

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

/**
 * Run the stdio ↔ Streamable HTTP MCP bridge until stdin closes or `signal` aborts.
 * Returns `0` on clean EOF/shutdown or `1` when required configuration is missing.
 */
export async function runMcpBridge(
  options: McpBridgeOptions = {},
): Promise<number> {
  const env = options.env ?? process.env;
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const error = options.error ?? process.stderr;
  const fetchImpl = options.fetch ?? globalThis.fetch;

  const url = env[HOST_MCP_URL_ENV]?.trim();
  const token = env[HOST_MCP_TOKEN_ENV]?.trim();
  if (url === undefined || url === "" || token === undefined || token === "") {
    error.write(
      `[eta-mcp-bridge] missing ${HOST_MCP_URL_ENV} or ${HOST_MCP_TOKEN_ENV}\n`,
    );
    return 1;
  }

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
      const response = await fetchImpl(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${token}`,
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
