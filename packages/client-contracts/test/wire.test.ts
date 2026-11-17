/**
 * The shared wire across reconnects: what is subscribed again, what is kept on screen meanwhile,
 * what is rejected, and how long it waits. Both kinds of socket: one that reports its handshake
 * (the page's and the TUI's WebSocket) and one that does not (the phone's).
 */
import type { ClientFrame } from "@eta/client-wire-proto";
import type { WireSocketEvents, WireState } from "../src/wire";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initialWireState, Wire, WireError } from "../src/wire";

class Socket {
  readonly sent: ClientFrame[] = [];
  closed = false;
  readonly events: WireSocketEvents;
  constructor(events: WireSocketEvents) {
    this.events = events;
  }
  send(text: string): void {
    this.sent.push(JSON.parse(text) as ClientFrame);
  }
  close(): void {
    this.closed = true;
  }
  receive(frame: object): void {
    this.events.message(JSON.stringify(frame));
  }
  subscribed(): string[] {
    return this.sent.flatMap((frame) =>
      frame.op === "subscribe" ? [frame.target] : [],
    );
  }
}

const hello = (state: Record<string, object> = {}) => ({
  type: "hello",
  ops: [{ name: "a.go", target: "a", action: "go" }],
  mounted: [],
  state,
});

const snapshot = (value: unknown, revision = "1") => ({
  sections: { s: value },
  revisions: { s: revision },
});

function setup() {
  let state = initialWireState();
  const store = {
    getState: () => state,
    setState: (
      update: Partial<WireState> | ((s: WireState) => Partial<WireState>),
    ) => {
      state = {
        ...state,
        ...(typeof update === "function" ? update(state) : update),
      };
    },
  };
  const sockets: Socket[] = [];
  const seen: string[] = [];
  const wire = new Wire({
    store,
    initialRetryMs: 100,
    maxRetryMs: 400,
    open: (events) => {
      const socket = new Socket(events);
      sockets.push(socket);
      return socket;
    },
    observer: {
      hello: () => seen.push("hello"),
      attemptFailed: () => seen.push("failed"),
      dropped: () => seen.push("dropped"),
    },
  });
  wire.connect();
  const last = () => sockets.at(-1)!;
  return { wire, sockets, seen, last, state: () => state };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("a dropped connection", () => {
  it("subscribes again to what still has users, and keeps it on screen until the snapshot", () => {
    const { wire, sockets, last, state } = setup();
    last().events.open();
    last().receive(hello());
    wire.subscribe("kept");
    const release = wire.subscribe("released");
    last().receive({
      type: "state",
      target: "kept",
      version: 1,
      snapshot: snapshot("old"),
    });
    release();

    last().events.close();
    expect(state().status).toBe("reconnecting");
    vi.advanceTimersByTime(100);
    expect(sockets).toHaveLength(2);
    last().events.open();
    expect(last().subscribed()).toEqual(["kept"]);

    last().receive(hello());
    expect(state().status).toBe("open");
    expect(state().targets.kept?.sections.s).toBe("old");
    last().receive({
      type: "state",
      target: "kept",
      version: 1,
      snapshot: snapshot("new", "2"),
    });
    expect(state().targets.kept?.sections.s).toBe("new");
    // Subscribed once on the new socket, not again at hello.
    expect(last().subscribed()).toEqual(["kept"]);
  });

  it("rejects the calls waiting on it, and does not send them again", async () => {
    const { wire, last } = setup();
    last().events.open();
    last().receive(hello());
    const waiting = wire.call("a", "go").catch((error: unknown) => error);
    last().events.close();
    const failure = await waiting;
    expect(failure).toBeInstanceOf(WireError);
    expect((failure as WireError).code).toBe("disconnected");
    await expect(wire.call("a", "go")).rejects.toMatchObject({
      code: "disconnected",
      message: "not connected",
    });
    vi.advanceTimersByTime(100);
    last().events.open();
    expect(last().sent.filter((frame) => frame.op === "call")).toEqual([]);
  });

  it("waits a doubling pause up to the cap, back to the first one after a hello", () => {
    const { sockets, last, seen } = setup();
    const gaps: number[] = [];
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const before = sockets.length;
      last().events.close();
      let waited = 0;
      while (sockets.length === before) {
        vi.advanceTimersByTime(50);
        waited += 50;
      }
      gaps.push(waited);
    }
    expect(gaps).toEqual([100, 200, 400, 400]);
    expect(seen).toEqual(["failed", "failed", "failed", "failed"]);

    last().events.open();
    last().receive(hello());
    last().events.close();
    expect(seen.slice(-2)).toEqual(["hello", "dropped"]);
    vi.advanceTimersByTime(99);
    const count = sockets.length;
    vi.advanceTimersByTime(1);
    expect(sockets.length).toBe(count + 1);
  });

  it("can be retried at once", () => {
    const { wire, sockets, last } = setup();
    last().events.close();
    wire.retryNow();
    expect(sockets).toHaveLength(2);
    // The pending pause was cancelled: no third socket when it would have run out.
    vi.advanceTimersByTime(1_000);
    expect(sockets).toHaveLength(2);
  });

  it("is not retried once closed, and a closed socket's frames are ignored", () => {
    const { wire, sockets, last, state } = setup();
    const socket = last();
    socket.events.open();
    socket.receive(hello());
    wire.close();
    expect(socket.closed).toBe(true);
    socket.receive({
      type: "event",
      target: "x",
      name: "target:missing",
      data: null,
    });
    socket.events.close();
    vi.advanceTimersByTime(10_000);
    expect(sockets).toHaveLength(1);
    expect(state().missing).toEqual({});
  });
});

describe("a socket that does not report its handshake", () => {
  it("sends nothing before hello, then subscribes again to what has users", async () => {
    const { wire, last } = setup();
    wire.subscribe("t");
    await expect(wire.call("a", "go")).rejects.toMatchObject({
      code: "disconnected",
    });
    expect(last().sent).toEqual([]);

    last().receive(hello());
    expect(last().subscribed()).toEqual(["t"]);

    last().events.close();
    vi.advanceTimersByTime(100);
    expect(last().sent).toEqual([]);
    last().receive(hello());
    expect(last().subscribed()).toEqual(["t"]);
  });
});

describe("hello", () => {
  it("replaces the eager targets, forgets the missing ones, and keeps a released eager target unfollowed", () => {
    const { wire, last, state } = setup();
    last().events.open();
    last().receive(hello({ settings: snapshot("a") }));
    wire.subscribe("gone");
    last().receive({
      type: "event",
      target: "gone",
      name: "target:missing",
      data: null,
    });
    expect(state().missing).toEqual({ gone: true });

    const missing = state().missing;
    const release = wire.subscribe("settings");
    last().receive({
      type: "state",
      target: "settings",
      version: 3,
      snapshot: snapshot("b", "2"),
    });
    // State for another target leaves the missing ones as they were, the same object.
    expect(state().missing).toBe(missing);
    release();
    expect(state().targets.settings).toMatchObject({
      version: 0,
      sections: { s: "b" },
    });

    last().events.close();
    vi.advanceTimersByTime(100);
    last().events.open();
    last().receive(hello({ settings: snapshot("c", "3") }));
    expect(state().missing).toEqual({});
    expect(state().targets.settings?.sections.s).toBe("c");
  });
});
