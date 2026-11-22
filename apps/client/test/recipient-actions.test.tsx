import { expect, open, test } from "nsh/test";

test("choosing a busy member, pulling back a queued message and stopping their reply are independent", async () => {
  const app = await open("./composer-fixture.tsx", {
    platform: "macos",
    width: 1440,
    height: 900,
  });
  await app.press("Queue one");
  const stop = "Stop Ada";
  const queued = "label:Queued message: earlier";
  await app.press("label:Ada");
  expect(app.shows("text:Waits until Ada finishes this turn")).toBe(true);
  expect(app.enabled(stop)).toBe(true);
  await app.press("label:Pull back into the box: earlier");
  expect(app.shows("text:Waits until Ada finishes this turn")).toBe(true);
  expect(app.enabled(stop)).toBe(true);
  expect(app.texts()).toContain("earlier");
  await app.press("Queue one");
  await app.press(stop);
  expect(app.shows("text:stopped alpha/alpha-Ada")).toBe(true);
  expect(app.shows("text:Waits until Ada finishes this turn")).toBe(true);
  expect(app.shows(queued)).toBe(true);
  expect(app.texts()).toContain("earlier");
  expect(app.enabled(stop)).toBe(false);
});
