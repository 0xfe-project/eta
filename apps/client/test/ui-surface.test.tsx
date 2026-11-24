import { expect, open, test } from "nsh/test";

test("Card supports static and pressable interactive states with Separator", async () => {
  const app = await open("./fixtures/ui-surface.tsx", {
    width: 600,
    height: 400,
  });
  expect(app.shows("text:Static card")).toBe(true);
  expect(app.shows("text:Unpicked")).toBe(true);
  await app.press("label:Pick me");
  expect(app.shows("text:Picked")).toBe(true);
});
