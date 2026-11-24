import { expect, open, test } from "nsh/test";

test("Popover opens and renders anchored content", async () => {
  const app = await open("./fixtures/ui-popover.tsx", {
    width: 600,
    height: 400,
  });
  expect(app.shows("text:Popover content")).toBe(false);
  await app.press("Open popover");
  expect(app.shows("text:Popover content")).toBe(true);
});
