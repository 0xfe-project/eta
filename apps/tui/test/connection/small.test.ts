/** The small pure pieces of the connection layer. */
import { describe, expect, it } from "vitest";
import { DEFAULT_TIMING, resolveTiming } from "../../src/connection/controller";
import { nextRetryMs } from "../../src/connection/wire";
import { TUI_VERSION } from "../../src/version";

describe("the default timing", () => {
  it("gives up after 15 s and retries from 0.5 s doubling up to 5 s", () => {
    expect(DEFAULT_TIMING).toEqual({
      giveUpMs: 15_000,
      initialRetryMs: 500,
      maxRetryMs: 5_000,
      probeTimeoutMs: 1_500,
      temporaryStartMs: 60_000,
      temporaryStopMs: 10_000,
      installRunMs: 120_000,
      installUpMs: 60_000,
      // Shorter than the desktop app's 15 s: every start of a host waits on `eta-host running`.
      runningMs: 10_000,
    });
    const delays = [DEFAULT_TIMING.initialRetryMs];
    while (delays.length < 8)
      delays.push(nextRetryMs(delays.at(-1)!, DEFAULT_TIMING.maxRetryMs));
    expect(delays).toEqual([
      500, 1_000, 2_000, 4_000, 5_000, 5_000, 5_000, 5_000,
    ]);
  });
});

describe("the TUI version", () => {
  it("is dev when run from source", () => {
    expect(TUI_VERSION).toBe("dev");
  });
});

describe("the controller's timing", () => {
  it("is the default timing when none is given", () => {
    expect(resolveTiming(undefined)).toEqual(DEFAULT_TIMING);
    expect(resolveTiming({})).toEqual(DEFAULT_TIMING);
  });
});
