// Cut down from pi-mcp-adapter/server-manager.ts (MIT, see ../NOTICE): one session's connections, without OAuth flows, sharing between owners, keep-alive, resources, prompts or tasks.
/**
 * The MCP servers of one session.
 *
 * A server starts when it is first asked for something and stays up until the session closes. A
 * server that dies is started again by the next call that needs it; a start that failed is not
 * tried again for a few seconds, so a script in a loop gets the same answer instead of a process
 * per iteration. Every failure is an {@link McpError} that says what happened, and none of them
 * touches the session or the other servers.
 *
 * What a server has to say comes through `clean`: tool lists, results and errors alike, so a value
 * the server was configured with stays out of what the caller sees even if the server repeats it.
 *
 * The tool list of each server is kept on disk, so a session knows what a server offers without
 * starting it. It is a hint: the live list replaces it whenever a server connects.
 */
import type { CallToolResult, Tool } from "@modelcontextprotocol/client";
import type { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import process from "node:process";
import {
  Client,
  SdkError,
  SdkErrorCode,
  SdkHttpError,
  StreamableHTTPClientTransport,
  UnauthorizedError,
} from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

/** A session's server, the way an external runtime takes one too. */
export type McpServerSpec =
  | {
      name: string;
      command: string;
      args?: string[];
      env?: Record<string, string>;
    }
  | {
      name: string;
      type: "http";
      url: string;
      headers?: Record<string, string>;
    };

export interface McpTool {
  name: string;
  description: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
}

export type McpFailure =
  /** It could not be started or reached. */
  | "start_failed"
  /** It stopped while a call was running. */
  | "crashed"
  /** It did not answer in time. */
  | "timeout"
  /** A remote server wants a sign-in, which eta does not do yet. */
  | "needs_oauth"
  /** The tool ran and said it failed, or the server refused the call. */
  | "tool_error"
  /** There is no such server or tool, or the session is closed. */
  | "unavailable";

export class McpError extends Error {
  override readonly name = "McpError";
  readonly failure: McpFailure;

  constructor(failure: McpFailure, message: string) {
    super(message);
    this.failure = failure;
  }
}

export interface McpCallOptions {
  signal?: AbortSignal | undefined;
}

export interface McpServersOptions {
  servers: readonly McpServerSpec[];
  /** Where tool lists are kept across sessions; without one they last as long as this object. */
  cacheDir?: string | undefined;
  /** What identifies a server's tool list on disk; by default its name. */
  cacheKey?: ((server: McpServerSpec) => string) | undefined;
  /** Where images and other binary results are written. Without one they are described only. */
  outputDir?: string | undefined;
  /** Applied to everything a server says, before anything else sees it. */
  clean?: (<T>(value: T) => T) | undefined;
  startTimeoutMs?: number | undefined;
  callTimeoutMs?: number | undefined;
}

/** `npx` fetching a package counts as starting. */
const START_TIMEOUT_MS = 90_000;
const CALL_TIMEOUT_MS = 5 * 60_000;
const RETRY_AFTER_MS = 5_000;
const STDERR_BYTES = 2048;
/** A remote server that does not answer the goodbye does not hold a session's close up. */
const GOODBYE_MS = 2000;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const isHttp = (
  spec: McpServerSpec,
): spec is Extract<McpServerSpec, { type: "http" }> => "url" in spec;

function isUnauthorized(error: unknown): boolean {
  return (
    error instanceof UnauthorizedError ||
    (error instanceof SdkHttpError && error.status === 401)
  );
}

function refusal(spec: McpServerSpec): McpError {
  return isHttp(spec) && Object.keys(spec.headers ?? {}).length > 0
    ? new McpError(
        "start_failed",
        `MCP server ${spec.name} refused the configured credentials`,
      )
    : new McpError(
        "needs_oauth",
        `MCP server ${spec.name} needs an OAuth sign-in, which eta does not support`,
      );
}

/** Whichever comes first; the work itself goes on for whoever else is waiting for it. */
async function raceAbort<T>(
  work: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (signal === undefined) return await work;
  signal.throwIfAborted();
  let stop: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    stop = () =>
      reject(
        signal.reason instanceof Error ? signal.reason : new Error("aborted"),
      );
    signal.addEventListener("abort", stop, { once: true });
  });
  try {
    return await Promise.race([work, aborted]);
  } finally {
    signal.removeEventListener("abort", stop!);
  }
}

const toolsOf = (listed: readonly Tool[]): McpTool[] =>
  listed.map((tool) => ({
    name: tool.name,
    description: tool.description ?? "",
    ...(tool.inputSchema === undefined
      ? {}
      : { inputSchema: tool.inputSchema }),
    ...(tool.outputSchema === undefined
      ? {}
      : { outputSchema: tool.outputSchema }),
  }));

interface Live {
  client: Client;
  /** Ends what is running in the server's process or remote session. */
  close: () => Promise<void>;
  /** The end of what it wrote to stderr: what a failed start usually needs. */
  stderr: () => string;
  stopped: boolean;
}

interface Slot {
  spec: McpServerSpec;
  tools: McpTool[] | undefined;
  live: Live | undefined;
  starting: Promise<Live> | undefined;
  failed: { at: number; error: McpError } | undefined;
}

export class McpServers {
  readonly #slots = new Map<string, Slot>();
  readonly #options: McpServersOptions;
  readonly #clean: <T>(value: T) => T;
  #closed = false;

  constructor(options: McpServersOptions) {
    this.#options = options;
    this.#clean = options.clean ?? (<T>(value: T) => value);
    for (const spec of options.servers)
      this.#slots.set(spec.name, {
        spec,
        tools: this.#readCache(spec),
        live: undefined,
        starting: undefined,
        failed: undefined,
      });
  }

  get names(): string[] {
    return [...this.#slots.keys()];
  }

  /** What is known of a server's tools without starting it; `undefined` when nothing is yet. */
  known(name: string): readonly McpTool[] | undefined {
    return this.#slots.get(name)?.tools;
  }

  /** A server's tools, from the server: this starts it. */
  async tools(name: string, options: McpCallOptions = {}): Promise<McpTool[]> {
    const slot = this.#slot(name);
    await raceAbort(this.#ensure(slot), options.signal);
    return slot.tools ?? [];
  }

  /**
   * Call a tool. Resolves to the tool's structured result when it gives one, otherwise to its text;
   * anything binary is written to `outputDir` and named in the text. A tool that reports an error
   * rejects, so a script cannot take a failure for a result.
   */
  async call(
    name: string,
    tool: string,
    input: unknown,
    options: McpCallOptions = {},
  ): Promise<unknown> {
    const slot = this.#slot(name);
    const live = await raceAbort(this.#ensure(slot), options.signal);
    if (slot.tools !== undefined && !slot.tools.some((t) => t.name === tool))
      throw new McpError(
        "unavailable",
        `${name} has no tool ${tool}; it has ${slot.tools.map((t) => t.name).join(", ") || "none"}`,
      );
    let result: CallToolResult;
    try {
      result = (await live.client.callTool(
        { name: tool, arguments: input as Record<string, unknown> },
        {
          timeout: this.#options.callTimeoutMs ?? CALL_TIMEOUT_MS,
          resetTimeoutOnProgress: true,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        },
      )) as CallToolResult;
    } catch (error) {
      throw this.#callFailure(slot, live, tool, error, options.signal);
    }
    const answer = this.#answerOf(result);
    if (result.isError === true)
      throw new McpError(
        "tool_error",
        this.#clean(`${name}.${tool}: ${String(answer)}`),
      );
    return this.#clean(answer);
  }

  /** Stop every server. Nothing starts after this. */
  async close(): Promise<void> {
    this.#closed = true;
    await Promise.all(
      [...this.#slots.values()].map(async (slot) => {
        const live = await slot.starting?.catch(() => undefined);
        await (live ?? slot.live)?.close();
        slot.live = undefined;
      }),
    );
  }

  #slot(name: string): Slot {
    const slot = this.#slots.get(name);
    if (slot !== undefined) return slot;
    throw new McpError(
      "unavailable",
      `no MCP server ${name}; this session has ${this.names.join(", ") || "none"}`,
    );
  }

  async #ensure(slot: Slot): Promise<Live> {
    if (this.#closed)
      throw new McpError(
        "unavailable",
        "this session's MCP servers are closed",
      );
    if (slot.live?.stopped === false) return slot.live;
    if (slot.starting !== undefined) return await slot.starting;
    const { failed } = slot;
    if (failed !== undefined && Date.now() - failed.at < RETRY_AFTER_MS)
      throw failed.error;
    slot.live = undefined;
    const starting = this.#start(slot).then(
      (live) => {
        slot.live = live;
        slot.failed = undefined;
        return live;
      },
      (error: unknown) => {
        const failure =
          error instanceof McpError
            ? error
            : new McpError("start_failed", this.#clean(messageOf(error)));
        slot.failed = { at: Date.now(), error: failure };
        throw failure;
      },
    );
    slot.starting = starting;
    try {
      return await starting;
    } finally {
      slot.starting = undefined;
    }
  }

  async #start(slot: Slot): Promise<Live> {
    const { spec } = slot;
    let tail = "";
    const transport = isHttp(spec)
      ? new StreamableHTTPClientTransport(new URL(spec.url), {
          requestInit: { headers: spec.headers ?? {} },
        })
      : new StdioClientTransport({
          command: spec.command,
          args: spec.args ?? [],
          env: spec.env ?? {},
          stderr: "pipe",
        });
    if (transport instanceof StdioClientTransport)
      transport.stderr?.on("data", (chunk: Buffer) => {
        tail = `${tail}${chunk.toString("utf8")}`.slice(-STDERR_BYTES);
      });
    const client = new Client(
      { name: "eta", version: "1.0.0" },
      {
        listChanged: {
          tools: {
            onChanged: (error, tools) => {
              if (error === null && tools !== null)
                this.#setTools(slot, toolsOf(tools));
            },
          },
        },
      },
    );
    const live: Live = {
      client,
      stderr: () => tail.trim(),
      stopped: false,
      close: async () => {
        live.stopped = true;
        if (transport instanceof StreamableHTTPClientTransport)
          await raceAbort(
            transport.terminateSession(),
            AbortSignal.timeout(GOODBYE_MS),
          ).catch(() => undefined);
        await client.close().catch(() => undefined);
      },
    };
    client.onclose = () => {
      live.stopped = true;
    };
    const timeout = this.#options.startTimeoutMs ?? START_TIMEOUT_MS;
    try {
      await client.connect(transport, { timeout });
      this.#setTools(slot, await this.#listAll(client, timeout));
    } catch (error) {
      await live.close();
      if (isUnauthorized(error)) throw refusal(spec);
      const said = live.stderr();
      throw new McpError(
        error instanceof SdkError && error.code === SdkErrorCode.RequestTimeout
          ? "timeout"
          : "start_failed",
        this.#clean(
          `MCP server ${spec.name} did not start: ${messageOf(error)}${said === "" ? "" : `\n${said}`}`,
        ),
      );
    }
    return live;
  }

  async #listAll(client: Client, timeout: number): Promise<McpTool[]> {
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(
        cursor === undefined ? {} : { cursor },
        { timeout },
      );
      tools.push(...toolsOf(page.tools));
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    return tools;
  }

  #callFailure(
    slot: Slot,
    live: Live,
    tool: string,
    error: unknown,
    signal: AbortSignal | undefined,
  ): unknown {
    const { name } = slot.spec;
    if (signal?.aborted === true) return error;
    if (isUnauthorized(error)) return refusal(slot.spec);
    if (error instanceof SdkError) {
      if (error.code === SdkErrorCode.RequestTimeout)
        return new McpError(
          "timeout",
          `${name}.${tool} did not answer in time`,
        );
      if (live.stopped || error.code === SdkErrorCode.ConnectionClosed) {
        live.stopped = true;
        const said = live.stderr();
        return new McpError(
          "crashed",
          this.#clean(
            `MCP server ${name} stopped during ${tool}${said === "" ? "" : `:\n${said}`}`,
          ),
        );
      }
    }
    return new McpError(
      "tool_error",
      this.#clean(`${name}.${tool}: ${messageOf(error)}`),
    );
  }

  /** A tool's answer as one value: its structure, or its text with the rest written out. */
  #answerOf(result: CallToolResult): unknown {
    if (result.structuredContent !== undefined && result.isError !== true)
      return result.structuredContent;
    return (result.content ?? [])
      .map((block) => {
        switch (block.type) {
          case "text":
            return block.text;
          case "image":
          case "audio":
            return this.#binary(block.mimeType, block.data);
          case "resource":
            return "text" in block.resource
              ? block.resource.text
              : this.#binary(
                  block.resource.mimeType ?? "application/octet-stream",
                  block.resource.blob,
                );
          case "resource_link":
            return block.uri;
          default:
            return "";
        }
      })
      .join("\n");
  }

  #binary(mimeType: string, base64: string): string {
    const { outputDir } = this.#options;
    if (outputDir === undefined) return `[${mimeType}]`;
    const ext = /^[\w.-]+\/([a-z0-9]+)/i.exec(mimeType)?.[1] ?? "bin";
    const path = join(outputDir, `${randomUUID()}.${ext}`);
    mkdirSync(outputDir, { recursive: true });
    writeFileSync(path, base64, "base64");
    return `[${mimeType}: ${path}]`;
  }

  /* ------------------------------------------------------------ the tool list on disk */

  #cachePath(spec: McpServerSpec): string | undefined {
    const { cacheDir, cacheKey } = this.#options;
    if (cacheDir === undefined) return undefined;
    const key = createHash("sha256")
      .update(cacheKey?.(spec) ?? spec.name)
      .digest("hex");
    return join(cacheDir, `${key}.json`);
  }

  #readCache(spec: McpServerSpec): McpTool[] | undefined {
    const path = this.#cachePath(spec);
    if (path === undefined) return undefined;
    try {
      const tools = JSON.parse(readFileSync(path, "utf8")) as unknown;
      return Array.isArray(tools) ? (tools as McpTool[]) : undefined;
    } catch {
      return undefined;
    }
  }

  #setTools(slot: Slot, tools: McpTool[]): void {
    slot.tools = this.#clean(tools);
    const path = this.#cachePath(slot.spec);
    if (path === undefined) return;
    const work = `${path}.${process.pid}.tmp`;
    try {
      mkdirSync(this.#options.cacheDir!, { recursive: true });
      writeFileSync(work, JSON.stringify(slot.tools));
      renameSync(work, path);
    } catch {
      // A cold start next time, nothing more.
      rmSync(work, { force: true });
    }
  }
}

/**
 * Whether a remote server wants a sign-in before it says anything. Used to tell the user before an
 * agent finds out; no configured value is sent, because a server that takes one has no need of this.
 * A server that cannot be reached answers `false`: that is a different problem and may pass.
 */
export async function needsOAuth(
  spec: Extract<McpServerSpec, { type: "http" }>,
  timeoutMs = 5000,
): Promise<boolean> {
  const client = new Client({ name: "eta", version: "1.0.0" });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(spec.url), {
        requestInit: { headers: spec.headers ?? {} },
      }),
      { timeout: timeoutMs },
    );
    return false;
  } catch (error) {
    return isUnauthorized(error);
  } finally {
    await client.close().catch(() => undefined);
  }
}
