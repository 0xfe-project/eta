import { expect, open, test } from "nsh/test";

// The plugins page has a button that opens Settings on the plugin sources, from every tab.

const fixture = "./fixtures/tablet-list.tsx";
const settings = "label:Manage plugin market sources in Settings";

async function start(width: number, height: number) {
  const app = await open(fixture, { width, height, locale: "en-US" });
  await app.waitFor("text:Website redesign");
  return app;
}

test("desktop: the button opens Settings on the plugin sources", async () => {
  const app = await start(1400, 900);
  await app.press("label:Plugins");
  expect(app.shows("Plugin sources")).toBe(false);
  await app.press(settings);
  expect(app.shows("Plugin sources")).toBe(true);
});

test("desktop: the market tab has the button too", async () => {
  const app = await start(1400, 900);
  await app.press("label:Plugins");
  await app.press("label:Market");
  await app.press(settings);
  expect(app.shows("Plugin sources")).toBe(true);
});

test("tablet: the button opens Settings on the plugin sources", async () => {
  const app = await start(834, 1112);
  await app.press("label:Plugins");
  await app.press(settings);
  expect(app.shows("Plugin sources")).toBe(true);
});

test("phone: the button opens Settings on the plugin sources", async () => {
  const app = await start(390, 844);
  await app.press("label:More");
  await app.press("label:Plugins");
  await app.press(settings);
  expect(app.shows("Plugin sources")).toBe(true);
});
