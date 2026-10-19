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

let loaded:
  | { path: string; symbols: Symbols; restoreSignals: () => void }
  | undefined;
let running = false;

/**
 * Go's runtime, loaded as a shared library, sets `SA_ONSTACK` on every signal handler it finds
 * installed and did not install itself, so that a handler never runs on a small goroutine stack.
 * One of them is JavaScriptCore's: the signal (SIGPWR) its collector sends a JavaScript thread to
 * suspend it and copy its stack. Bun's main thread has an alternate signal stack (for its crash
 * handler), so with the flag the handler runs there, reports a stack pointer outside the thread's
 * stack, and the collector waits for a copy that never fits: the event loop stops for good,
 * seconds to minutes after the gateway starts (test/scripts/idle.ts).
 *
 * So the handlers are read before the library loads, and every one that is still the same handler
 * but changed (only its flags can have) is put back as it was. JavaScriptCore only sends the
 * signal to its own threads, never to Go's, so the flag was not needed. Go's own handlers (the
 * synchronous signals, which it chains to Bun's, SIGPIPE and SIGURG) are left alone.
 */
function snapshotSignals(): () => void {
  const libc = dlopen(
    process.platform === "darwin" ? "libSystem.B.dylib" : "libc.so.6",
    {
      sigaction: {
        args: [FFIType.i32, FFIType.ptr, FFIType.ptr],
        returns: FFIType.i32,
      },
    },
  ).symbols as unknown as {
    sigaction: (signal: number, next: Buffer | null, old: Buffer) => number;
  };
  // Larger than any platform's struct sigaction, read and written as opaque bytes; its first
  // field is the handler everywhere.
  const read = (signal: number) => {
    const action = Buffer.alloc(256);
    return libc.sigaction(signal, null, action) === 0 ? action : undefined;
  };
  const before = new Map<number, Buffer>();
  for (let signal = 1; signal < 65; signal++) {
    const action = read(signal);
    if (action !== undefined) before.set(signal, action);
  }
  return () => {
    for (const [signal, action] of before) {
      const now = read(signal);
      if (
        now !== undefined &&
        now.readBigUInt64LE(0) === action.readBigUInt64LE(0) &&
        !now.equals(action)
      ) {
        libc.sigaction(signal, action, Buffer.alloc(256));
      }
    }
  };
}

function load(path: string): NonNullable<typeof loaded> {
  if (loaded !== undefined) {
    if (loaded.path !== path)
      throw new Error(
        `the gateway library is already loaded from ${loaded.path}`,
      );
    return loaded;
  }
  // Go's runtime starts initialising as the library loads.
  const restoreSignals = snapshotSignals();
  const library = dlopen(path, {
    LlmStart: { args: [FFIType.ptr], returns: FFIType.ptr },
    LlmStop: { args: [], returns: FFIType.void },
    LlmFree: { args: [FFIType.ptr], returns: FFIType.void },
  });
  loaded = {
    path,
    symbols: library.symbols as unknown as Symbols,
    restoreSignals,
  };
  return loaded;
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
  const { symbols, restoreSignals } = load(path);
  const key = randomBytes(32).toString("hex");
  const config = JSON.stringify({
    stateDir: options.stateDir,
    accessKey: key,
    ...(options.cpaExtra === undefined ? {} : { cpaExtra: options.cpaExtra }),
  });
  const pointer = symbols.LlmStart(Buffer.from(`${config}\0`));
  // Go's runtime has finished initialising once a call into it returns.
  restoreSignals();
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
