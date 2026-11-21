// The client half of the pipe protocol (@eta/client-wire-proto), shared by the web page, the TUI
// and the phone app. Each of them only says how a socket is opened and where the state is kept
// (zustand for the page and the TUI, signals on the phone); the rules are here, once.
//
// - `hello` (the first frame, again after every reconnect): the ops, the mounted plugins and the
//   state of the eager targets, so a client draws before it asks for anything.
// - `state`: a target's sections, whole (a snapshot) or only those whose revision moved (a patch).
//   A client receives pushes for the targets it subscribed to, nothing else; eager targets are
//   merely included in `hello`.
// - `reply`: settles the call that asked. `event`: something happened on a target (ephemeral).
//
// Nothing polls: state arrives because it moved. A dropped connection is retried with a doubling
// pause, and the new socket starts from nothing, so every target that still has users is
// subscribed again (the host answers with a full snapshot) and every call whose reply can no
// longer arrive is rejected, never sent again.
//
// A connection can also die without closing (the network went away quietly, the computer slept):
// to a host that says `heartbeat` in its hello the wire sends a `ping` now and then, and one that
// stays unanswered counts as a drop. An older host is never pinged, so its silence means nothing.
// An attempt that never gets its hello (the handshake went into a void) is given up on too.
// `wake` is for the moments a client knows the network may be back (the app returned to the
// foreground, the system reported it online): retry now, or check the connection that looks open.

import type {
  CallFrame,
  ClientFrame,
  ErrorProblem,
  StatePatch,
  StateSnapshot,
} from "@eta/client-wire-proto";
import type { HelloFrame, ServerFrame } from "./index";
import type { MountedPlugin } from "./types";
import { SERVER_FRAME_TYPES, TARGET_MISSING } from "@eta/client-wire-proto";

/** What the client holds for one target. */
export interface TargetState {
  sections: Record<string, unknown>;
  revisions: Record<string, string>;
  /**
   * 0: the copy is not being kept up to date (it came with `hello`, or its last user has left).
   * Above 0: the copy last came from the state frames of a subscription that is still held. It
   * follows the host while the connection is open; between a drop and the next `hello` it may
   * lag behind the host.
   */
  version: number;
}

/**
 * `connecting`: the first attempt. `open`: the host said hello. `reconnecting`: the connection
 * dropped (or the first attempt failed) and another one is coming.
 */
export type WireStatus = "connecting" | "open" | "reconnecting";

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

export function initialWireState(): WireState {
  return {
    status: "connecting",
    ops: [],
    mounted: [],
    targets: {},
    missing: {},
    error: undefined,
  };
}

/** Where a wire keeps its state. zustand's `StoreApi<WireState>` is one. */
export interface WireStore {
  getState: () => WireState;
  setState: (
    update: Partial<WireState> | ((state: WireState) => Partial<WireState>),
  ) => void;
}

export interface WireEvent {
  name: string;
  data: unknown;
}

export type WireErrorCode =
  /** The host answered with an error; the message is its own. */
  | "server"
  /** There was no connection to ask on, or it dropped before the reply. */
  | "disconnected"
  /** No reply in time. */
  | "timeout";

export class WireError extends Error {
  readonly code: WireErrorCode;
  /** For a failure the host explains with a code (see `ErrorProblem`): what to translate. */
  readonly problem: ErrorProblem | undefined;
  constructor(code: WireErrorCode, message: string, problem?: ErrorProblem) {
    super(message);
    this.code = code;
    this.problem = problem;
  }
}

/** What a socket tells the wire. */
export interface WireSocketEvents {
  /**
   * The handshake completed. A socket that cannot tell (the phone's) never calls it, and counts as
   * open once the host says hello.
   */
  open: () => void;
  message: (text: string) => void;
  /** The socket is gone, whether it ever opened or not. Once. */
  close: () => void;
}

/** One socket, as the wire drives it. */
export interface WireSocket {
  send: (text: string) => void;
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

export interface WireOptions<Store extends WireStore = WireStore> {
  /** Open a socket that reports to `events`. It may fail by calling `close`. */
  open: (events: WireSocketEvents) => WireSocket;
  store: Store;
  /** How long a call waits for its reply. */
  callTimeoutMs?: number;
  /** The pause before the first retry, doubling up to `maxRetryMs`. */
  initialRetryMs?: number;
  maxRetryMs?: number;
  /** How often a host that answers pings is pinged. */
  heartbeatMs?: number;
  /**
   * How long a ping may go unanswered (nothing at all arriving) before the connection counts as
   * dropped; also how long a new socket may take to say hello before the attempt counts as failed.
   */
  heartbeatTimeoutMs?: number;
  observer?: WireObserver;
}

/** How often a connection is checked, and how long an answer may take. */
export const HEARTBEAT_MS = 15_000;
export const HEARTBEAT_TIMEOUT_MS = 10_000;

/** The part of a WebSocket (the browser's or Bun's) the wire uses; tests supply their own. */
export interface WebSocketLike {
  addEventListener: (
    type: "open" | "message" | "close" | "error",
    listener: (event: { data?: unknown }) => void,
  ) => void;
  send: (data: string) => void;
  close: () => void;
}

/** Drive a WebSocket: text frames are messages, and an error always ends in a close. */
export function fromWebSocket(
  socket: WebSocketLike,
  events: WireSocketEvents,
): WireSocket {
  socket.addEventListener("open", () => events.open());
  socket.addEventListener("message", (event) => {
    if (typeof event.data === "string") events.message(event.data);
  });
  socket.addEventListener("close", () => events.close());
  // A close always follows; closing again makes sure it does.
  socket.addEventListener("error", () => socket.close());
  return socket;
}

/** The part of a page (`window`, `document`) `wakeOnPageEvents` listens to. */
export interface PageEventSource {
  addEventListener: (type: string, listener: () => void) => void;
  removeEventListener: (type: string, listener: () => void) => void;
}

/**
 * Wake a wire when a browser page says the network may be back: it became visible again, or the
 * browser went online. Returns what stops listening.
 */
export function wakeOnPageEvents(
  wire: Pick<Wire, "wake">,
  page: {
    window: PageEventSource;
    document: PageEventSource & { visibilityState: string };
  },
): () => void {
  const visible = () => {
    if (page.document.visibilityState === "visible") wire.wake();
  };
  const online = () => wire.wake();
  page.document.addEventListener("visibilitychange", visible);
  page.window.addEventListener("online", online);
  return () => {
    page.document.removeEventListener("visibilitychange", visible);
    page.window.removeEventListener("online", online);
  };
}

/** The pause after `current`: doubled, up to `max`. */
export function nextRetryMs(current: number, max: number): number {
  return Math.min(current * 2, max);
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

/** One host's `/ws`, kept open across drops until `close`. Call `connect` once to begin. */
export class Wire<Store extends WireStore = WireStore> {
  readonly store: Store;
  private readonly openSocket: (events: WireSocketEvents) => WireSocket;
  private readonly callTimeoutMs: number;
  private readonly initialRetryMs: number;
  private readonly maxRetryMs: number;
  private readonly observer: WireObserver;
  private socket: WireSocket | undefined;
  /** Whether frames can be sent: the socket opened, or (one that cannot tell) said hello. */
  private live = false;
  /** Whether the current socket got its hello. */
  private greeted = false;
  private retryMs: number;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly heartbeatMs: number;
  private readonly heartbeatTimeoutMs: number;
  /** Whether the current socket's host answers pings (its hello said so). */
  private heartbeat = false;
  /** The next ping. */
  private beatTimer: ReturnType<typeof setTimeout> | undefined;
  /** Set while a ping waits for something, anything, to arrive. */
  private deadline: ReturnType<typeof setTimeout> | undefined;
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

  constructor(options: WireOptions<Store>) {
    this.store = options.store;
    this.openSocket = options.open;
    this.callTimeoutMs = options.callTimeoutMs ?? 30_000;
    this.initialRetryMs = options.initialRetryMs ?? 500;
    this.maxRetryMs = options.maxRetryMs ?? 10_000;
    this.heartbeatMs = options.heartbeatMs ?? HEARTBEAT_MS;
    this.heartbeatTimeoutMs =
      options.heartbeatTimeoutMs ?? HEARTBEAT_TIMEOUT_MS;
    this.observer = options.observer ?? {};
    this.retryMs = this.initialRetryMs;
  }

  /** Open the connection; it keeps itself open from here on, until `close`. */
  connect(): void {
    if (this.closed || this.socket !== undefined) return;
    this.greeted = false;
    const socket: WireSocket = this.openSocket({
      open: () => {
        if (this.socket === socket) this.opened();
      },
      message: (text) => {
        if (this.socket === socket) this.receive(text);
      },
      close: () => {
        if (this.socket === socket) this.lost();
      },
    });
    this.socket = socket;
    this.expect(socket);
  }

  /** Try again now instead of waiting out the pause. */
  retryNow(): void {
    if (this.closed || this.socket !== undefined) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.retryMs = this.initialRetryMs;
    this.connect();
  }

  /**
   * The network may be back: the app came to the foreground, or the system said it is online.
   * Without a connection, retry now instead of waiting out the pause; with one that looks open,
   * ping it at once, so one that died meanwhile is found out and replaced.
   */
  wake(): void {
    if (this.closed) return;
    if (this.socket === undefined) {
      this.retryNow();
      return;
    }
    if (this.greeted) this.beat();
  }

  /** Stop for good: no more retries, and every waiting call is rejected. */
  close(): void {
    this.closed = true;
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.stopHeartbeat();
    const socket = this.socket;
    this.socket = undefined;
    this.live = false;
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
    if (socket === undefined || !this.live)
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
   * stay, no longer followed, and the next subscription replaces them with a snapshot). The
   * returned function releases this user, once.
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
      if (this.eager.has(target)) {
        this.store.setState((state) => {
          const held = state.targets[target];
          if (held === undefined) return {};
          return {
            targets: { ...state.targets, [target]: { ...held, version: 0 } },
          };
        });
        return;
      }
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
    if (this.live) this.socket?.send(JSON.stringify(frame));
  }

  /** A fresh socket holds no subscriptions: ask again for everything somebody still reads. */
  private opened(): void {
    this.live = true;
    for (const target of this.users.keys())
      this.send({ op: "subscribe", target });
  }

  private receive(text: string): void {
    // Anything at all is an answer: the connection is alive.
    clearTimeout(this.deadline);
    this.deadline = undefined;
    let frame: unknown;
    try {
      frame = JSON.parse(text);
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
      // A pong says nothing beyond its arrival, which is all it is for.
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
    if (!this.live) this.opened();
    this.heartbeat = frame.heartbeat === true;
    this.scheduleBeat();
    this.observer.hello?.();
  }

  private state(frame: Extract<ServerFrame, { type: "state" }>): void {
    // A frame that was in flight when the last user left has nowhere to go.
    if (!this.users.has(frame.target)) return;
    const next = applyState(this.store.getState().targets[frame.target], frame);
    if (next === undefined) return;
    this.store.setState((state) => {
      const targets = { ...state.targets, [frame.target]: next };
      // Keep `missing` as it was unless this target was in it, so what reads it is not redrawn.
      if (!(frame.target in state.missing)) return { targets };
      const { [frame.target]: _found, ...missing } = state.missing;
      return { targets, missing };
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

  private scheduleBeat(): void {
    clearTimeout(this.beatTimer);
    this.beatTimer = undefined;
    if (!this.heartbeat) return;
    this.beatTimer = setTimeout(() => {
      this.beatTimer = undefined;
      this.beat();
    }, this.heartbeatMs);
  }

  /** Ping, and count the connection as dropped if nothing arrives in time. */
  private beat(): void {
    const socket = this.socket;
    if (socket === undefined || !this.heartbeat) return;
    this.scheduleBeat();
    if (this.deadline !== undefined) return;
    this.expect(socket);
    try {
      const frame: ClientFrame = { op: "ping" };
      socket.send(JSON.stringify(frame));
    } catch {
      // A socket that cannot send is no better than one nobody answers: the deadline decides.
    }
  }

  /** Unless something arrives on `socket` in time, count it as gone. */
  private expect(socket: WireSocket): void {
    clearTimeout(this.deadline);
    this.deadline = setTimeout(() => {
      this.deadline = undefined;
      if (this.socket !== socket) return;
      // Stop listening to it first: a socket whose peer is gone may take long to report its close.
      this.lost();
      socket.close();
    }, this.heartbeatTimeoutMs);
  }

  private stopHeartbeat(): void {
    this.heartbeat = false;
    clearTimeout(this.beatTimer);
    this.beatTimer = undefined;
    clearTimeout(this.deadline);
    this.deadline = undefined;
  }

  private lost(): void {
    const greeted = this.greeted;
    this.stopHeartbeat();
    this.socket = undefined;
    this.live = false;
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
    if (greeted) this.observer.dropped?.();
    else this.observer.attemptFailed?.();
  }
}
