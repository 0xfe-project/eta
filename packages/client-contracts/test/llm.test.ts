import { describe, expect, it } from "vitest";
import { billingRetryAt, isMonthDuration, LLM_CODES } from "../src/index";

// What each code means and which params it carries: apps/eta/src/llm/problems.ts.
describe("llm problem codes", () => {
  it("are lowercase snake_case and unique", () => {
    expect(new Set(LLM_CODES).size).toBe(LLM_CODES.length);
    for (const code of LLM_CODES) expect(code).toMatch(/^[a-z]+(_[a-z]+)*$/);
  });
});

describe("subscription billing windows and retry intervals", () => {
  it("accepts actual month lengths including a clock change", () => {
    for (const seconds of [28 * 86400 - 3600, 30 * 86400, 31 * 86400 + 3600])
      expect(isMonthDuration(seconds)).toBe(true);
    for (const seconds of [
      0,
      5 * 3600,
      7 * 86400,
      27 * 86400,
      40 * 86400,
      Infinity,
      NaN,
    ])
      expect(isMonthDuration(seconds)).toBe(false);
  });
  it("honors upstream seconds and dates and bounds the fallback", () => {
    const now = Date.parse("2026-01-01T00:00:00Z");
    expect(billingRetryAt("72", 0, now)).toBe(now + 72_000);
    expect(billingRetryAt("Thu, 01 Jan 2026 01:00:00 GMT", 0, now)).toBe(
      now + 3_600_000,
    );
    expect(billingRetryAt(undefined, 0, now)).toBeGreaterThanOrEqual(
      now + 30_000,
    );
    expect(billingRetryAt("invalid", 20, now)).toBe(now + 600_000);
  });
});
