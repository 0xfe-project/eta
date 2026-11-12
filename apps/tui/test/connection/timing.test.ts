/** A timing value written out as undefined counts as not given. */
import { describe, expect, it } from "vitest";
import { DEFAULT_TIMING, resolveTiming } from "../../src/connection/controller";

describe("resolveTiming with values set to undefined", () => {
  it("keeps the default for a value given as undefined", () => {
    const timing = resolveTiming({ giveUpMs: undefined, maxRetryMs: 50 });
    // 15 seconds: the grace period the architecture document names.
    expect(timing.giveUpMs).toBe(15_000);
    expect(timing).toEqual({ ...DEFAULT_TIMING, maxRetryMs: 50 });
  });
});
