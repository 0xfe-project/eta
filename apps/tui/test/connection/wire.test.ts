/**
 * The wire against real hosts: hello, calls, subscriptions, a host that goes away and comes back
 * on the same port. A scripted socket covers the frames a host does not send
 * on demand (a patch, an unreadable frame).
 */
import type { WireSocket } from "../../src/connection/wire";
import { afterEach, describe, expect, it } from "vitest";
import { wireUrl } from "../../src/connection/address";
import { Wire, WireError } from "../../src/connection/wire";
import { baseUrl, closeHost, testHost } from "../support/host";
import { until } from "../support/temp";

const wires: Wire[] = [];

afterEach(() => {
  for (const wire of wires.splice(0)) wire.close();
});

interface Seen {
  hello: number;
  dropped: number;
}

function open(url: string): { wire: Wire; seen: Seen } {
  const seen: Seen = { hello: 0, dropped: 0 };
  const wire = new Wire({
    url,
    initialRetryMs: 50,
    maxRetryMs: 200,
    observer: {
      hello: () => (seen.hello += 1),
      dropped: () => (seen.dropped += 1),
    },
  });
  wires.push(wire);
  wire.connect();
  return { wire, seen };
}

describe("the wire on a real host", () => {
  it("says hello: the status opens and the host's ops and eager targets arrive", async () => {
    const host = await testHost();
    const { wire, seen } = open(wireUrl(baseUrl(host)));
    expect(wire.store.getState().status).toBe("connecting");
    await until(() => wire.store.getState().status === "open");
    expect(seen.hello).toBe(1);
    expect(wire.can("upgrade.check")).toBe(true);
    expect(wire.can("upgrade.nope")).toBe(false);
    expect(
      wire.store.getState().mounted.map((plugin) => plugin.name),
    ).toContain("upgrade");
    expect(Object.keys(wire.store.getState().targets)).toContain("settings");
  });

  it("rejects a call the host refuses with the host's message", async () => {
    const host = await testHost();
    const { wire } = open(wireUrl(baseUrl(host)));
    await until(() => wire.store.getState().status === "open");
    const failure = await wire
      .call("upgrade", "noSuchAction", {})
      .catch((error) => error);
    expect(failure).toBeInstanceOf(WireError);
    expect((failure as WireError).code).toBe("server");
    expect((failure as WireError).message).toBe(
      "unknown op: upgrade.noSuchAction",
    );
  });

  it("holds a subscribed target's state and lets it go with the last user", async () => {
    const host = await testHost();
    const { wire } = open(wireUrl(baseUrl(host)));
    await until(() => wire.store.getState().status === "open");
    const first = wire.subscribe("usage");
    const second = wire.subscribe("usage");
    await until(() => wire.store.getState().targets.usage !== undefined);
    first();
    first();
    expect(wire.store.getState().targets.usage).toBeDefined();
    second();
    expect(wire.store.getState().targets.usage).toBeUndefined();
  });

  it("marks a target the host does not have as missing", async () => {
    const host = await testHost();
    const { wire } = open(wireUrl(baseUrl(host)));
    await until(() => wire.store.getState().status === "open");
    wire.subscribe("nope");
    await until(() => wire.store.getState().missing.nope === true);
  });

  it("comes back after the host restarts on the same port, subscribing again and rejecting what was in flight", async () => {
    const host = await testHost();
    const { port, dataDir } = host;
    const { wire, seen } = open(wireUrl(baseUrl(host)));
    await until(() => wire.store.getState().status === "open");
    wire.subscribe("usage");
    await until(() => wire.store.getState().targets.usage !== undefined);

    // A call whose reply cannot come: the host is going away under it.
    const inFlight = wire.call("upgrade", "check", {}, { timeoutMs: 20_000 });
    const settled = inFlight.then(
      () => "resolved",
      (error: WireError) => error.code,
    );
    await closeHost(host);
    await until(() => seen.dropped === 1, 10_000, "the drop");
    expect(wire.store.getState().status).toBe("reconnecting");
    expect(["disconnected", "resolved"]).toContain(await settled);

    // Its state is kept on screen until the new snapshot replaces it.
    const before = wire.store.getState().targets.usage;
    expect(before).toBeDefined();

    await testHost({ port, dataDir });
    await until(() => seen.hello === 2, 20_000, "the second hello");
    expect(wire.store.getState().status).toBe("open");
    await until(
      () => wire.store.getState().targets.usage !== before,
      10_000,
      "a fresh snapshot",
    );
    expect(wire.store.getState().targets.usage).toBeDefined();
  });
});

/** A socket the test drives: it records what is sent and lets the test push frames. */
class ScriptedSocket implements WireSocket {
  readyState = 0;
  sent: unknown[] = [];
  private readonly handlers = new Map<string, ((event: never) => void)[]>();
  addEventListener(type: string, handler: (event: never) => void): void {
    this.handlers.set(type, [...(this.handlers.get(type) ?? []), handler]);
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }

  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit("close", {});
  }

  emit(type: string, event: unknown): void {
    for (const handler of this.handlers.get(type) ?? [])
      handler(event as never);
  }

  open(): void {
    this.readyState = 1;
    this.emit("open", {});
  }

  frame(value: unknown): void {
    this.emit("message", {
      data: typeof value === "string" ? value : JSON.stringify(value),
    });
  }
}

const HELLO = {
  type: "hello",
  ops: [{ name: "a.go" }],
  mounted: [],
  state: { eager: { sections: { s: 1 }, revisions: { s: "r1" } } },
};

describe("the wire's frames", () => {
  function scripted() {
    const sockets: ScriptedSocket[] = [];
    const wire = new Wire({
      url: "ws://x/ws",
      initialRetryMs: 10,
      maxRetryMs: 10,
      createSocket: () => {
        const socket = new ScriptedSocket();
        sockets.push(socket);
        return socket;
      },
    });
    wires.push(wire);
    wire.connect();
    return { wire, sockets };
  }

  it("applies a patch over a snapshot, keeping unchanged sections and dropping gone ones", () => {
    const { wire, sockets } = scripted();
    const socket = sockets[0]!;
    socket.open();
    socket.frame(HELLO);
    wire.subscribe("t");
    expect(socket.sent).toContainEqual({ op: "subscribe", target: "t" });
    socket.frame({
      type: "state",
      target: "t",
      version: 1,
      snapshot: {
        sections: { a: { deep: true }, b: 2, c: 3 },
        revisions: { a: "1", b: "1", c: "1" },
      },
    });
    const kept = wire.store.getState().targets.t!.sections.a;
    socket.frame({
      type: "state",
      target: "t",
      version: 2,
      patch: { sections: { b: 20 }, revisions: { a: "1", b: "2" } },
    });
    const target = wire.store.getState().targets.t!;
    expect(target.version).toBe(2);
    expect(target.sections).toEqual({ a: kept, b: 20 });
    expect(target.sections.a).toBe(kept);
    expect(target.revisions).toEqual({ a: "1", b: "2" });
  });

  it("records the host's error frame and ignores what it cannot read", () => {
    const { wire, sockets } = scripted();
    const socket = sockets[0]!;
    socket.open();
    socket.frame(HELLO);
    socket.frame("not json");
    socket.frame({ type: "mystery" });
    expect(wire.store.getState().error).toBeUndefined();
    socket.frame({ type: "error", message: "bad frame" });
    expect(wire.store.getState().error).toBe("bad frame");
  });

  it("drops state for a target nobody subscribed to", () => {
    const { wire, sockets } = scripted();
    const socket = sockets[0]!;
    socket.open();
    socket.frame(HELLO);
    socket.frame({
      type: "state",
      target: "stranger",
      version: 1,
      snapshot: { sections: { a: 1 }, revisions: { a: "1" } },
    });
    expect(wire.store.getState().targets.stranger).toBeUndefined();
  });

  it("subscribes on the first user and unsubscribes on the last, once each", () => {
    const { wire, sockets } = scripted();
    const socket = sockets[0]!;
    socket.open();
    socket.frame(HELLO);
    const first = wire.subscribe("t");
    const second = wire.subscribe("t");
    first();
    first();
    expect(socket.sent).toEqual([{ op: "subscribe", target: "t" }]);
    second();
    expect(socket.sent).toEqual([
      { op: "subscribe", target: "t" },
      { op: "unsubscribe", target: "t" },
    ]);
  });

  it("passes events to listeners, and stops after release", () => {
    const { wire, sockets } = scripted();
    const socket = sockets[0]!;
    socket.open();
    socket.frame(HELLO);
    wire.subscribe("t");
    const heard: unknown[] = [];
    const off = wire.onEvent("t", (event) => heard.push(event));
    socket.frame({ type: "event", target: "t", name: "ping", data: 1 });
    off();
    socket.frame({ type: "event", target: "t", name: "ping", data: 2 });
    expect(heard).toEqual([{ name: "ping", data: 1 }]);
  });

  it("settles a call by its reply, and fails a call that times out", async () => {
    const { wire, sockets } = scripted();
    const socket = sockets[0]!;
    socket.open();
    socket.frame(HELLO);
    const answered = wire.call("a", "go", { n: 1 });
    const sent = socket.sent.at(-1) as { requestId: string; args: unknown };
    expect(sent).toMatchObject({
      op: "call",
      target: "a",
      action: "go",
      args: { n: 1 },
    });
    socket.frame({
      type: "reply",
      requestId: sent.requestId,
      ok: true,
      result: 42,
    });
    expect(await answered).toBe(42);
    const slow = await wire
      .call("a", "go", undefined, { timeoutMs: 20 })
      .catch((error) => error);
    expect((slow as WireError).code).toBe("timeout");
  });
});
