import { expect, open, test } from "nsh/test";

const OPEN = { width: 1100, height: 800 };

test("the first frame already lists every source's kept entries, with their update time", async () => {
  const app = await open("./fixtures/market-sources-split.tsx", OPEN);
  expect(app.shows("alpha-old")).toBe(true);
  expect(app.shows("beta-kept")).toBe(true);
  expect(app.texts().some((text) => text.startsWith("Updated "))).toBe(true);
});

test("a source's own read replaces only its part; the source that has not answered keeps its entries", async () => {
  const app = await open("./fixtures/market-sources-split.tsx", OPEN);
  await app.waitFor("text:alpha-new");
  expect(app.shows("alpha-old")).toBe(false);
  expect(app.shows("beta-kept")).toBe(true);
});

test("a failing read of a source leaves its kept entries on screen", async () => {
  const app = await open("./fixtures/market-sources-fail.tsx", OPEN);
  await app.waitFor("text:alpha-new");
  expect(app.shows("beta-kept")).toBe(true);
  expect(app.texts().some((text) => text.startsWith("Updated "))).toBe(true);
});

test("the market opened again shows the last list at once, before the host answers", async () => {
  const app = await open("./fixtures/market-sources-reopen.tsx", OPEN);
  await app.waitFor("text:alpha-new");
  await app.press("label:Toggle market");
  expect(app.shows("closed")).toBe(true);
  await app.press("label:Toggle market");
  expect(app.shows("alpha-new")).toBe(true);
  expect(app.shows("beta-kept")).toBe(true);
});
