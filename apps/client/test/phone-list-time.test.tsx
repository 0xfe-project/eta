import { expect, open, test } from "nsh/test";

const fixture = "./fixtures/phone-list-time.tsx";
const fixedNow = new Date(2026, 10, 28, 12, 0, 0).getTime();

const chatRows = [
  "Mobile layout verification and QA thread",
  "Release coordination with long conversation title",
  "Design system token cleanup for mobile rows",
  "Client runtime localization and date formatting",
] as const;

const pendingRows = [
  {
    rowLabel: "Confirm deploying the updated mobile row layout?",
    titleText: "Confirm deploying the updated mobile row layout?",
  },
  {
    rowLabel: "Select the target locale bundle for phone regression checks",
    titleText: "Select the target locale bundle for phone regression checks",
  },
  {
    rowLabel: "#481 Keep phone list timestamps on a single line",
    titleText: "#481 Keep phone list timestamps on a single line",
  },
  {
    rowLabel: "#482 Verify Pending inbox row alignment on narrow screens",
    titleText: "#482 Verify Pending inbox row alignment on narrow screens",
  },
] as const;

function expectedStamps(locale: "zh-CN" | "en-US"): string[] {
  const twoDaysAgo = new Date(fixedNow - 2 * 86_400_000).toLocaleDateString(
    locale,
    { month: "short", day: "numeric" },
  );
  if (locale === "zh-CN") {
    return ["刚刚", "30 分钟", "12 小时", twoDaysAgo];
  }
  return ["now", "30m", "12h", "Nov 26"];
}

async function assertPhoneTimestamps(
  mode: "groups" | "pending",
  locale: "zh-CN" | "en-US",
) {
  const app = await open(fixture, {
    width: 390,
    height: 844,
    locale,
    clock: { time: fixedNow },
    storage: { mode, refs: "1" },
  });
  const rows =
    mode === "groups"
      ? chatRows.map((name) => ({ rowLabel: name, titleText: name }))
      : [...pendingRows];
  await app.waitFor(`label:${rows[0]!.rowLabel}`);

  const stamps = expectedStamps(locale);
  for (const stamp of stamps) {
    expect(app.texts()).toContain(stamp);
  }

  const singleLine = app.layout(`id:list-root >> text:${stamps[0]}`)!;
  expect(singleLine).not.toBeNull();
  const firstRight = singleLine.x + singleLine.width;

  const measured = rows.map(({ rowLabel, titleText }, i) => {
    const stamp = stamps[i]!;
    const rowRect = app.layout(`label:${rowLabel}`)!;
    const titleRect = app.layout(`id:list-root >> text:${titleText}`)!;
    const rect = app.layout(`id:list-root >> text:${stamp}`)!;
    const ref = app.layout(`id:time-refs >> text:${stamp}`)!;
    expect(rowRect).not.toBeNull();
    expect(titleRect).not.toBeNull();
    expect(rect).not.toBeNull();
    expect(ref).not.toBeNull();
    return { rowRect, titleRect, rect, ref };
  });

  // Strictly one line (matches shortest timestamp height and unconstrained single-line reference).
  for (const { rect, ref } of measured) {
    expect(rect.height).toBeLessThanOrEqual(singleLine.height + 1);
    expect(Math.abs(rect.height - ref.height)).toBeLessThanOrEqual(1);
  }

  for (const { rowRect, titleRect, rect, ref } of measured) {
    // No horizontal clipping or truncation.
    expect(rect.clipped).toBe(false);
    expect(rect.width).toBeGreaterThanOrEqual(ref.width - 1);
    expect(Math.abs(rect.width - ref.width)).toBeLessThanOrEqual(1);

    // Right edge aligns with every other row immediately before <RowChevron /> (16px slot + 12px gap + 12px paddingRight).
    const rightEdge = rect.x + rect.width;
    expect(Math.abs(rightEdge - firstRight)).toBeLessThanOrEqual(1);
    expect(
      Math.abs(rightEdge - (rowRect.x + rowRect.width - 40)),
    ).toBeLessThanOrEqual(1);

    // Title column never collides with the timestamp.
    expect(titleRect.x + titleRect.width).toBeLessThanOrEqual(rect.x);
  }
}

for (const locale of ["zh-CN", "en-US"] as const) {
  test(`phone GroupRow keeps timestamps on one line (${locale})`, async () => {
    await assertPhoneTimestamps("groups", locale);
  });

  test(`phone PendingRow keeps timestamps on one line (${locale})`, async () => {
    await assertPhoneTimestamps("pending", locale);
  });
}
