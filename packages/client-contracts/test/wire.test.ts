/**
 * The shared wire across reconnects: what is subscribed again, what is kept on screen meanwhile,
 * what is rejected, and how long it waits. Both kinds of socket: one that reports its handshake
 * (the page's and the TUI's WebSocket) and one that does not (the phone's).
 */
import type { ClientFrame } from "@eta/client-wire-proto";
import type { WireSocketEvents, WireState } from "../src/wire";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  initialWireState,
  wakeOnPageEvents,
  Wire,
  WireError,
} from "../src/wire";

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

const hello = (
  state: Record<string, object> = {},
  extra: { heartbeat?: true } = {},
) => ({
  type: "hello",
  ops: [{ name: "a.go", target: "a", action: "go" }],
  mounted: [],
  state,
  ...extra,
});

const snapshot = (value: unknown, revision = "1") => ({
  sections: { s: value },
  revisions: { s: revision },
});

function setup(
  timing: { heartbeatMs?: number; heartbeatTimeoutMs?: number } = {},
) {
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
    ...timing,
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

const pings = (socket: Socket) =>
  socket.sent.filter((frame) => frame.op === "ping").length;

describe("the heartbeat", () => {
  function greeted() {
    const world = setup({ heartbeatMs: 1_000, heartbeatTimeoutMs: 500 });
    world.last().events.open();
    world.last().receive(hello({}, { heartbeat: true }));
    return world;
  }

  it("pings a host that answers pings, and an answer keeps the connection", () => {
    const { sockets, last, state } = greeted();
    vi.advanceTimersByTime(1_000);
    expect(pings(last())).toBe(1);
    last().receive({ type: "pong" });
    vi.advanceTimersByTime(1_000);
    expect(pings(last())).toBe(2);
    // Any frame is an answer, not only a pong.
    vi.advanceTimersByTime(400);
    last().receive({ type: "event", target: "a", name: "x", data: null });
    vi.advanceTimersByTime(600);
    expect(pings(last())).toBe(3);
    expect(state().status).toBe("open");
    expect(sockets).toHaveLength(1);
  });

  it("counts a connection that stops answering as dropped, and reconnects", async () => {
    const { wire, sockets, last, state, seen } = greeted();
    const socket = last();
    const waiting = wire.call("a", "go").catch((error: unknown) => error);
    vi.advanceTimersByTime(1_000);
    expect(pings(socket)).toBe(1);
    vi.advanceTimersByTime(499);
    expect(state().status).toBe("open");
    vi.advanceTimersByTime(1);
    expect(state().status).toBe("reconnecting");
    expect(socket.closed).toBe(true);
    expect(seen.at(-1)).toBe("dropped");
    // The call it was waiting on is rejected, not sent again.
    expect(await waiting).toMatchObject({ code: "disconnected" });
    // Its late close changes nothing.
    socket.events.close();
    vi.advanceTimersByTime(100);
    expect(sockets).toHaveLength(2);
    expect(last().sent.filter((frame) => frame.op === "call")).toEqual([]);
  });

  it("never pings a host whose hello does not offer it, so its silence is no drop", () => {
    const { sockets, last, state } = setup({
      heartbeatMs: 1_000,
      heartbeatTimeoutMs: 500,
    });
    last().events.open();
    last().receive(hello());
    vi.advanceTimersByTime(60_000);
    expect(pings(last())).toBe(0);
    expect(state().status).toBe("open");
    expect(sockets).toHaveLength(1);
  });
});

describe("an attempt that never hears hello", () => {
  it("is given up on and retried", () => {
    const { sockets, last, state, seen } = setup({ heartbeatTimeoutMs: 500 });
    const stuck = last();
    stuck.events.open();
    vi.advanceTimersByTime(499);
    expect(sockets).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(stuck.closed).toBe(true);
    expect(state().status).toBe("reconnecting");
    expect(seen).toEqual(["failed"]);
    vi.advanceTimersByTime(100);
    expect(sockets).toHaveLength(2);
    last().receive(hello());
    vi.advanceTimersByTime(60_000);
    expect(state().status).toBe("open");
  });
});

describe("waking", () => {
  it("reconnects at once instead of waiting out a long pause", () => {
    const { wire, sockets, last } = setup();
    // In the background: every attempt fails, and the pause grows to its cap.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const before = sockets.length;
      last().events.close();
      while (sockets.length === before) vi.advanceTimersByTime(50);
    }
    last().events.close();
    const before = sockets.length;
    wire.wake();
    expect(sockets).toHaveLength(before + 1);
    // And the pause starts over from the first one.
    last().events.close();
    vi.advanceTimersByTime(100);
    expect(sockets).toHaveLength(before + 2);
  });

  it("checks a connection that looks open at once, and replaces it when nobody answers", () => {
    const { wire, sockets, last, state } = setup({
      heartbeatMs: 15_000,
      heartbeatTimeoutMs: 500,
    });
    last().events.open();
    last().receive(hello({}, { heartbeat: true }));
    wire.wake();
    expect(pings(last())).toBe(1);
    vi.advanceTimersByTime(500);
    expect(state().status).toBe("reconnecting");
    vi.advanceTimersByTime(100);
    expect(sockets).toHaveLength(2);
  });

  it("follows a page: visible again, or online", () => {
    const listeners = new Map<string, () => void>();
    const source = {
      addEventListener: (type: string, listener: () => void) =>
        listeners.set(type, listener),
      removeEventListener: (type: string) => listeners.delete(type),
    };
    const document = { ...source, visibilityState: "hidden" };
    let woken = 0;
    const stop = wakeOnPageEvents(
      { wake: () => (woken += 1) },
      { window: source, document },
    );
    listeners.get("visibilitychange")!();
    expect(woken).toBe(0);
    document.visibilityState = "visible";
    listeners.get("visibilitychange")!();
    listeners.get("online")!();
    expect(woken).toBe(2);
    stop();
    expect(listeners.size).toBe(0);
  });
});
