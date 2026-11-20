import { expect, open, test } from "nsh/test";

test("choosing a busy member, opening their queue and stopping their reply are independent", async () => {
  const app = await open("./composer-fixture.tsx", {
    platform: "macos",
    width: 1440,
    height: 900,
  });
  await app.press("Queue one");
  const stop = "Stop Ada";
  await app.press("label:Ada");
  expect(app.shows("text:Waits until Ada finishes this turn")).toBe(true);
  expect(app.enabled(stop)).toBe(true);
  await app.press("1 queued");
  expect(app.shows("text:Waits until Ada finishes this turn")).toBe(true);
  expect(app.enabled(stop)).toBe(true);
  await app.keyboard.press("e");
  expect(app.value("role:combobox")).toBe("earlier");
  await app.press("Queue one");
  await app.press(stop);
  expect(app.shows("text:stopped alpha/alpha-Ada")).toBe(true);
  expect(app.shows("text:Waits until Ada finishes this turn")).toBe(true);
  expect(app.shows("1 queued")).toBe(true);
  expect(app.value("role:combobox")).toBe("earlier");
  expect(app.enabled(stop)).toBe(false);
});
