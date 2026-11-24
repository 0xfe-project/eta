import { expect, open, test } from "nsh/test";

// Captain's conversation is not a row of the conversation list; the card reads it from Captain's
// identity. Before, it looked in the list, found nothing, and said there was no conversation even
// after Captain had answered.

const fixture = "./fixtures/captain-card.tsx";

test("the Captain card says there is no conversation yet, then when Captain last replied", async () => {
  const app = await open(fixture, { width: 420, height: 300, locale: "en-US" });
  expect(app.texts()).toContain("No conversation with Captain yet");
  await app.press("label:Captain answers");
  await app.waitFor("text:last reply Jan 2 10:00 AM");
  expect(app.texts()).not.toContain("No conversation with Captain yet");
});

test("the card's empty line is about Captain, not about a group", async () => {
  const app = await open(fixture, { width: 420, height: 300, locale: "zh-CN" });
  expect(app.texts()).toContain("还没有和 Captain 对话");
});
