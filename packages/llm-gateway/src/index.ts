import type { Pointer } from "bun:ffi";
import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";
/**
 * The LLM gateway, loaded into this process.
 *
 * The gateway is Go (CLIProxyAPI embedded; see `module/`), built as a C shared library and opened
 * with `bun:ffi`. Three calls cross the boundary, all of them quick: `LlmStart` binds a loopback
 * listener and returns its port, `LlmStop` closes it, `LlmFree` releases the reply. Everything
 * else (model traffic, the account API) is HTTP to that listener, authenticated by a key this
 * process makes up, so no Go thread ever calls back into JavaScript and a slow upstream never
 * blocks the event loop.
 *
 * A process starts the gateway once: CPA keeps process-wide state (its logger, model registry and
 * access providers), and the library refuses a second start.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { CString, dlopen, FFIType } from "bun:ffi";

/** Where `bun run build` leaves the library, unless `ETA_LLM_LIB` says otherwise. */
export function libraryPath(): string {
  const configured = process.env.ETA_LLM_LIB;
  if (configured !== undefined && configured !== "") return configured;
  const extension = process.platform === "darwin" ? "dylib" : "so";
  return join(import.meta.dirname, "..", "lib", `libllm-gateway.${extension}`);
}

/** Whether the library is built. A host without it runs without a gateway. */
export function gatewayBuilt(): boolean {
  return existsSync(libraryPath());
}

export interface GatewayOptions {
  /** Credentials, the catalog seen so far, API keys and CPA's generated config live here. */
  stateDir: string;
  /** Merged over CPA's generated config. For tests that point an upstream at a fake server. */
  cpaExtra?: Record<string, unknown> | undefined;
}

export interface Gateway {
  readonly port: number;
  /** The base of the OpenAI-compatible API: `http://127.0.0.1:<port>/v1`. */
  readonly baseUrl: string;
  /** The key `/v1` and `/api/llm` expect as a bearer token. */
  readonly key: string;
  /** A request to the gateway, with the key. `path` starts with `/`. */
  fetch: (path: string, init?: RequestInit) => Promise<Response>;
  /** Stop the listener and CPA. Blocks until they are down. */
  stop: () => void;
}

interface Symbols {
  LlmStart: (config: Buffer) => Pointer | null;
  LlmStop: () => void;
  LlmFree: (pointer: Pointer) => void;
}

let loaded: { path: string; symbols: Symbols } | undefined;
let running = false;

function load(path: string): Symbols {
  if (loaded !== undefined) {
    if (loaded.path !== path)
      throw new Error(
        `the gateway library is already loaded from ${loaded.path}`,
      );
    return loaded.symbols;
  }
  const library = dlopen(path, {
    LlmStart: { args: [FFIType.ptr], returns: FFIType.ptr },
    LlmStop: { args: [], returns: FFIType.void },
    LlmFree: { args: [FFIType.ptr], returns: FFIType.void },
  });
  loaded = { path, symbols: library.symbols as unknown as Symbols };
  return loaded.symbols;
}

/** Start the gateway in this process. Throws with the library's reason when it cannot. */
export function startGateway(options: GatewayOptions): Gateway {
  const path = libraryPath();
  if (!existsSync(path)) {
    throw new Error(
      `the LLM gateway library is not built (${path}); run \`bun run --cwd packages/llm-gateway build\` (needs Go)`,
    );
  }
  if (running)
    throw new Error("the LLM gateway is already running in this process");
  const symbols = load(path);
  const key = randomBytes(32).toString("hex");
  const config = JSON.stringify({
    stateDir: options.stateDir,
    accessKey: key,
    ...(options.cpaExtra === undefined ? {} : { cpaExtra: options.cpaExtra }),
  });
  const pointer = symbols.LlmStart(Buffer.from(`${config}\0`));
  if (pointer === null) throw new Error("the LLM gateway did not answer");
  let reply: { port?: number; error?: string };
  try {
    reply = JSON.parse(new CString(pointer).toString()) as typeof reply;
  } finally {
    symbols.LlmFree(pointer);
  }
  if (reply.port === undefined)
    throw new Error(reply.error ?? "the LLM gateway did not start");
  running = true;
  const port = reply.port;
  const origin = `http://127.0.0.1:${port}`;
  let stopped = false;
  return {
    port,
    baseUrl: `${origin}/v1`,
    key,
    fetch: (requestPath, init) => {
      const headers = new Headers(init?.headers);
      headers.set("authorization", `Bearer ${key}`);
      return fetch(`${origin}${requestPath}`, { ...init, headers });
    },
    stop() {
      if (stopped) return;
      stopped = true;
      symbols.LlmStop();
      running = false;
    },
  };
}
