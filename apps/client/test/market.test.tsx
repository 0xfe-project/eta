import { expect, open, test } from "nsh/test";

test("with no source the market says so and points to the settings", async () => {
  const app = await open("./fixtures/market.tsx", { width: 900, height: 700 });
  expect(app.shows("No plugin sources")).toBe(true);
  expect(app.shows("Add a source, or switch one on, in Settings → Plugins to browse it. Installed plugins are not affected.")).toBe(true);
});

test("a card shows no separator when the entry has no author", async () => {
  const app = await open("./fixtures/market-authors.tsx", { width: 900, height: 700 });
  expect(app.shows("1.0.0 · t")).toBe(true);
  expect(app.shows("2.0.0")).toBe(true);
  expect(app.shows("3.0.0")).toBe(true);
  expect(app.shows("2.0.0 ·")).toBe(false);
  expect(app.shows("3.0.0 ·")).toBe(false);
});

test("the market lists every source, says where each entry is from, and shows a failing source's error", async () => {
  const app = await open("./fixtures/market-several.tsx", { width: 1100, height: 700 });
  expect(app.shows("From Alpha")).toBe(true);
  expect(app.shows("From Beta")).toBe(true);
  expect(app.shows("cannot read the catalog: HTTP 404")).toBe(true);
  expect(app.shows("1.0.0 · t")).toBe(true);
  expect(app.shows("2.0.0 · t")).toBe(true);
});

test("the detail leaves out a version or author the catalog did not give, and shows one it did", async () => {
  const bare = await open("./fixtures/market-authors.tsx", { width: 900, height: 700 });
  await bare.press("label:bare");
  expect(bare.shows("Source repository")).toBe(true);
  expect(bare.shows("Version")).toBe(false);
  expect(bare.shows("Author")).toBe(false);
  const full = await open("./fixtures/market-authors.tsx", { width: 900, height: 700 });
  await full.press("label:with-author");
  expect(full.shows("Version")).toBe(true);
  expect(full.shows("Author")).toBe(true);
});

test("Install in the detail installs at once, at the commit the detail showed, with no confirmation", async () => {
  const app = await open("./fixtures/market-install.tsx", { width: 900, height: 900 });
  await app.press("label:one");
  // What it would run is on show before anything is installed.
  await app.waitFor("text:node run.js");
  expect(app.shows("1 skills, 1 MCP servers") || app.shows("0 skills, 1 MCP servers")).toBe(true);
  expect(app.shows("b".repeat(40))).toBe(true);
  await app.press("label:Install");
  expect(app.shows("Install one?")).toBe(false);
  expect(app.shows("I have read this and want to install it")).toBe(false);
  // The install ran (the fixture marks the entry installed only on a marketInstall call).
  await app.waitFor("text:Installed");
  expect(app.shows("Installed")).toBe(true);
});

test("a refused install says why in the detail", async () => {
  const app = await open("./fixtures/market-install.tsx", { width: 900, height: 900 });
  await app.press("label:bad");
  await app.waitFor("text:node run.js");
  await app.press("label:Install");
  expect(app.shows("the plugin name is taken by a local plugin")).toBe(true);
});

test("the kept catalog shows at once, while the read that asks the servers has not answered", async () => {
  const app = await open("./fixtures/market-cached.tsx", { width: 900, height: 700 });
  expect(app.shows("kept-entry")).toBe(true);
});
