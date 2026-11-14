/**
 * The event ring (S18).
 *
 * State answers "what is true now"; events answer "what happened". A client that attaches late
 * has missed the second question entirely — there is no later state frame that carries it — so
 * a target keeps its last few hundred events and hands them to whoever subscribes. These tests
 * are about the ring itself: capacity, order, and what a filter means.
 */
import { Context } from "cordis";
import { describe, expect, it } from "vitest";
import { createEventRing } from "../src/ring";
import { WireService } from "../src/wire-service";

const event = (name: string, data: unknown = null) =>
  ({ type: "event" as const, target: "sessions.s1", name, data }) as const;

describe("the ring", () => {
  it("keeps the last N events in order, forgetting the oldest", () => {
    const ring = createEventRing(3);
    for (const name of ["a", "b", "c", "d", "e"]) ring.push(event(name));
    expect(ring.tail().map((frame) => frame.name)).toEqual(["c", "d", "e"]);
    expect(ring.size()).toBe(3);
  });

  it("hands back a copy, so a caller cannot edit what it replayed", () => {
    const ring = createEventRing(2);
    ring.push(event("a"));
    const first = ring.tail();
    first.push(event("bogus"));
    expect(ring.tail().map((frame) => frame.name)).toEqual(["a"]);
  });

  it("narrows a replay to a family of events", () => {
    const ring = createEventRing();
    ring.push(event("turn:run-start"));
    ring.push(event("tool:start"));
    ring.push(event("message:update"));
    ring.push(event("tool:end"));
    // A name is `<family>:<what happened>`; "tool" is the family a panel means.
    expect(ring.tail("tool").map((frame) => frame.name)).toEqual([
      "tool:start",
      "tool:end",
    ]);
    // Case does not matter, and an empty filter is no filter at all.
    expect(ring.tail("TOOL")).toHaveLength(2);
    expect(ring.tail("  ")).toHaveLength(4);
    expect(ring.tail("nothing-like-this")).toEqual([]);
  });
});

interface WireHarness {
  wire: WireService;
  frames: { socketId?: number; frame: unknown }[];
}

function harness(): WireHarness {
  const frames: { socketId?: number; frame: unknown }[] = [];
  const wire = new WireService(new Context());
  wire.attachSink((addressed) => frames.push(addressed));
  wire.stateOf("sessions.s1", {
    project: () => ({ sections: { turn: 1 }, revisions: { turn: "1" } }),
  });
  return { wire, frames };
}

describe("the ring on the wire", () => {
  it("replays what happened to a client that attaches later", () => {
    const h = harness();
    // Events happen before anyone is listening: they are facts, not notifications.
    h.wire.event("sessions.s1", "turn:run-start", { runId: "r1" });
    h.wire.event("sessions.s1", "tool:start", { toolName: "bash" });
    expect(h.frames).toEqual([]);

    h.wire.subscribe(1, "sessions.s1");
    // The snapshot first (what is true), then the ring (what happened), in order.
    expect(
      h.frames.map((entry) => (entry.frame as { type: string }).type),
    ).toEqual(["state", "event", "event"]);
    expect(
      h.frames.slice(1).map((entry) => (entry.frame as { name: string }).name),
    ).toEqual(["turn:run-start", "tool:start"]);
    expect(h.frames.every((entry) => entry.socketId === 1)).toBe(true);
  });

  it("stamps every event with a time that only goes up, replays included", () => {
    const h = harness();
    // Several in one millisecond: the stamps still differ, and they come back the same on replay.
    for (const name of ["a", "b", "c"]) h.wire.event("sessions.s1", name, null);
    h.wire.subscribe(1, "sessions.s1");
    const replayed = h.frames
      .map((entry) => entry.frame as { type: string; at?: number })
      .filter((frame) => frame.type === "event")
      .map((frame) => frame.at!);
    expect(replayed).toHaveLength(3);
    expect(replayed[0]).toBeGreaterThan(0);
    expect(replayed[1]).toBeGreaterThan(replayed[0]!);
    expect(replayed[2]).toBeGreaterThan(replayed[1]!);
  });

  it("answers a subscription to a target nobody registered with target:missing, once, to that socket", () => {
    const h = harness();
    h.wire.subscribe(7, "sessions.nope");
    expect(h.frames).toEqual([
      {
        socketId: 7,
        frame: {
          type: "event",
          target: "sessions.nope",
          name: "target:missing",
          data: null,
        },
        target: "sessions.nope",
      },
    ]);
    // It is an answer, not something that happened: a later subscriber is not replayed it.
    h.frames.length = 0;
    h.wire.subscribe(8, "sessions.nope");
    expect(h.frames).toHaveLength(1);
    expect(h.wire.ringOf("sessions.nope")).toEqual([]);
  });

  it("tells the watchers of a target that is taken away", () => {
    const h = harness();
    const off = h.wire.stateOf("sessions.s2", {
      project: () => ({ sections: { a: 1 }, revisions: { a: "1" } }),
    });
    h.wire.subscribe(1, "sessions.s2");
    h.frames.length = 0;
    off();
    expect(
      h.frames.map((entry) => (entry.frame as { name: string }).name),
    ).toEqual(["target:missing"]);
    expect(h.frames[0]!.socketId).toBe(1);
  });

  it("sends live events only to subscribers, and only those that asked for them", () => {
    const h = harness();
    h.wire.subscribe(1, "sessions.s1", "tool");
    h.wire.subscribe(2, "sessions.s1");
    h.frames.length = 0;
    h.wire.event("sessions.s1", "message:update", { text: "streaming" });
    h.wire.event("sessions.s1", "tool:end", { toolName: "bash" });

    // Socket 2 asked for everything; socket 1 asked for the tool family, and never sees the
    // token stream at all — which is the point of filtering at the source.
    const forSocket = (socketId: number) =>
      h.frames
        .filter((entry) => entry.socketId === socketId)
        .map((entry) => (entry.frame as { name: string }).name);
    expect(forSocket(1)).toEqual(["tool:end"]);
    expect(forSocket(2)).toEqual(["message:update", "tool:end"]);
  });

  it("replays a late subscriber only the family it asked for", () => {
    const h = harness();
    h.wire.event("sessions.s1", "tool:start", { toolName: "bash" });
    h.wire.event("sessions.s1", "message:update", { text: "…" });
    h.wire.subscribe(1, "sessions.s1", "tool");
    const events = h.frames
      .filter((entry) => (entry.frame as { type: string }).type === "event")
      .map((entry) => (entry.frame as { name: string }).name);
    expect(events).toEqual(["tool:start"]);
  });

  it("keeps a second subscription from replaying the ring twice", () => {
    const h = harness();
    h.wire.event("sessions.s1", "tool:start", {});
    h.wire.subscribe(1, "sessions.s1");
    h.wire.subscribe(1, "sessions.s1");
    expect(
      h.frames.filter(
        (entry) => (entry.frame as { type: string }).type === "event",
      ),
    ).toHaveLength(1);
  });
});
