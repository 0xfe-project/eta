import { expect, open, test } from "nsh/test";

// Composio toolkits and the plugins of other sources are one list: 30 toolkits first, then 200 plugins.
const WIDE = { width: 1440, height: 900, clock: {} };
const NARROW = { width: 390, height: 800, clock: {} };
type App = Awaited<ReturnType<typeof open>>;
const cards = (app: App) => app.count("id:plugin-avatar");
const pad = (n: number) => String(n).padStart(4, "0");
/** How many cards sit side by side: the toolkits that share the first one's row. */
function columns(app: App): number {
  const first = app.layout("label:Toolkit 0000")!;
  let count = 0;
  for (let i = 0; i < 30; i++) {
    const card = app.layout(`label:Toolkit ${pad(i)}`);
    if (card && card.y === first.y) count++;
  }
  return count;
}
const open1 = async (file = "./fixtures/market-unified.tsx", size = WIDE) => {
  const app = await open(file, size);
  await app.waitFor("label:Toolkit 0000");
  return app;
};

test("the plugins of other sources are drawn in batches too, after the Composio toolkits", async () => {
  const app = await open1();
  expect(cards(app)).toBeLessThan(230);
  expect(app.shows("label:Toolkit 0029")).toBe(true);
  expect(app.shows("label:Plugin 0000")).toBe(true);
  expect(app.shows("label:Plugin 0199")).toBe(false);
  const toolkit = app.layout("label:Toolkit 0029")!;
  const plugin = app.layout("label:Plugin 0000")!;
  expect(plugin.y).toBeGreaterThanOrEqual(toolkit.y);
  expect(plugin.y === toolkit.y ? plugin.x > toolkit.x : true).toBe(true);
});

test("a batch is whole rows: the drawn cards are a multiple of the columns", async () => {
  const wide = await open1();
  expect(columns(wide)).toBeGreaterThan(1);
  expect(cards(wide) % columns(wide)).toBe(0);
  const narrow = await open1("./fixtures/market-unified.tsx", {
    width: 1000,
    height: 900,
    clock: {},
  });
  expect(columns(narrow)).toBeLessThan(columns(wide));
  expect(cards(narrow) % columns(narrow)).toBe(0);
});

// The phone's toolkit cards are narrow slivers, so its first batch fits the screen and nothing scrolls: Show more is what draws the plugins there.
test("on a phone the plugins are one to a row, and still come in batches", async () => {
  const app = await open1("./fixtures/market-unified-phone.tsx", NARROW);
  expect(cards(app)).toBeLessThan(230);
  expect(app.shows("label:Plugin 0000")).toBe(false);
  await app.press("label:Show more");
  const one = app.layout("label:Plugin 0000")!;
  const two = app.layout("label:Plugin 0001")!;
  expect(one.x).toBe(two.x);
  expect(two.y).toBeGreaterThan(one.y);
  expect(cards(app)).toBeLessThan(230);
  expect(app.shows("label:Plugin 0199")).toBe(false);
});

test("Show more is at the end of the list, below the last card drawn", async () => {
  const app = await open1();
  const last = app.layout(`label:Plugin ${pad(cards(app) - 31)}`)!;
  const more = app.layout("label:Show more")!;
  expect(last).toBeDefined();
  expect(more).toBeDefined();
  expect(more.y).toBeGreaterThanOrEqual(last.y + last.height);
});

test("scrolling near the end draws another batch of whole rows, with no button pressed", async () => {
  const app = await open1();
  const before = cards(app);
  await app.scroll("label:Toolkit 0000", 100000);
  expect(cards(app)).toBeGreaterThan(before);
  expect(cards(app) % columns(app)).toBe(0);
});

test("every card is drawn in the end, and Show more goes with the last batch", async () => {
  const app = await open1();
  for (let i = 0; i < 12 && app.count("label:Show more") > 0; i++)
    await app.press("label:Show more");
  expect(cards(app)).toBe(230);
  expect(app.count("label:Show more")).toBe(0);
  expect(app.shows("label:Plugin 0199")).toBe(true);
});

test("a search finds a plugin that is not drawn yet", async () => {
  const app = await open1();
  expect(app.shows("label:Plugin 0199")).toBe(false);
  await app.type("label:Search plugins", "Plugin 0199");
  await app.clock!.runFor(400);
  expect(cards(app)).toBe(1);
  expect(app.shows("label:Plugin 0199")).toBe(true);
  expect(app.count("label:Show more")).toBe(0);
});

test("a search after a scroll goes back to the first batch", async () => {
  const app = await open1();
  const first = cards(app);
  await app.scroll("label:Toolkit 0000", 100000);
  expect(cards(app)).toBeGreaterThan(first);
  // "plugin 0" matches Plugin 0000 to 0199: more than one batch.
  await app.type("label:Search plugins", "plugin 0");
  await app.clock!.runFor(400);
  expect(cards(app)).toBe(first);
});

// A flex: 1 toolkit card with no width, in the wrapping row, is squeezed to a sliver.
test("on a phone a Composio toolkit card is one to a row and fills the row, like the plugins", async () => {
  const app = await open1("./fixtures/market-unified-phone.tsx", NARROW);
  const one = app.layout("label:Toolkit 0000")!;
  const two = app.layout("label:Toolkit 0001")!;
  expect(one.width).toBeGreaterThan(NARROW.width / 2);
  expect(one.x).toBe(two.x);
  expect(two.y).toBeGreaterThan(one.y);
  await app.press("label:Show more");
  const plugin = app.layout("label:Plugin 0000")!;
  expect(one.width).toBe(plugin.width);
});

test("off a phone a Composio toolkit card keeps its width, and several share a row", async () => {
  const app = await open1();
  expect(app.layout("label:Toolkit 0000")!.width).toBe(267);
  expect(columns(app)).toBeGreaterThan(1);
});
