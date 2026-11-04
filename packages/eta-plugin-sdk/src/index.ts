/** Public plugin contracts. Runtime services and module loading belong to the host. */
import type { CallFrame, StateSnapshot } from "@eta/client-wire-proto";

/** What a handler is given besides the call. */
export interface OpContext {
  /** Send a frame to the client that called. */
  reply: (frame: import("@eta/client-wire-proto").ServerFrame) => void;
}

/** What an action did, beyond what it returns. */
export interface DispatchOutcome {
  /** A frame the handler wants sent to every client (a fan-out, a native relay). */
  broadcast?: import("@eta/client-wire-proto").ServerFrame | undefined;
  /** What the call produced, for the reply frame. */
  result?: unknown | undefined;
  /** The handler answered for itself: the pipe adds nothing. */
  silent?: boolean | undefined;
}

export type OpHandler = (
  call: CallFrame,
  context: OpContext,
) => Promise<DispatchOutcome | undefined> | DispatchOutcome | undefined;

export interface OpMeta {
  description?: string | undefined;
  /** A JSON schema for `args`, published in `hello.ops` for clients that want to check. */
  schema?: unknown | undefined;
}

/** A target's state: what it shows, and when. */
export interface StateProjector {
  project: () => StateSnapshot;
  /** Include this target's state in `hello`, so a new client draws immediately. */
  eager?: boolean | undefined;
}

/** The plugin-facing wire surface; socket tables and registries remain private to the host. */
export interface WireApi {
  handle: (
    target: string,
    action: string,
    handler: OpHandler,
    meta?: OpMeta,
  ) => () => void;
  stateOf: (target: string, projector: StateProjector) => () => void;
  push: (target: string) => void;
  pushNow: (target: string) => void;
  event: (target: string, name: string, data: unknown) => void;
}

export interface SessionFacts {
  id: string;
  cwd: string;
  title?: string | undefined;
  running: boolean;
}

export interface SessionsListener {
  opened: (session: SessionFacts) => void;
  closed: (id: string) => void;
  focused: (id: string | undefined) => void;
  changed: (session: SessionFacts) => void;
}

export interface SessionsApi {
  /** Subscribe to session facts. Dispose the subscription when the plugin unloads. */
  subscribe: (listener: SessionsListener) => () => void;
}

export type PluginDisposer = () => void | Promise<void>;

export interface PluginLifecycle {
  /** Register effects synchronously. The host runs their cleanup on unload/reload.
   * Async work must be drained or prevented from publishing after cleanup.
   */
  effect: (execute: () => PluginDisposer) => unknown;
}

export interface PluginContext extends PluginLifecycle {
  wire: WireApi;
  warn?: ((message: string) => void) | undefined;
}

export interface SessionPluginContext extends PluginContext {
  sessions: SessionsApi;
}

/** A Cordis-compatible plugin, without a dependency on Cordis or a server implementation. */
export interface Plugin<C extends PluginLifecycle = PluginContext> {
  name: string;
  inject: string[];
  apply: (ctx: C) => unknown;
}
