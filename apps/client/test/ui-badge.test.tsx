import { expect, open, test } from "nsh/test";

test("Badge and StatusDot render semantic tones and outline variants", async () => {
  const app = await open("./fixtures/ui-badge.tsx", {
    width: 600,
    height: 400,
  });
  expect(app.shows("text:Running")).toBe(true);
  expect(app.shows("text:Needs setup")).toBe(true);
  expect(app.shows("text:Locked")).toBe(true);
});
