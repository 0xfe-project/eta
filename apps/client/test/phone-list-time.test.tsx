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
  "Confirm deploying the updated mobile row layout?",
  "Select the target locale bundle for phone regression checks",
  "#481 Keep phone list timestamps on a single line",
  "#482 Verify Pending inbox row alignment on narrow screens",
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

// Each row shows its own localized stamp. That a stamp stays on one line and lines up before the
// chevron is geometry (#639): shown in the PR with a browser run.
async function assertPhoneTimestamps(
  mode: "groups" | "pending",
  locale: "zh-CN" | "en-US",
) {
  const app = await open(fixture, {
    width: 390,
    height: 844,
    locale,
    clock: { time: fixedNow },
    storage: { mode },
  });
  const rows = mode === "groups" ? [...chatRows] : [...pendingRows];
  await app.waitFor(`label:${rows[0]!}`);

  const stamps = expectedStamps(locale);
  rows.forEach((row, i) => {
    expect(app.shows(`label:${row} >> text:${stamps[i]!}`)).toBe(true);
  });
}

for (const locale of ["zh-CN", "en-US"] as const) {
  test(`phone GroupRow shows each row's localized time (${locale})`, async () => {
    await assertPhoneTimestamps("groups", locale);
  });

  test(`phone PendingRow shows each row's localized time (${locale})`, async () => {
    await assertPhoneTimestamps("pending", locale);
  });
}
