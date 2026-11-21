import { expect, open, test } from "nsh/test";

// Each member row rings its face with how full that member's context is, by the web ring's rule:
// the transcript from the last compaction summary on, four characters to a token, against a 128k
// window. The fixture's numbers are worked out in fixtures/member-context.tsx.

const fixture = "./fixtures/member-context.tsx";
const ada = "Context 13%: 17,000 used of a 128k window";
// Without the compaction rule Bo's 400,000 characters of old replies would make this 83%.
const bo = "Context 5%: 6,600 used of a 128k window";

for (const [width, open_] of [
  [1440, undefined],
  [834, "label:Panel"],
] as const) {
  test(`a member row shows its context ring and percentage at ${width}px`, async () => {
    const app = await open(fixture, { width, height: 900, locale: "en-US" });
    if (open_) await app.press(open_);
    expect(app.shows(`label:${ada}`)).toBe(true);
    expect(app.shows(`label:${bo}`)).toBe(true);
    expect(app.texts()).toContain("13%");
    expect(app.texts()).toContain("5%");
    // A member with no session has nothing to measure.
    expect(app.texts()).toContain("no conversation with it in this group yet");
    expect(app.texts().filter((text) => /^\d+%$/.test(text))).toHaveLength(2);
  });
}

test("the phone sheet puts the percentage beside each member's status", async () => {
  const app = await open(fixture, { width: 390, height: 844, locale: "en-US" });
  await app.press("label:Conversation info");
  expect(app.texts()).toContain("Idle · 13%");
  expect(app.texts()).toContain("Idle · 5%");
  expect(app.texts()).toContain("Cyrus");
});
