import type { PromptImage } from "./operations";
import type { ToolActivity } from "./product";

/**
 * The link between the primary and a machine that runs the daemon.
 *
 * One outbound WebSocket, dialed by the daemon, carrying three kinds of traffic in a JSON
 * envelope:
 *
 * - `pipe`: the eta wire protocol. The daemon is a pipe server (it hosts the sessions that run on
 *   its machine) and the primary is its client, so frames go primary to daemon as client frames
 *   (call, subscribe, unsubscribe) and daemon to primary as server frames (hello, reply, state,
 *   event, error). Nothing here knows what those frames say.
 * - `svc`: calls the other way round, which the primary answers. The daemon has no provider keys,
 *   no database and no product plugins, so it asks the primary to generate with a model, to run
 *   a product tool, and to hear about a question. A call has an id, may stream events back, may
 *   be cancelled, and is never replayed: a call cut by a lost link fails as an unknown outcome.
 * - `ctl`: the link itself: who you are talking to, whether the machine has been approved, and
 *   heartbeats.
 *
 * Everything is bounded: a frame, the calls in flight, how long a call may take, how long the
 * other side may be silent.
 */

/** Where a daemon dials, and where it trades an install code for a credential. */
export const LINK_PATH = "/machines/connect";
export const ENROLL_PATH = "/machines/enroll";

export const LINK_LIMITS = {
  /** The largest text frame either side accepts, in bytes. */
  maxFrameBytes: 8 * 1024 * 1024,
  /** Calls one side will have running for the other at once. */
  maxInFlight: 64,
  /** How long an ordinary call may take. */
  callTimeoutMs: 30_000,
  /** How long a run (a whole turn on the daemon) may take. */
  runTimeoutMs: 2 * 60 * 60 * 1000,
  /** How often the daemon speaks when nothing else does. */
  heartbeatMs: 15_000,
  /** How long either side waits in silence before it calls the link dead. */
  silenceMs: 45_000,
} as const;

/** WebSocket close codes this link uses (4000 to 4999 are free for applications). */
export const LINK_CLOSE = {
  tooBig: 1009,
  /** A newer connection from the same device took this one's place. */
  superseded: 4001,
  /** The device was revoked. */
  revoked: 4003,
  /** The other side went silent. */
  silent: 4004,
  /** The protocol was broken. */
  protocol: 4005,
} as const;

export type LinkEnvelope =
  | { ch: "pipe"; frame: unknown }
  | { ch: "svc"; msg: SvcMessage }
  | { ch: "ctl"; msg: CtlMessage };

export type SvcMessage =
  | { op: "call"; id: string; method: string; params?: unknown }
  | { op: "event"; id: string; event: unknown }
  | { op: "reply"; id: string; ok: true; result?: unknown }
  | { op: "reply"; id: string; ok: false; error: string }
  | { op: "cancel"; id: string }
  | { op: "notify"; method: string; params?: unknown };

export type CtlMessage =
  /** From the primary, first: which machine this is, which connection, and whether it is in. */
  | {
      op: "welcome";
      machineId: string;
      epoch: number;
      status: "pending" | "approved";
    }
  /** From the primary, once a pending machine has been approved. */
  | { op: "approved" }
  | { op: "ping" }
  | { op: "pong" };

/** What a daemon says about itself when it enrols. */
export interface EnrollRequest {
  code: string;
  /** SHA-256 of the device secret, lowercase hex: the fingerprint both sides show. */
  fingerprint: string;
  hostname: string;
  home: string;
  os: string;
}
export interface EnrollResponse {
  machineId: string;
}

/** The facts a machine reports about itself. */
export interface MachineFacts {
  hostname: string;
  home: string;
  os: string;
  version: string;
}

/**
 * What the daemon can be asked over the pipe, beyond the `sessions.*` actions every eta server
 * has: `machine.<action>` calls. They are quick ones. The pipe applies a connection's frames in
 * order, so anything that can take long (a run, a script) is a `svc` call instead
 * (`DaemonServiceParams`), which runs alongside.
 */
export interface MachineActionArgs {
  info: Record<string, never>;
  /** Is this an existing directory on the machine? */
  stat: { path: string };
  /**
   * Bring the session of one agent in a conversation in line with the agent, creating it when
   * `session` is not given. The agent's words, the tools it has and the model it uses are the
   * primary's, so they come with the call.
   */
  open: OpenSessionArgs;
  /** Tell the daemon about models it may be asked to switch to (definitions, no credentials). */
  catalog: { models: ModelSpec[] };
  /** What the session is configured with now. */
  config: { session: string };
  /** Which of these bundle contents (by hash) are not on the machine yet. */
  bundleHave: { hashes: string[] };
  /** Keep a bundle's files (path to base64 data) under their hash. */
  bundlePut: {
    hash: string;
    files: Record<string, { data: string; exec?: boolean | undefined }>;
  };
  /** Which of these commands are on the machine's PATH. */
  which: { commands: string[] };
  /** GitHub was connected, authorized or disconnected: ask the primary for the token again now. */
  githubRefresh: Record<string, never>;
}
export interface MachineActionResults {
  info: MachineFacts;
  stat: { ok: true } | { ok: false; reason: string };
  open: { session: string };
  catalog: Record<string, never>;
  config: { model: string | undefined; thinkingLevel: string };
  bundleHave: { missing: string[] };
  bundlePut: Record<string, never>;
  which: { found: string[] };
  githubRefresh: Record<string, never>;
}

/** What the primary asks of the daemon that may take a while (`svc` calls). */
export interface DaemonServiceParams {
  /** Give the session some words as its next run and wait until it is quiet. */
  run: { session: string; text: string; images?: PromptImage[] };
  /** Run a script on the machine, the way the SSH transport does. */
  exec: { script: string; inputBase64?: string; timeoutMs?: number };
}
export interface DaemonServiceResults {
  run: RunOutcome;
  exec: {
    code: number;
    stdout: string;
    stderr: string;
    timedOut?: boolean;
    aborted?: boolean;
  };
}

/** A tool the primary offers a remote session; the daemon registers one that calls back. */
export interface ToolSpec {
  name: string;
  description?: string;
  /** A JSON schema. */
  parameters: unknown;
}

/** A model, as the daemon needs to know it: nothing that reaches a provider. */
export type ModelSpec = Record<string, unknown> & {
  id: string;
  provider: string;
  /** What the model was asked for by, when that is not its own name (a placeholder, an alias). */
  lookup?: { provider: string; id: string };
};

export interface OpenSessionArgs {
  /** Reopen this session; absent means make a new one. */
  session?: string;
  cwd: string;
  title: string;
  agentId: string;
  conversationId: string;
  /** `provider:modelId`. */
  model?: string;
  thinkingLevel?: string;
  persona?: string;
  /** Who the agent is and what it was told; the daemon puts it in the platform section. */
  agentPrompt: string;
  /** What the prompt and persona were read from; a session opened with another is reopened. */
  stamp: string;
  /** The persona cards the user keeps on the primary; the daemon has its own and builtin ones. */
  personaCards?: { id: string; name: string; content: string }[];
  /** The model's definition, so the daemon can resolve it without a catalog. */
  modelSpec?: ModelSpec;
  tools: ToolSpec[];
  /**
   * The primary's akhook layers, as text: rules the daemon applies after its own user and project
   * files, which cannot disable or replace them. Sent with every open, so a change reaches a
   * session that is already there at its next wake.
   */
  akhook?: { name: string; text: string }[];
  /**
   * The bundles the agent loads, already on the machine (`bundleHave`, `bundlePut`). The config
   * values are what its MCP servers and hook commands are started with: they go no further, and
   * the machine does not write them down.
   */
  bundles?: OpenedBundle[];
  /**
   * The agent's key for the primary's LLM gateway (`/llm/v1` on the primary's address), when it
   * has one. It opens `/v1` and nothing else; the bundles' MCP servers get it as
   * `${ETA_AGENT_KEY}`, held in memory like the config values.
   */
  gatewayKey?: string;
}

/** A bundle in an `open`: which contents, and the values its processes get. */
export interface OpenedBundle {
  name: string;
  hash: string;
  config: Record<string, string>;
  /** Its required values are all there; when not, only its skills load. */
  configured: boolean;
}

export interface RunOutcome {
  status: "completed" | "aborted" | "failed";
  error?: string;
  text: string;
  thinking: string;
  /** The tool calls the run made, shortened for the reply's row; absent when there were none. */
  activity?: ToolActivity[];
}

/** What the daemon asks of the primary (`svc` calls). */
export interface ServiceMethodParams {
  /** Generate. Streams the provider's events back; the reply is the final message. */
  "model.stream": {
    session: string;
    model: { provider: string; id: string };
    context: unknown;
    options?: Record<string, unknown>;
  };
  /** Run one of the primary's tools for a session. */
  "tool.call": {
    session: string;
    name: string;
    toolCallId: string;
    args: unknown;
  };
  /** Does the user want to be asked before this tool runs? */
  "tool.gate": { session: string; name: string };
  /**
   * Read, write or forget a piece of an MCP server's OAuth state. The credentials are the
   * primary's, one set per server URL (`serverKey` is a hash of it); a daemon refreshing a token
   * saves it here. A login's PKCE verifier is not relayed: signing in is the primary's.
   */
  "mcp.credential": McpCredentialCall;
  /**
   * The token for git and gh on this machine, and the commit identity: the user's once they
   * authorized the GitHub App, else the App's installation token. Answers `null` when GitHub is
   * not connected. The App's key and secrets stay on the primary; the machine keeps the token
   * (at most an hour old) and asks again before it expires. The result is a `GitHubCredentials`.
   */
  "github.credentials": Record<string, never>;
}

/** The pieces of OAuth state a daemon may ask for. */
export type McpRelayedKind = "tokens" | "clientInformation" | "discoveryState";

export type McpCredentialCall =
  | { op: "get"; serverKey: string; kind: McpRelayedKind }
  | { op: "set"; serverKey: string; kind: McpRelayedKind; value: unknown }
  | { op: "delete"; serverKey: string; kind: McpRelayedKind };

/** What the daemon tells the primary without waiting (`svc` notifications). */
export interface ServiceNotifyParams {
  "ask.observe": {
    session: string;
    action: "asked" | "answered" | "canceled" | "expired";
    payload: unknown;
  };
}
