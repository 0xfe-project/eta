// The page's one connection to the host: a WebSocket speaking the pipe protocol
// (@eta/client-wire-proto). The server is a pipe: calls go in, replies, state and events come out,
// and what can be called is whatever `hello` says is registered.
//
// - `hello` (the first frame, again after every reconnect): the ops, the mounted plugins and the
//   state of the eager targets, so the page draws before it asks for anything.
// - `state`: a target's sections, whole (a snapshot) or only those whose revision moved (a patch).
//   A client receives pushes for the targets it subscribed to, nothing else; eager targets are
//   merely included in `hello`.
// - `reply`: settles the call that asked. `event`: something happened on a target (ephemeral).
//
// Nothing polls: state arrives because it moved. A dropped connection is retried with a growing
// pause, and the new socket starts from nothing, so every target that still has users is
// subscribed again (the server answers with a full snapshot) and every call whose reply can no
// longer arrive is rejected.

import type {
  HelloFrame,
  MountedPlugin,
  ServerFrame,
} from "@eta/client-contracts";
import type {
  CallFrame,
  ClientFrame,
  ErrorProblem,
  StatePatch,
  StateSnapshot,
} from "@eta/client-wire-proto";
import type { StoreApi } from "zustand/vanilla";
import { SERVER_FRAME_TYPES, TARGET_MISSING } from "@eta/client-wire-proto";
import { createStore } from "zustand/vanilla";

/** What the client holds for one target. */
export interface TargetState {
  sections: Record<string, unknown>;
  revisions: Record<string, string>;
  version: number;
}

/**
 * `connecting`: the first attempt. `open`: the host said hello. `reconnecting`: the connection
 * dropped (or the first attempt failed) and another one is coming.
 */
type WireStatus = "connecting" | "open" | "reconnecting";

export interface WireState {
  status: WireStatus;
  /** `hello.ops`: the name of everything callable, `target.action`. */
  ops: string[];
  /** `hello.mounted`: every plugin the host has, or the error that stopped it. */
  mounted: MountedPlugin[];
  /** Per target: what the client holds. Only targets with users, and the eager ones. */
  targets: Record<string, TargetState>;
  /**
   * The targets the host answered `target:missing` for: nothing is registered under the name (or
   * it was taken away while watched). Cleared when state arrives for it, and by a new connection.
   */
  missing: Record<string, true>;
  /** The last frame the host could not read at all. */
  error: string | undefined;
}

export type WireErrorCode =
  /** The host answered with an error; the message is its own. */
  | "server"
  /** There was no connection to ask on, or it dropped before the reply. */
  | "disconnected"
  /** No reply in time. */
  | "timeout";

export class WireError extends Error {
  constructor(
    readonly code: WireErrorCode,
    message: string,
    /** For a failure the host explains with a code (see `ErrorProblem`): what to translate. */
    readonly problem?: ErrorProblem,
  ) {
    super(message);
  }
}

/** The part of a browser WebSocket the client uses; tests supply their own. */
export type WireSocket = Pick<
  WebSocket,
  "addEventListener" | "close" | "readyState" | "send"
>;

export interface WireOptions {
  /** `ws://host/ws` or `wss://host/ws`. */
  url: string;
  store?: StoreApi<WireState>;
  createSocket?: (url: string) => WireSocket;
  /** How long a call waits for its reply. */
  callTimeoutMs?: number;
  /** The pause before the first retry, doubling up to `maxRetryMs`. */
  initialRetryMs?: number;
  maxRetryMs?: number;
}

export interface WireEvent {
  name: string;
  data: unknown;
}

const OPEN = 1;

function createWireStore(): StoreApi<WireState> {
  return createStore<WireState>(() => ({
    status: "connecting",
    ops: [],
    mounted: [],
    targets: {},
    missing: {},
    error: undefined,
  }));
}

/**
 * Fold a state frame into what the client holds for its target.
 *
 * A snapshot replaces everything. A patch carries the sections whose revision moved and every
 * current revision: a section absent from the revisions is gone (its plugin unloaded), one absent
 * from the sections is unchanged and keeps its identity, which is what lets a view skip it.
 * A patch for a target the client holds nothing for is dropped: it is a frame that was in flight
 * when the last user unsubscribed, and there is nothing to apply it to.
 */
export function applyState(
  previous: TargetState | undefined,
  frame: { version: number; snapshot?: StateSnapshot; patch?: StatePatch },
): TargetState | undefined {
  if (frame.snapshot !== undefined) {
    return {
      sections: { ...frame.snapshot.sections },
      revisions: { ...frame.snapshot.revisions },
      version: frame.version,
    };
  }
  if (frame.patch === undefined || previous === undefined) return undefined;
  const sections: Record<string, unknown> = {};
  for (const name of Object.keys(frame.patch.revisions)) {
    sections[name] =
      name in frame.patch.sections
        ? frame.patch.sections[name]
        : previous.sections[name];
  }
  return {
    sections,
    revisions: { ...frame.patch.revisions },
    version: frame.version,
  };
}

function isServerFrame(value: unknown): value is ServerFrame {
  if (typeof value !== "object" || value === null) return false;
  const type = (value as { type?: unknown }).type;
  return (SERVER_FRAME_TYPES as readonly unknown[]).includes(type);
}

interface Pending {
  resolve: (value: never) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class Wire {
  readonly store: StoreApi<WireState>;
  private readonly url: string;
  private readonly createSocket: (url: string) => WireSocket;
  private readonly callTimeoutMs: number;
  private readonly initialRetryMs: number;
  private readonly maxRetryMs: number;
  private socket: WireSocket | undefined;
  private retryMs: number;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  private requests = 0;
  private readonly pending = new Map<string, Pending>();
  /** Per target: how many users want it. The socket is subscribed while this is above zero. */
  private readonly users = new Map<string, number>();
  /** The targets `hello` carried state for: kept when their last user leaves. */
  private eager = new Set<string>();
  private readonly listeners = new Map<
    string,
    Set<(event: WireEvent) => void>
  >();

  constructor(options: WireOptions) {
    this.url = options.url;
    this.store = options.store ?? createWireStore();
    this.createSocket =
      options.createSocket ?? ((url) => new WebSocket(url) as WireSocket);
    this.callTimeoutMs = options.callTimeoutMs ?? 30_000;
    this.initialRetryMs = options.initialRetryMs ?? 500;
    this.maxRetryMs = options.maxRetryMs ?? 10_000;
    this.retryMs = this.initialRetryMs;
  }

  /** Open the connection; it keeps itself open from here on. */
  connect(): void {
    if (this.closed || this.socket !== undefined) return;
    const socket = this.createSocket(this.url);
    this.socket = socket;
    socket.addEventListener("open", () => {
      if (this.socket !== socket) return;
      // A fresh socket holds no subscriptions: ask again for everything somebody still reads.
      for (const target of this.users.keys())
        this.send({ op: "subscribe", target });
    });
    socket.addEventListener("message", (event) => {
      if (this.socket === socket) this.receive(event.data);
    });
    socket.addEventListener("close", () => {
      if (this.socket === socket) this.dropped();
    });
    // A close always follows; closing again makes sure it does.
    socket.addEventListener("error", () => socket.close());
  }

  /** Stop for good: no more retries, and nothing waits for a reply any more. */
  close(): void {
    this.closed = true;
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    const socket = this.socket;
    this.socket = undefined;
    this.rejectPending("connection closed");
    socket?.close();
  }

  /** Whether the host registered `target.action` (as of the last hello). */
  can(op: string): boolean {
    return this.store.getState().ops.includes(op);
  }

  /**
   * Call `target.action` and wait for the reply. Rejects with the host's own message; a call made
   * without a connection rejects at once instead of waiting for one that may never come, and one
   * the connection dropped under rejects too: a retry would be a second try at something that
   * may have happened.
   */
  call<T = unknown>(
    target: string,
    action: string,
    args?: unknown,
    options: { timeoutMs?: number } = {},
  ): Promise<T> {
    const socket = this.socket;
    if (socket === undefined || socket.readyState !== OPEN)
      return Promise.reject(new WireError("disconnected", "not connected"));
    this.requests += 1;
    const requestId = `c${this.requests}`;
    const frame: CallFrame = {
      op: "call",
      target,
      action,
      requestId,
      ...(args === undefined ? {} : { args }),
    };
    const timeoutMs = options.timeoutMs ?? this.callTimeoutMs;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new WireError("timeout", `${target}.${action} timed out`));
      }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      try {
        socket.send(JSON.stringify(frame));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(
          new WireError(
            "disconnected",
            error instanceof Error ? error.message : String(error),
          ),
        );
      }
    });
  }

  /**
   * Want a target's state. The first user subscribes on the socket; the last one to leave
   * unsubscribes, and the target's state goes with it (unless `hello` carried it: eager targets
   * stay, and the next subscription replaces them with a snapshot). The returned function
   * releases this user, once.
   */
  subscribe(target: string): () => void {
    if (this.closed) return () => undefined;
    const count = this.users.get(target) ?? 0;
    this.users.set(target, count + 1);
    if (count === 0) this.send({ op: "subscribe", target });
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = (this.users.get(target) ?? 1) - 1;
      if (left > 0) {
        this.users.set(target, left);
        return;
      }
      this.users.delete(target);
      this.send({ op: "unsubscribe", target });
      if (this.eager.has(target)) return;
      this.store.setState((state) => {
        const { [target]: _released, ...targets } = state.targets;
        const { [target]: _answered, ...missing } = state.missing;
        return { targets, missing };
      });
    };
  }

  /** Listen to what a target says happened. Only the targets subscribed to send events. */
  onEvent(target: string, listener: (event: WireEvent) => void): () => void {
    const listening = this.listeners.get(target) ?? new Set();
    listening.add(listener);
    this.listeners.set(target, listening);
    return () => {
      listening.delete(listener);
      if (listening.size === 0) this.listeners.delete(target);
    };
  }

  private send(frame: ClientFrame): void {
    if (this.socket?.readyState === OPEN)
      this.socket.send(JSON.stringify(frame));
  }

  private receive(data: unknown): void {
    if (typeof data !== "string") return;
    let frame: unknown;
    try {
      frame = JSON.parse(data);
    } catch {
      return;
    }
    if (!isServerFrame(frame)) return;
    switch (frame.type) {
      case "hello":
        this.hello(frame);
        return;
      case "state":
        this.state(frame);
        return;
      case "event":
        if (frame.name === TARGET_MISSING) {
          this.store.setState((state) => ({
            missing: { ...state.missing, [frame.target]: true },
          }));
          return;
        }
        for (const listener of [...(this.listeners.get(frame.target) ?? [])])
          listener({ name: frame.name, data: frame.data });
        return;
      case "reply":
        this.reply(frame);
        return;
      case "error":
        this.store.setState({ error: frame.message });
    }
  }

  private hello(frame: HelloFrame): void {
    this.retryMs = this.initialRetryMs;
    this.eager = new Set(Object.keys(frame.state));
    const held = this.store.getState().targets;
    const targets: Record<string, TargetState> = {};
    // What somebody still reads stays on screen until its new snapshot lands.
    for (const target of this.users.keys()) {
      const previous = held[target];
      if (previous !== undefined) targets[target] = previous;
    }
    for (const [target, snapshot] of Object.entries(frame.state)) {
      targets[target] = {
        sections: { ...snapshot.sections },
        revisions: { ...snapshot.revisions },
        version: 0,
      };
    }
    this.store.setState({
      status: "open",
      ops: frame.ops.map((op) => op.name),
      mounted: frame.mounted,
      targets,
      missing: {},
      error: undefined,
    });
  }

  private state(frame: Extract<ServerFrame, { type: "state" }>): void {
    // A frame that was in flight when the last user left has nowhere to go.
    if (!this.users.has(frame.target)) return;
    const next = applyState(this.store.getState().targets[frame.target], frame);
    if (next === undefined) return;
    this.store.setState((state) => {
      const { [frame.target]: _found, ...missing } = state.missing;
      return {
        targets: { ...state.targets, [frame.target]: next },
        missing,
      };
    });
  }

  private reply(frame: Extract<ServerFrame, { type: "reply" }>): void {
    const waiter = this.pending.get(frame.requestId);
    if (waiter === undefined) return;
    this.pending.delete(frame.requestId);
    clearTimeout(waiter.timer);
    if (frame.ok) waiter.resolve(frame.result as never);
    else waiter.reject(new WireError("server", frame.error, frame.problem));
  }

  private rejectPending(message: string): void {
    for (const [requestId, waiter] of this.pending) {
      clearTimeout(waiter.timer);
      waiter.reject(new WireError("disconnected", message));
      this.pending.delete(requestId);
    }
  }

  private dropped(): void {
    this.socket = undefined;
    this.rejectPending("connection closed");
    this.store.setState({ status: "reconnecting" });
    if (this.closed) return;
    const delay = this.retryMs;
    this.retryMs = Math.min(this.retryMs * 2, this.maxRetryMs);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      this.connect();
    }, delay);
  }
}

/** The host's socket: `/ws` on the page's own origin, `wss` under https. */
export function wireUrl(location: Pick<Location, "host" | "protocol">): string {
  return `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
}

let shared: Wire | undefined;

/** The page's one connection, opened on first use. */
export function getWire(): Wire {
  if (shared === undefined) {
    shared = new Wire({ url: wireUrl(window.location) });
    shared.connect();
  }
  return shared;
}

/** Replace the page's connection; a test installs a fake, `undefined` forgets it. */
export function setWire(wire: Wire | undefined): void {
  shared?.close();
  shared = wire;
}
