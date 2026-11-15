/**
 * The pipe protocol (S8b).
 *
 * The subject is that the protocol has almost no vocabulary: four frames in, five out, and
 * a diff rule that names no field. What can be tested is the pinned frame names and — the
 * part with real money attached — the state diff: a section whose revision did not
 * move is not sent, a section that went away is reported by its absence, and a client that
 * holds nothing gets everything.
 */

import type { ServerFrame, StateSnapshot } from "../src/index";
import { describe, expect, expectTypeOf, it } from "vitest";
import { SERVER_FRAME_TYPES, stateDiff } from "../src/index";

const message = (text: string) => ({
  role: "user",
  content: [{ type: "text", text }],
  timestamp: 0,
});

const snapshot = (overrides: Partial<StateSnapshot> = {}): StateSnapshot => ({
  sections: {
    core: { session: "s1", running: false },
    transcript: {
      messages: [{ entryId: "e1", seq: 1, at: 0, message: message("hello") }],
    },
    metrics: { tokensPerSec: 0 },
  },
  revisions: { core: "r0", transcript: "t1", metrics: "0.0" },
  ...overrides,
});

describe("the vocabulary", () => {
  it("is pinned, because it is almost nothing", () => {
    expect(SERVER_FRAME_TYPES).toEqual([
      "error",
      "event",
      "hello",
      "reply",
      "state",
    ]);
    // The list a client checks frames against is the union the server sends.
    expectTypeOf<(typeof SERVER_FRAME_TYPES)[number]>().toEqualTypeOf<
      ServerFrame["type"]
    >();
  });
});

describe("the state diff", () => {
  it("sends everything to a client that holds nothing", () => {
    expect(stateDiff(undefined, snapshot())).toBe("full");
  });

  it("sends nothing when no section moved", () => {
    const current = snapshot();
    expect(stateDiff(current.revisions, current)).toBeUndefined();
  });

  it("sends only the sections whose revision changed, and names no field", () => {
    const before = snapshot();
    const after = snapshot({
      sections: { ...before.sections, metrics: { tokensPerSec: 42 } },
      revisions: { ...before.revisions, metrics: "42.0" },
    });
    const patch = stateDiff(before.revisions, after);
    if (patch === undefined || patch === "full")
      throw new Error("expected a patch");
    expect(Object.keys(patch.sections)).toEqual(["metrics"]);
    expect(patch.revisions).toEqual(after.revisions);
  });

  it("reports a section that went away by leaving it out", () => {
    const before = snapshot({
      sections: { ...snapshot().sections, git: { branch: "main" } },
      revisions: { ...snapshot().revisions, git: "main" },
    });
    const after = snapshot();
    const patch = stateDiff(before.revisions, after);
    if (patch === undefined || patch === "full")
      throw new Error("expected a patch");
    expect(patch.revisions).not.toHaveProperty("git");
    expect(patch.sections).not.toHaveProperty("git");
  });

  it("carries a target's own section without knowing what it is", () => {
    const before = snapshot();
    const after = snapshot({
      sections: {
        ...before.sections,
        "git.branch": "main",
        "ssh.host": "build-box",
      },
      revisions: {
        ...before.revisions,
        "git.branch": "main",
        "ssh.host": "build-box",
      },
    });
    const patch = stateDiff(before.revisions, after);
    if (patch === undefined || patch === "full")
      throw new Error("expected a patch");
    expect(patch.sections["ssh.host"]).toBe("build-box");
  });
});
