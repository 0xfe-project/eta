// Derived from pi-mcp-adapter/types.ts (MIT, see ../NOTICE), cut to what a harness-agnostic library needs.
/**
 * The vocabulary of the library: configuration, cached metadata, tool results and the hooks a
 * caller injects. Plain data, no behaviour.
 *
 * Shaped after pi-mcp-adapter's `types.ts` (MIT), cut down to what a harness-agnostic library
 * needs: no UI sessions, prompts, resources or panel callbacks.
 */
import type { OAuthClientProvider } from "@modelcontextprotocol/client";

/** `lazy` connects on first use and idles out; the keep-alive modes stay up (see the manager). */
export type McpLifecycle = "lazy" | "keep-alive" | "lazy-keep-alive";

/** `true`: every tool needs approval; a list: tools by name or glob; `"destructive"`: by annotations. */
export type ApproveTools = boolean | "destructive" | string[];

export type McpAuthMode = "oauth" | "bearer" | false;

/**
 * One server as written in an `mcp.json`: the standard `mcpServers` shape plus the adapter's
 * fields. Unknown fields are ignored on load.
 */
export interface McpServerEntry {
  /** One line the model sees when it lists or searches this server. */
  description?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** Pass the host's whole environment to a stdio server. Off by default: only PATH, HOME and what `env` adds. */
  inheritEnv?: boolean;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  /** Pins the transport; without it a `url` is tried as streamable HTTP, then as legacy SSE. */
  type?: "stdio" | "http" | "streamable-http" | "sse";
  /** `"oauth"` asks the injected `authProviderFor`; `"bearer"` sends `bearerToken`/`bearerTokenEnv`. */
  auth?: McpAuthMode;
  bearerToken?: string;
  bearerTokenEnv?: string;
  lifecycle?: McpLifecycle;
  /** Minutes; overrides the manager's default, 0 disables idle shutdown. */
  idleTimeout?: number;
  requestTimeoutMs?: number;
  /** `true`: every tool of the server is a direct tool; a list: just those. */
  directTools?: boolean | string[];
  /** Extra words that make `search` find a tool; keys are tool names or globs. */
  searchKeywords?: Record<string, string[]>;
  approveTools?: ApproveTools;
  includeTools?: string[];
  excludeTools?: string[];
  disabled?: boolean;
}

/** A named set of servers, e.g. one `mcp.json`. Later sources override earlier ones by server name. */
export interface McpConfigSource {
  /** Shown as the server's origin in `status`. */
  name: string;
  servers: Record<string, McpServerEntry>;
}

/** A server after the sources are merged. */
export interface McpServerDefinition extends McpServerEntry {
  name: string;
  /** The source that won. */
  source: string;
  /** Changes when anything that decides what the server exposes changes; keys the metadata cache. */
  hash: string;
}

export interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

/** A tool as the server declared it (before `includeTools`/`excludeTools`). */
export interface ToolMeta {
  name: string;
  description: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
  annotations?: ToolAnnotations;
}

/** Field names and broad JSON types seen in earlier results of a tool without an `outputSchema`. */
export interface ObservedOutputRecord {
  source: "structuredContent" | "jsonText";
  shape: unknown;
  /** Identifies the tool definition the shape was learned against. */
  toolKey: string;
}

export interface ServerCacheEntry {
  configHash: string;
  tools: ToolMeta[];
  instructions?: string;
  outputShapes?: Record<string, ObservedOutputRecord>;
  /** Discovery was tried and failed; it is not retried until the config changes. */
  discoveryFailed?: true;
  cachedAt: number;
}

export interface MetadataCacheFile {
  version: 1;
  servers: Record<string, ServerCacheEntry>;
}

export interface TextBlock {
  type: "text";
  text: string;
}
export interface ImageBlock {
  type: "image";
  data: string;
  mimeType: string;
}
export type ContentBlock = TextBlock | ImageBlock;

/**
 * What a tool execution returns. `isError` is set for every failure; `details.error` carries a
 * stable code (`tool_error`, `call_failed`, `server_backoff`, ...) and `details.delivery` says
 * whether a failed call may have run.
 */
export interface McpToolResult {
  content: ContentBlock[];
  isError?: boolean;
  details: Record<string, unknown>;
}

export interface McpExecuteContext {
  signal?: AbortSignal;
  /** Forwarded to hooks so a harness can tie the approval to its own call. */
  toolCallId?: string;
}

/** A tool definition any harness can register: a name, a JSON schema, a description and `execute`. */
export interface McpToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: unknown, ctx?: McpExecuteContext) => Promise<McpToolResult>;
}

/**
 * - `not_sent`: the request never left; the tool did not run.
 * - `may_have_run`: the request was sent and its outcome is unknown.
 * - `server_error`: the server answered with a JSON-RPC error.
 * - `invalid_result`: the server answered, but the result failed validation.
 */
export type McpDelivery =
  | "not_sent"
  | "may_have_run"
  | "server_error"
  | "invalid_result";

export interface ToolCallInfo {
  /** `mcp__<server>__<tool>`: what policy rules (akhook) see for an MCP tool. */
  name: string;
  server: string;
  tool: string;
  args: Record<string, unknown>;
  toolCallId: string | undefined;
}

/** Return `{ block }` (or throw) to veto the call; its reason goes to the model. */
export type ToolCallDecision = void | undefined | { block: string };

export interface ElicitationRequest {
  server: string;
  /** The request as the server sent it (`mode: "form"` with a `requestedSchema`, or `"url"`). */
  params: Record<string, unknown>;
  signal: AbortSignal | undefined;
}

export type ElicitationResponse =
  | {
      action: "accept";
      content: Record<string, string | number | boolean | string[]>;
    }
  | { action: "decline" }
  | { action: "cancel" };

/** What the caller injects. Everything is optional. */
export interface McpHooks {
  /** Asked when a server needs input mid-call. The caller maps the forms it can; return cancel otherwise. */
  elicit?: (request: ElicitationRequest) => Promise<ElicitationResponse>;
  /** Called before every call made through the library. */
  onToolCall?: (
    call: ToolCallInfo,
  ) => ToolCallDecision | Promise<ToolCallDecision>;
}

export interface AuthProviderContext {
  owner: string;
  server: string;
  url: string;
}

/** Answers `auth: "oauth"`; undefined means this caller has no OAuth for the server. */
export type AuthProviderFor = (
  serverKey: string,
  context: AuthProviderContext,
) => OAuthClientProvider | undefined;

export type ServerState =
  | "connected"
  | "cached"
  | "not-connected"
  | "failed"
  | "needs-auth"
  | "disabled";

export interface ServerStatus {
  name: string;
  source: string;
  state: ServerState;
  toolCount: number;
  lifecycle: McpLifecycle;
  /** Set while `failed` (inside the backoff window) and for `needs-auth`. */
  error?: string;
  failedAgoSeconds?: number;
  description?: string;
}
