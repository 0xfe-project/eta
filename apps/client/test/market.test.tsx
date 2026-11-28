import { expect, open, test } from "nsh/test";

test("with no source the market says so and points to the settings", async () => {
  const app = await open("./fixtures/market.tsx", { width: 900, height: 700 });
  expect(app.shows("No plugin sources yet")).toBe(true);
  expect(
    app.shows(
      "Add a source, or switch one on, in Settings → Plugins to browse it. Installed plugins are not affected.",
    ),
  ).toBe(true);
});

test("a card shows no separator when the entry has no author", async () => {
  const app = await open("./fixtures/market-authors.tsx", {
    width: 900,
    height: 700,
  });
  expect(app.shows("1.0.0 · t")).toBe(true);
  expect(app.shows("2.0.0")).toBe(true);
  expect(app.shows("3.0.0")).toBe(true);
  expect(app.shows("2.0.0 ·")).toBe(false);
  expect(app.shows("3.0.0 ·")).toBe(false);
});

test("the market lists every source, says where each entry is from, and shows a failing source's error", async () => {
  const app = await open("./fixtures/market-several.tsx", {
    width: 1100,
    height: 700,
  });
  expect(app.shows("From Alpha")).toBe(true);
  expect(app.shows("From Beta")).toBe(true);
  // In the user's words; the raw failure only under Details.
  expect(app.shows("Down didn't load")).toBe(true);
  expect(app.shows("cannot read the catalog: HTTP 404")).toBe(false);
  await app.press("Details");
  expect(app.shows("cannot read the catalog: HTTP 404")).toBe(true);
  expect(app.shows("1.0.0 · t")).toBe(true);
  expect(app.shows("2.0.0 · t")).toBe(true);
});

test("the detail leaves out a version or author the catalog did not give, and shows one it did", async () => {
  const bare = await open("./fixtures/market-authors.tsx", {
    width: 900,
    height: 700,
  });
  await bare.press("label:bare");
  expect(bare.shows("Source repository")).toBe(true);
  expect(bare.shows("Version")).toBe(false);
  expect(bare.shows("Author")).toBe(false);
  const full = await open("./fixtures/market-authors.tsx", {
    width: 900,
    height: 700,
  });
  await full.press("label:with-author");
  expect(full.shows("Version")).toBe(true);
  expect(full.shows("Author")).toBe(true);
});

test("Install in the detail installs at once, at the commit the detail showed, with no confirmation", async () => {
  const app = await open("./fixtures/market-install.tsx", {
    width: 900,
    height: 900,
  });
  await app.press("label:one");
  // What it would run is on show before anything is installed.
  await app.waitFor("text:node run.js");
  expect(
    app.shows("1 skills, 1 MCP servers") ||
      app.shows("0 skills, 1 MCP servers"),
  ).toBe(true);
  expect(app.shows("b".repeat(40))).toBe(true);
  await app.press("label:Install");
  expect(app.shows("Install one?")).toBe(false);
  expect(app.shows("I have read this and want to install it")).toBe(false);
  // The install ran (the fixture marks the entry installed only on a marketInstall call).
  await app.waitFor("text:Installed");
  expect(app.shows("Installed")).toBe(true);
});

test("a refused install says why in the detail", async () => {
  const app = await open("./fixtures/market-install.tsx", {
    width: 900,
    height: 900,
  });
  await app.press("label:bad");
  await app.waitFor("text:node run.js");
  await app.press("label:Install");
  expect(app.shows("the plugin name is taken by a local plugin")).toBe(true);
});

test("a card carries its marker: installed, name taken by another source, or not supported", async () => {
  const app = await open("./fixtures/market-markers.tsx", {
    width: 1400,
    height: 700,
  });
  // That a marker sits at the card's bottom right without changing its height is geometry (#639).
  for (const [name, text] of [
    ["here", "Installed"],
    ["taken", "A plugin with this name is installed from another source"],
    ["bad", "Format not supported"],
  ] as const)
    expect(app.shows(`label:${name} >> text:${text}`)).toBe(true);
  for (const text of [
    "Installed",
    "A plugin with this name is installed from another source",
    "Format not supported",
  ])
    expect(app.shows(`label:plain >> text:${text}`)).toBe(false);
});
