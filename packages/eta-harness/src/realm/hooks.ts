import type { Authorizer, Effect } from "./realm";

/** One configured MCP server. */
export interface McpServerInfo {
  name: string;
  /** The tool count for connected/cached servers, 0 for disabled/failed. */
  toolCount: number;
  status:
    | "connected"
    | "cached"
    | "needs-auth"
    | "failed"
    | "disabled"
    | "not-connected";
  error?: string;
}

export interface McpToolInfo {
  name: string;
  description: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
}

export interface McpSearchResult {
  server: string;
  tool: McpToolInfo;
  score: number;
}

/**
 * MCP servers and tools.
 *
 * Provided by the host when running locally; absent in remote/daemon sessions.
 * The realm linker uses this to build `mcp:<server>` imports and `eta.mcp` exports.
 */
export interface McpSink {
  /** Server status, without connecting; read from the metadata cache. */
  servers: () => McpServerInfo[];
  /**
   * One server's tools for an `mcp:<server>` import: from the cache, or by
   * connecting when nothing is known yet. Rejects for an unknown server.
   */
  load: (server: string) => Promise<McpToolInfo[]>;
  /** Tool search over cached metadata, best first. Never connects. */
  search: (query: string) => McpSearchResult[];
  /** A server as a d.ts (`declare module "mcp:<server>"`), from cached metadata. Never connects. */
  describe: (server: string) => string;
  /** Calls one tool and returns its content; throws on error. */
  callTool: (
    server: string,
    tool: McpToolInfo,
    args: Record<string, unknown>,
    context?: { signal?: AbortSignal; toolCallId?: string },
  ) => Promise<unknown>;
}

/**
 * The seam between the runtime and whatever is hosting it.
 *
 * Nothing below is implemented here. esm-mode owns the realm, the module graph,
 * the effect ledger and `env.js`; everything that needs a session, a model, a
 * human or a platform service is a slot the host fills. The test for whether
 * this file is right is whether eta can be wired up without esm-mode learning
 * what a turn or a conversation is.
 */

export interface Frame {
  /** This frame's id. Stable for the duration of one run. */
  id: string;
  /** The frame that asked for this one, or `null` at the top. */
  parent: string | null;
  /** Monotonic per parent; orders siblings. */
  seq: number;
}

export interface MessageView {
  role: string;
  text: string;
}

export interface BudgetView {
  /** Total the turn may spend, in tokens. */
  limit: number;
  spent: number;
}

/** What a script sees as `ctx`. A function, not a value, where it would be big. */
export interface CtxView {
  frame: Frame;
  /** The last `count` messages. A method because materialising the transcript is wasteful. */
  messages: (count?: number) => Promise<MessageView[]>;
  budget: BudgetView;
}

export interface EmitSink {
  text: (text: string) => void;
  progress: (text: string) => void;
  image: (input: { mime: string; base64: string; alt?: string }) => void;
}

export interface EditRequest {
  path: string;
  find: string;
  replace: string;
}

export interface EditResult {
  ok: boolean;
  diff?: string;
  reason?: string;
}

export interface ToolsSink {
  /** Exact-match replacement. `fs.writeFile` overwrites; this refuses an ambiguous match. */
  edit: (request: EditRequest) => Promise<EditResult>;
  ask: (question: string) => Promise<string>;
}

/**
 * `eta.state`: a plain object a script reads and writes as `eta.state.x = y`.
 *
 * Top-level `const` does not outlive one evaluation (each is its own module), and
 * `globalThis` is the realm's, not the script's. This object is where a value goes
 * to reach the next call. The host owns it, so it survives a realm being rebuilt;
 * what of it is persisted (eta journals the JSON-able values) is the host's call.
 */
export type StateObject = Record<string, unknown>;

export interface MemorySink {
  append: (text: string) => Promise<void>;
  read: (query: string) => Promise<string>;
}

/**
 * A platform call.
 *
 * `kind` is what the ledger does with it: `det` is a deterministic local call,
 * `opaque` is a service whose behaviour we cannot inspect, `cost` is a paid
 * call that also draws down `ctx.budget`.
 */
export interface PlatformCall {
  (input: unknown): Promise<unknown>;
  kind?: "det" | "opaque" | "cost";
}

export interface SpawnRequest {
  prompt: string;
  model?: string;
}

export interface SpawnResult {
  text: string;
  effects: Effect[];
}

export interface AskRequest {
  prompt: string;
  model?: string;
  /**
   * Parent call stack: what was calling eta.ask.
   * Carried forward in recursion. The host merges this with the session
   * stack; the depth the runtime computes below is only what the runtime
   * itself can see — the host's own, longer stack wins.
   */
  parentStack?: string[];
  /**
   * Depth of this ask in the recursion, ≥1 for a first call. The runtime
   * stamps it so a host does not have to recount the stack it merged.
   */
  depth?: number;
}

export interface AskResult {
  /** Model's reply (with call stack prepended). */
  text: string;
  /** All effects produced in this turn. */
  effects: Effect[];
  /** Structured call stack. */
  stack: string[];
  /** Whether the turn completed successfully or was cancelled. */
  status: "completed" | "cancelled";
  /** Warning for deep recursion (≥10 layers). */
  warning?: string;
}

/**
 * The whole host surface.
 *
 * Every function here is optional: a realm with no hooks still evaluates
 * modules, it just has nothing to talk to. That is deliberate — the runtime
 * should be testable without a session, and a host should be able to start by
 * filling in only the slots it has.
 */
export interface Hooks {
  /** `console` from inside the realm. Debug output, not `emit`. */
  onConsole?: (level: string, line: string) => void;
  /** Called as each effect completes, so a host can stream rather than wait. */
  onEffect?: (effect: Effect) => void;
  /**
   * Asked before a binding reaches the host. Absent means everything runs, so
   * a host that has not written a policy yet is not silently gated.
   */
  authorize?: Authorizer;

  ctx?: () => CtxView;
  emit?: Partial<EmitSink>;
  tools?: Partial<ToolsSink>;
  memory?: MemorySink;
  /**
   * `eta.platform`: the host's services, one function each. A function form is
   * read when the `eta` module is first imported in a realm, so a host whose
   * services are registered after the agent was built still gets all of them.
   */
  platform?:
    | Record<string, PlatformCall>
    | (() => Record<string, PlatformCall>);
  /** `eta.state`, shared by every layer's `eta`. Absent means there is none. */
  state?: StateObject;
  /** MCP servers and tools. Absent in remote/daemon sessions. */
  mcp?: McpSink;
  /** A real sub-turn. Recursion, budget and cycles are the host's to enforce. */
  spawn?: (request: SpawnRequest) => Promise<SpawnResult>;
  /** Call the current agent with a new turn. Supports recursion and sees full history. */
  ask?: (request: AskRequest) => Promise<AskResult>;
}
