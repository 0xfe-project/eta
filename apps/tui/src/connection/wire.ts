// Adapted from apps/web/src/lib/wire.ts: the same frames and the same client state, over Bun's
// WebSocket, which can send the token as a bearer header.
//
// The TUI's one connection to a host: a WebSocket speaking the pipe protocol
// (@eta/client-wire-proto). Calls go in; replies, state and events come out; what can be called
// is whatever `hello` says is registered.
//
// - `hello` (the first frame, again after every reconnect): the ops, the mounted plugins and the
//   state of the eager targets.
// - `state`: a target's sections, whole (a snapshot) or only those whose revision moved (a patch).
//   Pushes come for the targets subscribed to; eager targets are only included in `hello`.
// - `reply`: settles the call that asked. `event`: something happened on a target.
//
// A dropped connection is retried with a doubling pause. The new socket starts from nothing, so
// every target that still has users is subscribed again (the host answers with a snapshot) and
// every call whose reply can no longer arrive is rejected.

import type { HelloFrame, ServerFrame } from "@eta/client-contracts";
import type {
  CallFrame,
  ClientFrame,
  ErrorProblem,
  StatePatch,
  StateSnapshot,
} from "@eta/client-wire-proto";
import type { StoreApi } from "zustand/vanilla";
import type { TargetState, WireClient, WireEvent, WireState } from "./types";
import { SERVER_FRAME_TYPES, TARGET_MISSING } from "@eta/client-wire-proto";
import { createStore } from "zustand/vanilla";

export type WireErrorCode =
  /** The host answered with an error; the message is its own. */
  | "server"
  /** There was no connection to ask on, or it dropped before the reply. */
  | "disconnected"
  /** No reply in time. */
  | "timeout";

export class WireError extends Error {
  readonly code: WireErrorCode;
  /** For a failure the host explains with a code: what to translate. */
  readonly problem: ErrorProblem | undefined;
  constructor(code: WireErrorCode, message: string, problem?: ErrorProblem) {
    super(message);
    this.code = code;
    this.problem = problem;
  }
}

/** The part of a WebSocket the client uses; tests supply their own. */
export interface WireSocket {
  readonly readyState: number;
  addEventListener: (
    type: "open" | "message" | "close" | "error",
    listener: (event: { data?: unknown }) => void,
  ) => void;
  send: (data: string) => void;
  close: () => void;
}

/** What the owner of a wire is told about its connection, beyond the store. */
export interface WireObserver {
  /** The host said hello: a connection is up. */
  hello?: () => void;
  /** A socket closed without a hello: the attempt failed (refused, or not let in). */
  attemptFailed?: () => void;
  /** A connection that had said hello dropped. */
  dropped?: () => void;
}

export interface WireOptions {
  /** `ws://host/ws` or `wss://host/ws`. */
  url: string;
  /** Sent as `Authorization: Bearer <token>`. */
  token?: string;
  createSocket?: (url: string, token: string | undefined) => WireSocket;
  /** How long a call waits for its reply. */
  callTimeoutMs?: number;
  /** The pause before the first retry, doubling up to `maxRetryMs`. */
  initialRetryMs?: number;
  maxRetryMs?: number;
  observer?: WireObserver;
}

const OPEN = 1;
const DEFAULT_CALL_TIMEOUT_MS = 30_000;
const DEFAULT_INITIAL_RETRY_MS = 500;
const DEFAULT_MAX_RETRY_MS = 5_000;

/** The pause after `current`: doubled, up to `max`. */
export function nextRetryMs(current: number, max: number): number {
  return Math.min(current * 2, max);
}

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

function bunSocket(url: string, token: string | undefined): WireSocket {
  return (token === undefined
    ? new WebSocket(url)
    : new WebSocket(url, {
        headers: { Authorization: `Bearer ${token}` },
      })) as unknown as WireSocket;
}

/**
 * Fold a state frame into what the client holds for its target.
 *
 * A snapshot replaces everything. A patch carries the sections whose revision moved and every
 * current revision: a section absent from the revisions is gone, one absent from the sections is
 * unchanged and keeps its identity. A patch for a target the client holds nothing for is dropped.
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

/** One host's `/ws`, kept open across drops until `close`. Call `connect` once to begin. */
export class Wire implements WireClient {
  readonly store: StoreApi<WireState>;
  private readonly url: string;
  private readonly token: string | undefined;
  private readonly createSocket: (
    url: string,
    token: string | undefined,
  ) => WireSocket;
  private readonly callTimeoutMs: number;
  private readonly initialRetryMs: number;
  private readonly maxRetryMs: number;
  private readonly observer: WireObserver;
  private socket: WireSocket | undefined;
  /** Whether the current socket got its hello. */
  private greeted = false;
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
    this.token = options.token;
    this.store = createWireStore();
    this.createSocket = options.createSocket ?? bunSocket;
    this.callTimeoutMs = options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
    this.initialRetryMs = options.initialRetryMs ?? DEFAULT_INITIAL_RETRY_MS;
    this.maxRetryMs = options.maxRetryMs ?? DEFAULT_MAX_RETRY_MS;
    this.observer = options.observer ?? {};
    this.retryMs = this.initialRetryMs;
  }

  /** Open the connection; it keeps itself open from here on, until `close`. */
  connect(): void {
    if (this.closed || this.socket !== undefined) return;
    const socket = this.createSocket(this.url, this.token);
    this.socket = socket;
    this.greeted = false;
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
      if (this.socket === socket) this.lost();
    });
    // A close always follows; closing again makes sure it does.
    socket.addEventListener("error", () => socket.close());
  }

  /** Stop for good: no more retries, and every waiting call is rejected. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    const socket = this.socket;
    this.socket = undefined;
    this.rejectPending("connection closed");
    if (this.store.getState().status === "open")
      this.store.setState({ status: "reconnecting" });
    socket?.close();
  }

  can(op: string): boolean {
    return this.store.getState().ops.includes(op);
  }

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
    this.greeted = true;
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
    this.observer.hello?.();
  }

  private state(frame: Extract<ServerFrame, { type: "state" }>): void {
    // A frame that was in flight when the last user left has nowhere to go.
    if (!this.users.has(frame.target)) return;
    const next = applyState(this.store.getState().targets[frame.target], frame);
    if (next === undefined) return;
    this.store.setState((state) => {
      const { [frame.target]: _found, ...missing } = state.missing;
      return { targets: { ...state.targets, [frame.target]: next }, missing };
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

  private lost(): void {
    const hadHello = this.greeted;
    this.socket = undefined;
    this.greeted = false;
    this.rejectPending("connection closed");
    this.store.setState({ status: "reconnecting" });
    if (this.closed) return;
    const delay = this.retryMs;
    this.retryMs = nextRetryMs(this.retryMs, this.maxRetryMs);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      this.connect();
    }, delay);
    if (hadHello) this.observer.dropped?.();
    else this.observer.attemptFailed?.();
  }
}
