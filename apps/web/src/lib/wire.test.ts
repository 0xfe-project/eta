import type { Wire } from "./wire";
import type { FakeSocket } from "@/test-wire";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  rstest,
} from "@rstest/core";
import { fakeWire } from "@/test-wire";
import { applyState, WireError, wireUrl } from "./wire";

let wire: Wire;
let sockets: FakeSocket[];

beforeEach(() => {
  rstest.useFakeTimers();
  ({ wire, sockets } = fakeWire());
  wire.connect();
});

afterEach(() => {
  wire.close();
  rstest.useRealTimers();
});

const hello = (state: Record<string, object> = {}, ops = ["providers.save"]) =>
  ({
    type: "hello",
    ops: ops.map((name) => ({
      name,
      target: name.split(".")[0] ?? "",
      action: name.split(".")[1] ?? "",
    })),
    mounted: [{ name: "providers", source: "bundled" }],
    state,
  }) as never;

/** The socket opens and the host says hello. */
function connected(
  socket = sockets.at(-1)!,
  state: Record<string, object> = {},
) {
  socket.open();
  socket.receive(hello(state));
}

const snapshot = (sections: Record<string, unknown>, revision = "1") => ({
  sections,
  revisions: Object.fromEntries(
    Object.keys(sections).map((n) => [n, revision]),
  ),
});

const targets = () => wire.store.getState().targets;

describe("the address", () => {
  it("is /ws on the page's own origin, wss under https", () => {
    expect(wireUrl({ protocol: "http:", host: "127.0.0.1:3000" })).toBe(
      "ws://127.0.0.1:3000/ws",
    );
    expect(wireUrl({ protocol: "https:", host: "eta.example.com" })).toBe(
      "wss://eta.example.com/ws",
    );
  });
});

describe("hello", () => {
  it("brings the ops, the plugins and the eager targets' state", () => {
    expect(wire.store.getState().status).toBe("connecting");
    connected(sockets[0], {
      providers: snapshot({ config: { revision: "r" } }),
    });

    const state = wire.store.getState();
    expect(state.status).toBe("open");
    expect(state.ops).toEqual(["providers.save"]);
    expect(wire.can("providers.save")).toBe(true);
    expect(wire.can("providers.delete")).toBe(false);
    expect(state.mounted).toEqual([{ name: "providers", source: "bundled" }]);
    // Shown at once, without a subscription: the page draws before it asks.
    expect(state.targets.providers?.sections.config).toEqual({ revision: "r" });
    expect(sockets[0].framesOf("subscribe")).toEqual([]);
  });

  it("ignores what is not a frame", () => {
    sockets[0].open();
    sockets[0].receive("nonsense" as never);
    sockets[0].receive({ type: "who-knows" } as never);
    expect(wire.store.getState().status).toBe("connecting");
  });
});

describe("state", () => {
  it("keeps a snapshot, then merges patches into it", () => {
    connected();
    wire.subscribe("sessions.a");
    const socket = sockets[0];
    expect(socket.framesOf("subscribe")).toEqual([
      { op: "subscribe", target: "sessions.a" },
    ]);
    socket.receive({
      type: "state",
      target: "sessions.a",
      version: 1,
      snapshot: {
        sections: { core: { running: false }, transcript: { messages: [1] } },
        revisions: { core: "1", transcript: "1" },
      },
    });
    const first = targets()["sessions.a"]!;
    expect(first.sections.core).toEqual({ running: false });
    expect(first.version).toBe(1);

    // Only the section that moved is in the patch; the revisions are all the current ones.
    socket.receive({
      type: "state",
      target: "sessions.a",
      version: 2,
      patch: {
        sections: { core: { running: true } },
        revisions: { core: "2", transcript: "1" },
      },
    });
    const second = targets()["sessions.a"]!;
    expect(second.sections.core).toEqual({ running: true });
    // Absent from the patch means unchanged, and keeps its identity.
    expect(second.sections.transcript).toBe(first.sections.transcript);
    expect(second.revisions).toEqual({ core: "2", transcript: "1" });
    expect(second.version).toBe(2);

    // A section missing from the revisions is gone.
    socket.receive({
      type: "state",
      target: "sessions.a",
      version: 3,
      patch: { sections: {}, revisions: { core: "2" } },
    });
    expect(Object.keys(targets()["sessions.a"]!.sections)).toEqual(["core"]);
  });

  it("drops frames for a target nobody reads any more", () => {
    connected();
    const release = wire.subscribe("sessions.a");
    release();
    sockets[0].receive({
      type: "state",
      target: "sessions.a",
      version: 1,
      snapshot: snapshot({ core: {} }),
    });
    expect(targets()["sessions.a"]).toBeUndefined();
  });

  it("applies a patch only to something it holds", () => {
    expect(
      applyState(undefined, {
        version: 2,
        patch: { sections: { a: 1 }, revisions: { a: "1" } },
      }),
    ).toBeUndefined();
  });
});

describe("subscriptions", () => {
  it("subscribe once for any number of users, and let go with the last", () => {
    connected();
    const socket = sockets[0];
    const first = wire.subscribe("agents");
    const second = wire.subscribe("agents");
    expect(socket.framesOf("subscribe")).toHaveLength(1);
    socket.receive({
      type: "state",
      target: "agents",
      version: 1,
      snapshot: snapshot({ list: [] }),
    });

    first();
    first();
    expect(socket.framesOf("unsubscribe")).toEqual([]);
    expect(targets().agents).toBeDefined();

    second();
    expect(socket.framesOf("unsubscribe")).toEqual([
      { op: "unsubscribe", target: "agents" },
    ]);
    // Nobody reads it, so it is not kept.
    expect(targets().agents).toBeUndefined();

    wire.subscribe("agents");
    expect(socket.framesOf("subscribe")).toHaveLength(2);
  });

  it("keeps the state hello carried, which the next subscription replaces", () => {
    connected(sockets[0], {
      providers: snapshot({ config: { revision: "1" } }),
    });
    wire.subscribe("providers")();
    expect(targets().providers?.sections.config).toEqual({ revision: "1" });
  });

  it("subscribes when the connection opens, if somebody asked before", () => {
    wire.subscribe("agents");
    expect(sockets[0].sent).toEqual([]);
    sockets[0].open();
    expect(sockets[0].framesOf("subscribe")).toEqual([
      { op: "subscribe", target: "agents" },
    ]);
  });
});

describe("calls", () => {
  it("resolve with the reply's result", async () => {
    connected();
    const result = wire.call("providers", "save", { id: "a" });
    const [sent] = sockets[0].framesOf("call");
    expect(sent).toMatchObject({
      target: "providers",
      action: "save",
      args: { id: "a" },
    });
    sockets[0].receive({
      type: "reply",
      requestId: sent!.requestId!,
      ok: true,
      result: { revision: "2" },
    });
    await expect(result).resolves.toEqual({ revision: "2" });
  });

  it("reject with the host's own message", async () => {
    connected();
    const result = wire.call("providers", "save");
    sockets[0].receive({
      type: "reply",
      requestId: sockets[0].framesOf("call")[0]!.requestId!,
      ok: false,
      error: "config_changed",
    });
    const error = await result.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(WireError);
    expect(error).toMatchObject({ code: "server", message: "config_changed" });
  });

  it("tell concurrent calls apart", async () => {
    connected();
    const first = wire.call("a", "one");
    const second = wire.call("a", "two");
    const [one, two] = sockets[0].framesOf("call");
    sockets[0].receive({
      type: "reply",
      requestId: two!.requestId!,
      ok: true,
      result: 2,
    });
    sockets[0].receive({
      type: "reply",
      requestId: one!.requestId!,
      ok: true,
      result: 1,
    });
    await expect(Promise.all([first, second])).resolves.toEqual([1, 2]);
  });

  it("give up when no reply comes, and ignore it if it comes late", async () => {
    connected();
    const result = wire.call(
      "providers",
      "refresh",
      { id: "a" },
      { timeoutMs: 1000 },
    );
    const caught = result.catch((error: unknown) => error);
    await rstest.advanceTimersByTimeAsync(1000);
    await expect(caught).resolves.toMatchObject({ code: "timeout" });
    // Nothing is left waiting for it.
    sockets[0].receive({
      type: "reply",
      requestId: sockets[0].framesOf("call")[0]!.requestId!,
      ok: true,
    });
  });

  it("time out by default after thirty seconds", async () => {
    connected();
    const caught = wire.call("a", "b").catch((error: unknown) => error);
    await rstest.advanceTimersByTimeAsync(29_999);
    let settled = false;
    void caught.then(() => (settled = true));
    await rstest.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await rstest.advanceTimersByTimeAsync(1);
    await expect(caught).resolves.toMatchObject({ code: "timeout" });
  });

  it("reject at once without a connection", async () => {
    await expect(wire.call("a", "b")).rejects.toMatchObject({
      code: "disconnected",
    });
    expect(sockets[0].sent).toEqual([]);
  });
});

describe("events", () => {
  it("go to the listeners of their target", () => {
    connected();
    const seen: string[] = [];
    const other: string[] = [];
    const off = wire.onEvent("sessions.a", (event) => seen.push(event.name));
    wire.onEvent("sessions.b", (event) => other.push(event.name));
    sockets[0].receive({
      type: "event",
      target: "sessions.a",
      name: "tool:start",
      data: { id: 1 },
    });
    off();
    sockets[0].receive({
      type: "event",
      target: "sessions.a",
      name: "tool:end",
      data: null,
    });
    expect(seen).toEqual(["tool:start"]);
    expect(other).toEqual([]);
  });
});

describe("a dropped connection", () => {
  it("rejects what was waiting, then reconnects and subscribes again", async () => {
    connected();
    wire.subscribe("providers");
    wire.subscribe("providers");
    wire.subscribe("agents");
    const waiting = wire
      .call("providers", "save")
      .catch((error: unknown) => error);

    sockets[0].drop();
    expect(wire.store.getState().status).toBe("reconnecting");
    await expect(waiting).resolves.toMatchObject({ code: "disconnected" });
    // No new socket yet: the first retry waits half a second.
    await rstest.advanceTimersByTimeAsync(499);
    expect(sockets).toHaveLength(1);
    await rstest.advanceTimersByTimeAsync(1);
    expect(sockets).toHaveLength(2);

    sockets[1].open();
    // Every target that still has users, once each; the server answers with snapshots.
    expect(
      sockets[1]
        .framesOf("subscribe")
        .map((frame) => frame.target)
        .sort(),
    ).toEqual(["agents", "providers"]);
    sockets[1].receive(hello());
    expect(wire.store.getState().status).toBe("open");
    sockets[1].receive({
      type: "state",
      target: "providers",
      version: 1,
      snapshot: snapshot({ config: { revision: "new" } }),
    });
    expect(targets().providers?.sections.config).toEqual({ revision: "new" });
  });

  it("keeps what is on screen until the new snapshot lands", () => {
    connected();
    wire.subscribe("sessions.a");
    sockets[0].receive({
      type: "state",
      target: "sessions.a",
      version: 1,
      snapshot: snapshot({ core: { running: true } }),
    });
    sockets[0].drop();
    expect(targets()["sessions.a"]?.sections.core).toEqual({ running: true });
    rstest.advanceTimersByTime(500);
    connected(sockets[1]);
    expect(targets()["sessions.a"]?.sections.core).toEqual({ running: true });
  });

  it("waits longer each time it fails, and starts over once the host answers", async () => {
    sockets[0].drop();
    await rstest.advanceTimersByTimeAsync(500);
    expect(sockets).toHaveLength(2);
    sockets[1].drop();
    await rstest.advanceTimersByTimeAsync(999);
    expect(sockets).toHaveLength(2);
    await rstest.advanceTimersByTimeAsync(1);
    expect(sockets).toHaveLength(3);

    connected(sockets[2]);
    sockets[2].drop();
    await rstest.advanceTimersByTimeAsync(500);
    expect(sockets).toHaveLength(4);
  });

  it("never waits longer than the cap", async () => {
    ({ wire, sockets } = fakeWire({ initialRetryMs: 4000, maxRetryMs: 5000 }));
    wire.connect();
    sockets[0].drop();
    await rstest.advanceTimersByTimeAsync(4000);
    sockets[1].drop();
    await rstest.advanceTimersByTimeAsync(5000);
    expect(sockets).toHaveLength(3);
    sockets[2].drop();
    await rstest.advanceTimersByTimeAsync(5000);
    expect(sockets).toHaveLength(4);
  });

  it("ignores a socket it has already let go of", () => {
    connected();
    sockets[0].drop();
    sockets[0].receive(hello({ providers: snapshot({ config: {} }) }));
    expect(wire.store.getState().status).toBe("reconnecting");
    expect(targets().providers).toBeUndefined();
  });

  it("stops for good when closed", async () => {
    connected();
    const waiting = wire.call("a", "b").catch((error: unknown) => error);
    wire.close();
    await expect(waiting).resolves.toMatchObject({ code: "disconnected" });
    await rstest.advanceTimersByTimeAsync(60_000);
    expect(sockets).toHaveLength(1);
  });
});
