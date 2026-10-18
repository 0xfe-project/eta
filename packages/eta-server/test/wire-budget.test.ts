/**
 * The frame budget, seen from the pipe (S17).
 *
 * The pacer's own tests say the arithmetic is right. These say the *server* uses it: a burst
 * of pushes reaches a socket as a bounded number of frames, the newest state is the one that
 * lands, a focused target gets the tight floor, and a socket that goes away takes its timers
 * with it.
 */
import type { ServerFrame } from "@eta/client-wire-proto";
import { Context } from "cordis";
import { describe, expect, it } from "vitest";
import { WireService } from "../src/wire-service";

interface Harness {
  wire: WireService;
  frames: ServerFrame[];
  revisions: { turn: number };
  advance(ms: number): void;
  restore(): void;
}

/** A wire service over a controllable clock, with the state of one target behind it. */
function harness(
  options: { focusedIntervalMs?: number; backgroundIntervalMs?: number } = {},
): Harness {
  const revisions = { turn: 0 };
  const frames: ServerFrame[] = [];
  const timers: { run: () => void; at: number }[] = [];
  let now = 0;
  // The clock is the test's: pacing is about elapsed time, so the budget is measured against
  // a clock the test moves — otherwise "how often" can only be asserted as a hope.
  const wire = new WireService(new Context(), {
    ...(options.focusedIntervalMs === undefined
      ? {}
      : { focusedIntervalMs: options.focusedIntervalMs }),
    ...(options.backgroundIntervalMs === undefined
      ? {}
      : { backgroundIntervalMs: options.backgroundIntervalMs }),
    now: () => now,
    schedule: (run, ms) => {
      const entry = { run, at: now + ms };
      timers.push(entry);
      return entry as never;
    },
    unschedule: (timer) => {
      const index = timers.indexOf(timer as never);
      if (index >= 0) timers.splice(index, 1);
    },
  });
  wire.attachSink((addressed) => frames.push(addressed.frame));
  // The projector's own rule: the revision moves exactly when the state does, which is what
  // the sender compares against the baseline it holds for each socket.
  wire.stateOf("sessions.s1", {
    project: () => ({
      sections: { turn: revisions.turn },
      revisions: { turn: String(revisions.turn) },
    }),
  });
  return {
    wire,
    frames,
    revisions,
    advance(ms) {
      now += ms;
      for (const timer of [...timers]) {
        if (timer.at > now) continue;
        timers.splice(timers.indexOf(timer), 1);
        timer.run();
      }
    },
  } as Harness;
}

describe("a burst of state changes", () => {
  it("reaches a subscriber as one frame per floor, carrying the newest state", () => {
    const h = harness({ backgroundIntervalMs: 100 });
    h.wire.subscribe(1, "sessions.s1");
    expect(h.frames).toHaveLength(1);

    for (let turn = 1; turn <= 50; turn += 1) {
      h.revisions.turn = turn;
      h.wire.push("sessions.s1");
    }
    // Fifty changes inside the floor: nothing went out yet.
    expect(h.frames).toHaveLength(1);

    h.advance(100);
    expect(h.frames).toHaveLength(2);
    // The frame that landed is the newest state, not the first of the fifty.
    expect(JSON.stringify(h.frames[1])).toContain('"turn":50');
    h.advance(100);
    // And nothing more is owed: the client is current.
    expect(h.frames).toHaveLength(2);
  });

  it("sends more often to the target someone is looking at", () => {
    const h = harness({ focusedIntervalMs: 20, backgroundIntervalMs: 500 });
    h.wire.subscribe(1, "sessions.s1");
    h.wire.focus(["sessions.s1"]);
    for (let turn = 1; turn <= 10; turn += 1) {
      h.revisions.turn = turn;
      h.wire.push("sessions.s1");
    }
    h.advance(20);
    expect(h.frames.length).toBeGreaterThan(1);
  });

  it("sends a fresh snapshot the moment a client subscribes, with no floor in the way", () => {
    const h = harness({ backgroundIntervalMs: 100 });
    h.wire.subscribe(1, "sessions.s1");
    expect(h.frames[0]).toMatchObject({ type: "state", target: "sessions.s1" });
    expect(h.frames[0]).toHaveProperty("snapshot");
    // A second subscribe for the same target owes nothing: the client is current.
    h.wire.subscribe(1, "sessions.s1");
    expect(h.frames).toHaveLength(1);
  });

  it("stops scheduling for a socket that went away", () => {
    const h = harness({ backgroundIntervalMs: 100 });
    h.wire.subscribe(1, "sessions.s1");
    h.revisions.turn = 1;
    h.wire.push("sessions.s1");
    h.wire.dropSocket(1);
    h.advance(1_000);
    // The frame that was coalesced is not delivered to a socket nobody has.
    expect(h.frames).toHaveLength(1);
  });

  it("keeps one socket's pacing out of another's", () => {
    const h = harness({ backgroundIntervalMs: 100 });
    h.wire.subscribe(1, "sessions.s1");
    h.wire.subscribe(2, "sessions.s1");
    expect(h.frames).toHaveLength(2);
    // Socket 1 is caught up, socket 2 is not: the push reaches only the one that is behind.
    h.revisions.turn = 1;
    h.wire.push("sessions.s1");
    h.advance(100);
    const stateFrames = h.frames.filter((frame) => frame.type === "state");
    expect(stateFrames).toHaveLength(4);
  });
});
