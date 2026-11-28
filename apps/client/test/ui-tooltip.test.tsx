import { expect, open, test } from "nsh/test";

test("Tooltip and hint show on their target views when hovered", async () => {
  const app = await open("./fixtures/ui-tooltip.tsx", {
    width: 600,
    height: 400,
    platform: "macos",
  });
  expect(app.shows("text:Quick hint")).toBe(false);
  expect(app.shows("text:Rich tip")).toBe(false);
  await app.hover("text:Hover target");
  await app.waitFor("text:Quick hint");
  await app.hover("text:Rich target");
  await app.waitFor("text:Rich tip");
});
