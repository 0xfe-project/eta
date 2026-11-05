// The app's one connection to the host: a WebSocket speaking the pipe protocol
// (@eta/client-wire-proto). This is apps/web/src/lib/wire.ts with signals in place of the zustand
// store and a socket the runtime can give: same frames, same rules. Nothing polls; a dropped
// connection is retried with a growing pause and the new socket subscribes again to every target
// that still has users; a call whose reply can no longer arrive is rejected, never replayed.

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
import type { Signal } from "nsh";
import { SERVER_FRAME_TYPES, TARGET_MISSING } from "@eta/client-wire-proto";
import { batch, signal, untracked } from "nsh";

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
export type WireStatus = "connecting" | "open" | "reconnecting";

/** Why a socket could not open, so the connect screen can say which. */
export type RefusedBy = "token" | "network" | "timeout";

export type WireErrorCode = "server" | "disconnected" | "timeout";

export class WireError extends Error {
  constructor(
    readonly code: WireErrorCode,
    message: string,
    /** For a failure the host explains with a code: what to translate. */
    readonly problem?: ErrorProblem,
  ) {
    super(message);
  }
}

/** A socket as the wire uses it. `nativeSocket` is the real one, the fake host another. */
export interface WireSocket {
  send: (text: string) => void;
  close: () => void;
  onMessage: (listener: (text: string) => void) => void;
  /** Once: the socket is gone, with why when it never opened. */
  onClose: (listener: (refused?: RefusedBy) => void) => void;
}

export interface WireOptions {
  /** Open a socket. It may fail by calling `onClose`. */
  open: () => WireSocket;
  callTimeoutMs?: number;
  initialRetryMs?: number;
  maxRetryMs?: number;
}

export interface WireEvent {
  name: string;
  data: unknown;
}

/** Fold a state frame into what the client holds for its target (see apps/web/src/lib/wire.ts). */
function applyState(
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
  readonly status = signal<WireStatus>("connecting");
  /** `hello.ops`: the name of everything callable, `target.action`. */
  readonly ops = signal<string[]>([]);
  /** `hello.mounted`: every plugin the host has, or the error that stopped it. */
  readonly mounted = signal<MountedPlugin[]>([]);
  /** The targets the host answered `target:missing` for. */
  readonly missing = signal<Record<string, true>>({});
  /** The last failure of a socket that never said hello. */
  readonly refused = signal<RefusedBy | undefined>(undefined);
  /** When the host last said anything, for "last online". */
  readonly lastSeenAt = signal<number | undefined>(undefined);

  private readonly openSocket: () => WireSocket;
  private readonly callTimeoutMs: number;
  private readonly initialRetryMs: number;
  private readonly maxRetryMs: number;
  private socket: WireSocket | undefined;
  private live = false;
  private retryMs: number;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  private requests = 0;
  private readonly pending = new Map<string, Pending>();
  private readonly users = new Map<string, number>();
  private eager = new Set<string>();
  /** One signal per target, so a push redraws what reads that target and nothing else. */
  private readonly slots = new Map<string, Signal<TargetState | undefined>>();
  private readonly listeners = new Map<
    string,
    Set<(event: WireEvent) => void>
  >();

  constructor(options: WireOptions) {
    this.openSocket = options.open;
    this.callTimeoutMs = options.callTimeoutMs ?? 30_000;
    this.initialRetryMs = options.initialRetryMs ?? 500;
    this.maxRetryMs = options.maxRetryMs ?? 10_000;
    this.retryMs = this.initialRetryMs;
  }

  /** Open the connection; it keeps itself open from here on. */
  connect(): void {
    if (this.closed || this.socket !== undefined) return;
    const socket = this.openSocket();
    this.socket = socket;
    socket.onMessage((text) => {
      if (this.socket === socket) this.receive(text);
    });
    socket.onClose((refused) => {
      if (this.socket === socket) this.dropped(refused);
    });
  }

  /** Try again now instead of waiting out the pause. */
  retryNow(): void {
    if (this.closed || this.socket !== undefined) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.retryMs = this.initialRetryMs;
    this.connect();
  }

  /** Stop for good: no more retries, and nothing waits for a reply any more. */
  close(): void {
    this.closed = true;
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    const socket = this.socket;
    this.socket = undefined;
    this.live = false;
    this.rejectPending("connection closed");
    socket?.close();
  }

  /** Whether the host registered `target.action` (as of the last hello). Reactive. */
  can(op: string): boolean {
    return this.ops().includes(op);
  }

  /** Whether a plugin is mounted. Reactive. */
  isMounted(plugin: string): boolean {
    return this.mounted().some(
      (entry) => entry.name === plugin && entry.error === undefined,
    );
  }

  /**
   * Call `target.action` and wait for the reply. A call made without a connection rejects at once;
   * one the connection dropped under rejects too: a retry would be a second try at something that
   * may have happened.
   */
  call<T = unknown>(
    target: string,
    action: string,
    args?: unknown,
    options: { timeoutMs?: number } = {},
  ): Promise<T> {
    const socket = this.socket;
    if (socket === undefined || !this.live) {
      return Promise.reject(new WireError("disconnected", "not connected"));
    }
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

  /** Want a target's state. The returned function releases this user, once. */
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
      this.slot(target).set(undefined);
      this.clearMissing(target);
    };
  }

  /** A target's state as held now. Reactive. */
  target(name: string): TargetState | undefined {
    return this.slot(name)();
  }

  /** One section of a target. Reactive. */
  section<T>(target: string, name: string): T | undefined {
    return this.target(target)?.sections[name] as T | undefined;
  }

  /** Whether the host said nothing is behind the name. Reactive. */
  isMissing(target: string): boolean {
    return this.missing()[target] === true;
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

  private slot(name: string): Signal<TargetState | undefined> {
    let slot = this.slots.get(name);
    if (slot === undefined) {
      slot = signal<TargetState | undefined>(undefined);
      this.slots.set(name, slot);
    }
    return slot;
  }

  private clearMissing(target: string): void {
    if (untracked(() => this.missing())[target] === undefined) return;
    this.missing.update((missing) => {
      const { [target]: _gone, ...rest } = missing;
      return rest;
    });
  }

  private send(frame: ClientFrame): void {
    if (this.live) this.socket?.send(JSON.stringify(frame));
  }

  private receive(text: string): void {
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
          this.missing.update((missing) => ({
            ...missing,
            [frame.target]: true,
          }));
          return;
        }
        for (const listener of [...(this.listeners.get(frame.target) ?? [])]) {
          listener({ name: frame.name, data: frame.data });
        }
        return;
      case "reply":
        this.reply(frame);
    }
  }

  private hello(frame: HelloFrame): void {
    this.retryMs = this.initialRetryMs;
    this.live = true;
    batch(() => {
      const before = this.eager;
      this.eager = new Set(Object.keys(frame.state));
      for (const target of before) {
        if (!this.eager.has(target) && !this.users.has(target))
          this.slot(target).set(undefined);
      }
      for (const [target, snapshot] of Object.entries(frame.state)) {
        this.slot(target).set({
          sections: { ...snapshot.sections },
          revisions: { ...snapshot.revisions },
          version: 0,
        });
      }
      this.ops.set(frame.ops.map((op) => op.name));
      this.mounted.set(frame.mounted as MountedPlugin[]);
      this.missing.set({});
      this.refused.set(undefined);
      this.status.set("open");
      this.lastSeenAt.set(Date.now());
    });
    // A fresh socket holds no subscriptions: ask again for everything somebody still reads.
    for (const target of this.users.keys())
      this.send({ op: "subscribe", target });
  }

  private state(frame: Extract<ServerFrame, { type: "state" }>): void {
    this.lastSeenAt.set(Date.now());
    if (!this.users.has(frame.target)) return;
    const slot = this.slot(frame.target);
    const next = applyState(
      untracked(() => slot()),
      frame,
    );
    if (next === undefined) return;
    batch(() => {
      slot.set(next);
      this.clearMissing(frame.target);
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

  private dropped(refused: RefusedBy | undefined): void {
    this.socket = undefined;
    this.live = false;
    this.rejectPending("connection closed");
    batch(() => {
      this.refused.set(refused);
      this.status.set("reconnecting");
    });
    if (this.closed) return;
    const delay = this.retryMs;
    this.retryMs = Math.min(this.retryMs * 2, this.maxRetryMs);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      this.connect();
    }, delay);
  }
}
