import type { ContextReading } from "../src";
import { expect, it } from "vitest";
import { displayContext, displaySpend } from "../src";
const sample: ContextReading = {
  source: "acp",
  session: "a",
  model: "m",
  runId: "r",
  observedAt: 1,
  compactedAt: null,
  used: 64000,
  window: 128000,
  reason: null,
};

it("only displays a matched and internally consistent observation", () => {
  const show = (patch: Partial<ContextReading>) =>
    displayContext({ ...sample, ...patch }, "a", "en");
  expect(show({}).label).toBe("50%");
  expect(show({ used: 0 }).label).toBe("0%");
  expect(show({ used: 128000 }).label).toBe("100%");
  for (const patch of [
    { session: "other" },
    { window: 0 },
    { used: null },
    { used: 152081 },
    { used: -1 },
    { window: Infinity },
    { used: NaN },
    { reason: "compacted" },
  ] as const)
    expect(show(patch)).toMatchObject({
      label: "N/A",
      fraction: 0,
      detail: expect.stringMatching(/N\/A · .+/),
    });
  expect(show({ source: "harness" }).label).toBe("≈50%");
});

it("distinguishes no report, an explicit zero and partial coverage", () => {
  expect(displaySpend(null, "en")).toBe("—");
  expect(displaySpend({ value: 0, coverage: "complete" }, "en")).toBe("0");
  expect(displaySpend({ value: 0, coverage: "partial" }, "zh")).toBe(
    "0 (部分)",
  );
});
