// The app's one connection to the host: the shared wire (@eta/client-contracts/wire) over a socket
// the runtime gives, with its state mirrored into signals, one per target, so a push redraws what
// reads that target and nothing else.

import type { MountedPlugin } from "@eta/client-contracts";
import type {
  TargetState,
  WireEvent,
  WireState,
  WireStatus,
  WireStore,
} from "@eta/client-contracts/wire";
import type { Signal } from "nsh";
import {
  initialWireState,
  Wire as SharedWire,
} from "@eta/client-contracts/wire";
import { batch, signal } from "nsh";

export { WireError } from "@eta/client-contracts/wire";

/** Why a socket could not open, so the connect screen can say which. */
export type RefusedBy = "token" | "network" | "timeout";

/** A socket as the wire uses it. `nativeSocket` is the real one, the fake host another. */
export interface WireSocket {
  send: (text: string) => void;
  close: () => void;
  onMessage: (listener: (text: string) => void) => void;
  /** Once: the socket is gone, with why when it never opened. */
  onClose: (listener: (refused?: RefusedBy) => void) => void;
}

interface WireOptions {
  /** Open a socket. It may fail by calling `onClose`. */
  open: () => WireSocket;
  callTimeoutMs?: number;
  initialRetryMs?: number;
  maxRetryMs?: number;
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

  private readonly slots = new Map<string, Signal<TargetState | undefined>>();
  private held = initialWireState();
  private readonly wire: SharedWire;

  constructor({ open, ...timing }: WireOptions) {
    const store: WireStore = {
      getState: () => this.held,
      setState: (update) => {
        const before = this.held;
        this.held = {
          ...before,
          ...(typeof update === "function" ? update(before) : update),
        };
        this.mirror(before, this.held);
      },
    };
    this.wire = new SharedWire({
      ...timing,
      store,
      open: (events) => {
        const socket = open();
        socket.onMessage((text) =>
          batch(() => {
            this.lastSeenAt.set(Date.now());
            events.message(text);
          }),
        );
        socket.onClose((refused) =>
          batch(() => {
            this.refused.set(refused);
            events.close();
          }),
        );
        return socket;
      },
      observer: { hello: () => this.refused.set(undefined) },
    });
  }

  /** Open the connection; it keeps itself open from here on. */
  connect(): void {
    this.wire.connect();
  }

  /** Try again now instead of waiting out the pause. */
  retryNow(): void {
    this.wire.retryNow();
  }

  /** Stop for good: no more retries, and nothing waits for a reply any more. */
  close(): void {
    this.wire.close();
  }

  /** `target.action`; see the shared wire for what a dropped connection does to it. */
  call<T = unknown>(
    target: string,
    action: string,
    args?: unknown,
    options?: { timeoutMs?: number },
  ): Promise<T> {
    return this.wire.call<T>(target, action, args, options);
  }

  /** Want a target's state. The returned function releases this user, once. */
  subscribe(target: string): () => void {
    return this.wire.subscribe(target);
  }

  /** Listen to what a target says happened. Only the targets subscribed to send events. */
  onEvent(target: string, listener: (event: WireEvent) => void): () => void {
    return this.wire.onEvent(target, listener);
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

  private slot(name: string): Signal<TargetState | undefined> {
    let slot = this.slots.get(name);
    if (slot === undefined) {
      slot = signal<TargetState | undefined>(undefined);
      this.slots.set(name, slot);
    }
    return slot;
  }

  /** Set the signals whose value the shared wire replaced. */
  private mirror(before: WireState, after: WireState): void {
    batch(() => {
      if (after.status !== before.status) this.status.set(after.status);
      if (after.ops !== before.ops) this.ops.set(after.ops);
      if (after.mounted !== before.mounted) this.mounted.set(after.mounted);
      if (after.missing !== before.missing) this.missing.set(after.missing);
      for (const name of new Set([
        ...Object.keys(before.targets),
        ...Object.keys(after.targets),
      ])) {
        if (after.targets[name] !== before.targets[name])
          this.slot(name).set(after.targets[name]);
      }
    });
  }
}
