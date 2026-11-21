import { expect, open, test } from "nsh/test";

test("a review retains both task numbers and opens the pending questions from Inbox", async () => {
  const app = await open("./fixtures/captain-review.tsx", {
    width: 390,
    height: 844,
  });
  expect(app.shows("Task #7")).toBe(true);
  expect(app.shows("Task #11")).toBe(true);
  await app.press("Inbox");
  expect(app.shows("Opened pending questions")).toBe(true);
});
