import { expect, open, test } from "nsh/test";

test("LayoutSelect updates selection in desktop native mode and phone sheet fallback", async () => {
  const app = await open("./fixtures/ui-select.tsx", {
    width: 600,
    height: 480,
  });
  expect(app.shows("text:desktop:alpha")).toBe(true);
  expect(app.shows("text:phone:alpha")).toBe(true);

  await app.press("label:Desktop select");
  await app.waitFor("text:Beta");
  await app.press("text:Beta");
  await app.waitFor("text:desktop:beta");

  await app.press("label:Phone select");
  await app.waitFor("label:Gamma");
  await app.press("label:Gamma");
  await app.waitFor("text:phone:gamma");
});
