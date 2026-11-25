import { expect, open, test } from "nsh/test";
import { lastObservedAt } from "../../../test/fixtures/member-context";

const fixture = "./fixtures/member-context.tsx";
const ada = "Context 50% · 64,000 / 128,000 tokens";
const bo = "Context 25% · 32,000 / 128,000 tokens";

for (const [width, open_] of [
  [1440, undefined],
  [834, "label:Panel"],
] as const) {
  test(`a member row shows its context ring and percentage at ${width}px`, async () => {
    const app = await open(fixture, { width, height: 900, locale: "en-US" });
    if (open_) await app.press(open_);
    expect(app.shows(`label:${ada}`)).toBe(true);
    expect(app.shows(`label:${bo}`)).toBe(true);
    expect(app.texts()).toContain("50%");
    expect(app.texts()).toContain("25%");
    // A member with no session has nothing to measure.
    expect(app.texts()).toContain("no conversation with it in this group yet");
    expect(app.texts().filter((text) => /^\d+%$/.test(text))).toHaveLength(2);
  });
}

test("the phone sheet puts the percentage beside each member's status", async () => {
  const app = await open(fixture, { width: 390, height: 844, locale: "en-US" });
  await app.press("label:Conversation info");
  expect(app.texts()).toContain("Idle · 50%");
  expect(app.texts()).toContain("Idle · 25%");
  expect(app.texts()).toContain("Cyrus");
});

test("root readings change independently of billed tokens and of the other member", async () => {
  const app = await open(fixture, {
    width: 1440,
    height: 900,
    locale: "en-US",
  });
  expect(app.texts().join(" ")).toContain("in — · out — · cache —");
  expect(app.texts().join(" ")).toContain(
    "in 240.0k · out 0 · cache 1.0k (partial)",
  );
  for (const detail of [
    "25% · 32,000 / 128,000 tokens",
    "N/A · No context reading reported",
    "N/A · No reliable last-call reading and window",
    "N/A · No valid context window",
    "N/A · Awaiting a reading after compaction",
    "N/A · Context reading is out of range",
    "0% · 0 / 128,000 tokens",
    "100% · 128,000 / 128,000 tokens",
    "N/A · Awaiting a reading for the new model",
    "≈13% · 16,000 / 128,000 tokens",
    `15% · 19,010 / 128,000 tokens · Last checked ${new Date(lastObservedAt).toLocaleString("en-US")}`,
  ]) {
    await app.press("label:Next reading");
    expect(app.shows(`label:Context ${detail}`)).toBe(true);
    expect(app.shows(`label:${bo}`)).toBe(true);
  }
  await app.press("label:Replace session");
  await app.press("label:Next reading"); // Late update for the old main session.
  expect(app.shows("label:Context N/A · No context reading reported")).toBe(
    true,
  );
  expect(app.shows(`label:${ada}`)).toBe(false);
  expect(app.shows(`label:${bo}`)).toBe(true);
});
