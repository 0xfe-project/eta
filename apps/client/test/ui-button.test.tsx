import { expect, open, test } from "nsh/test";

test("ui Button uses createPressable to guard busy presses and supports Back/Close", async () => {
  const app = await open("./fixtures/ui-button.tsx", {
    width: 600,
    height: 400,
    locale: "en-US",
  });
  await app.press("Save");
  expect(app.shows("text:count:1 nav:")).toBe(true);

  await app.press("Toggle busy");
  await app.press("Save");
  expect(app.shows("text:count:1 nav:")).toBe(true);

  await app.press("label:Back");
  expect(app.shows("text:count:1 nav:back")).toBe(true);
  await app.press("label:Close");
  expect(app.shows("text:count:1 nav:close")).toBe(true);
});
