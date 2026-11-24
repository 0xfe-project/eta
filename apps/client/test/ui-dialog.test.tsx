import { expect, open, test } from "nsh/test";

test("Modal opens and closes via Close button", async () => {
  const app = await open("./fixtures/ui-dialog.tsx", {
    width: 800,
    height: 600,
    locale: "en-US",
  });
  expect(app.shows("text:Dialog body")).toBe(false);
  await app.press("Open modal");
  expect(app.shows("text:Dialog body")).toBe(true);
  await app.press("label:Close");
  await app.waitUntil(() => !app.shows("text:Dialog body"));
});
