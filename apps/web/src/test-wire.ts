// A host for tests to talk to, with no network: the fake socket the wire connects to, and a
// small stand-in for the pipe on its other end that answers the way the real one does (a snapshot
// for a subscription, a patch when a section moved, a reply for a call).

import type {
  MountedPlugin,
  ProvidersView,
  ServerFrame,
} from "@eta/client-contracts";
import type {
  CallFrame,
  ClientFrame,
  ErrorProblem,
} from "@eta/client-wire-proto";
import type { WireOptions, WireSocket } from "@/lib/wire";
import { TARGET_MISSING } from "@eta/client-wire-proto";
import { setWire, Wire } from "@/lib/wire";

type Listener = (event: { data?: unknown }) => void;

/** A WebSocket that does what the test says: it opens, receives and closes on demand. */
export class FakeSocket {
  readyState = 0;
  readonly sent: ClientFrame[] = [];
  /** Told of every frame the client sends, as it sends it. */
  onSend: ((frame: ClientFrame) => void) | undefined;
  private readonly listeners = new Map<string, Set<Listener>>();

  constructor(readonly url: string) {}

  addEventListener(type: string, listener: Listener): void {
    const listening = this.listeners.get(type) ?? new Set();
    listening.add(listener);
    this.listeners.set(type, listening);
  }

  send(data: string): void {
    const frame = JSON.parse(data) as ClientFrame;
    this.sent.push(frame);
    this.onSend?.(frame);
  }

  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit("close", {});
  }

  /** The handshake completed. */
  open(): void {
    this.readyState = 1;
    this.emit("open", {});
  }

  /** A frame from the host. */
  receive(frame: ServerFrame): void {
    this.emit("message", { data: JSON.stringify(frame) });
  }

  /** The connection dropped under the client. */
  drop(): void {
    this.readyState = 3;
    this.emit("close", {});
  }

  /** The frames of one op the client has sent, in order. */
  framesOf<Op extends ClientFrame["op"]>(
    op: Op,
  ): Extract<ClientFrame, { op: Op }>[] {
    return this.sent.filter(
      (frame): frame is Extract<ClientFrame, { op: Op }> => frame.op === op,
    );
  }

  private emit(type: string, event: { data?: unknown }): void {
    for (const listener of [...(this.listeners.get(type) ?? [])])
      listener(event);
  }
}

/** A wire whose sockets are fakes, in the order they were opened. */
export function fakeWire(options: Partial<WireOptions> = {}): {
  wire: Wire;
  sockets: FakeSocket[];
} {
  const sockets: FakeSocket[] = [];
  const wire = new Wire({
    url: "ws://test/ws",
    createSocket: (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket as unknown as WireSocket;
    },
    ...options,
  });
  return { wire, sockets };
}

interface HostTarget {
  sections: Record<string, unknown>;
  revisions: Record<string, string>;
  eager: boolean;
}

type Handler = (args: unknown) => unknown;

/**
 * The pipe's other end for component tests: `hello`, then snapshots for subscriptions and
 * patches for changes, and replies from the handlers a test registers.
 */
export class FakeHost {
  readonly wire: Wire;
  readonly sockets: FakeSocket[];
  /** Every call the page made. */
  readonly calls: { target: string; action: string; args: unknown }[] = [];
  private readonly targets = new Map<string, HostTarget>();
  private readonly handlers = new Map<string, Handler>();
  private readonly subscribed = new Set<string>();
  private revision = 0;
  private mounted: MountedPlugin[] = [];

  constructor() {
    const made = fakeWire();
    this.wire = made.wire;
    this.sockets = made.sockets;
  }

  get socket(): FakeSocket {
    const socket = this.sockets.at(-1);
    if (socket === undefined) throw new Error("the wire has not connected");
    return socket;
  }

  /** Make this host the page's connection, and connect. */
  install(): this {
    setWire(this.wire);
    this.wire.connect();
    return this;
  }

  /** A target's state. Eager ones ride along in `hello`. */
  target(
    name: string,
    sections: Record<string, unknown>,
    options: { eager?: boolean } = {},
  ): this {
    this.targets.set(name, {
      sections: {},
      revisions: {},
      eager: options.eager ?? false,
    });
    this.set(name, sections, false);
    return this;
  }

  /** Answer `target.action` with what the handler returns, or the error message it throws. */
  handle(op: string, handler: Handler): this {
    this.handlers.set(op, handler);
    return this;
  }

  plugins(mounted: MountedPlugin[]): this {
    this.mounted = mounted;
    return this;
  }

  /** The handshake: the socket opens and the host says hello. */
  hello(): void {
    this.subscribed.clear();
    this.socket.open();
    this.socket.receive({
      type: "hello",
      ops: [...this.handlers.keys()].map((name) => {
        const [target = "", action = ""] = splitOp(name);
        return { name, target, action };
      }),
      mounted: this.mounted,
      state: Object.fromEntries(
        [...this.targets]
          .filter(([, target]) => target.eager)
          .map(([name, target]) => [name, snapshotOf(target)]),
      ),
    });
    this.serve();
  }

  /** Change sections of a target; subscribers get a patch with only what moved. */
  set(name: string, sections: Record<string, unknown>, push = true): void {
    const target = this.targets.get(name);
    if (target === undefined) throw new Error(`no such target: ${name}`);
    for (const [section, value] of Object.entries(sections)) {
      this.revision += 1;
      target.sections[section] = value;
      target.revisions[section] = String(this.revision);
    }
    if (push && this.subscribed.has(name)) {
      this.socket.receive({
        type: "state",
        target: name,
        version: 1,
        patch: {
          sections: Object.fromEntries(
            Object.keys(sections).map((section) => [
              section,
              target.sections[section],
            ]),
          ),
          revisions: { ...target.revisions },
        },
      });
    }
  }

  /** Answer what the client has sent so far, and everything it sends next. */
  private serve(): void {
    const socket = this.socket;
    const answer = (frame: ClientFrame): void => {
      if (frame.op === "subscribe") {
        this.subscribed.add(frame.target);
        const target = this.targets.get(frame.target);
        if (target !== undefined) {
          socket.receive({
            type: "state",
            target: frame.target,
            version: 1,
            snapshot: snapshotOf(target),
          });
        } else {
          // The pipe's answer to a name nobody registered.
          socket.receive({
            type: "event",
            target: frame.target,
            name: TARGET_MISSING,
            data: null,
          });
        }
      } else if (frame.op === "unsubscribe") {
        this.subscribed.delete(frame.target);
      } else if (frame.op === "call") {
        this.answerCall(socket, frame);
      }
    };
    for (const frame of socket.sent) answer(frame);
    socket.onSend = answer;
  }

  private answerCall(socket: FakeSocket, frame: CallFrame): void {
    this.calls.push({
      target: frame.target,
      action: frame.action,
      args: frame.args,
    });
    const requestId = frame.requestId;
    if (requestId === undefined) return;
    const handler = this.handlers.get(`${frame.target}.${frame.action}`);
    if (handler === undefined) {
      socket.receive({
        type: "reply",
        requestId,
        ok: false,
        error: `unknown op: ${frame.target}.${frame.action}`,
      });
      return;
    }
    // Replies come back asynchronously, as they do over a socket.
    void Promise.resolve()
      .then(() => handler(frame.args))
      .then(
        (result) =>
          socket.receive({
            type: "reply",
            requestId,
            ok: true,
            ...(result === undefined ? {} : { result }),
          }),
        (error: unknown) =>
          socket.receive({
            type: "reply",
            requestId,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
            ...(error instanceof Error && "problem" in error
              ? { problem: error.problem as ErrorProblem }
              : {}),
          }),
      );
  }
}

/** A host with the `providers` plugin mounted, the config as its first state, connected. */
export function providersHost(config: ProvidersView): FakeHost {
  const host = new FakeHost()
    .target("providers", { config }, { eager: true })
    .plugins([{ name: "providers", source: "bundled" }])
    .handle("providers.reload", () => ({}));
  host.install();
  host.hello();
  return host;
}

function snapshotOf(target: HostTarget) {
  return {
    sections: { ...target.sections },
    revisions: { ...target.revisions },
  };
}

function splitOp(name: string): [string, string] {
  const at = name.lastIndexOf(".");
  return [name.slice(0, at), name.slice(at + 1)];
}
