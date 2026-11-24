import { expect, open, test } from "nsh/test";

const OPEN = { width: 1000, height: 800 };
// A search is waited for on the clock: it applies once the typing pauses.
const SEARCH = { ...OPEN, clock: {} };
type App = Awaited<ReturnType<typeof open>>;
const cards = (app: App) => app.count("id:plugin-avatar");

// 130 toolkits; a batch is ten rows, so how many cards it holds follows from the columns the width gives.
const ROWS = 10;
const pad = (n: number) => String(n).padStart(4, "0");
/** How many cards sit side by side: the toolkits that share the first one's row. */
function columns(app: App): number {
  const first = app.layout("label:Toolkit 0000")!;
  let count = 0;
  for (let i = 0; i < 12; i++) {
    const card = app.layout(`label:Toolkit ${pad(i)}`);
    if (card && card.y === first.y) count++;
  }
  return count;
}
const batchOf = (app: App) => ROWS * columns(app);

test("only the first batch of toolkits is drawn, and Show more adds the next batch", async () => {
  const app = await open("./fixtures/market-batches.tsx", OPEN);
  await app.waitFor("text:Toolkit 0000");
  const batch = batchOf(app);
  expect(batch).toBeLessThan(130);
  expect(cards(app)).toBe(batch);
  expect(app.shows(`Toolkit ${pad(batch - 1)}`)).toBe(true);
  expect(app.shows(`Toolkit ${pad(batch)}`)).toBe(false);
  await app.press("label:Show more");
  expect(cards(app)).toBe(batch * 2);
  expect(app.shows(`Toolkit ${pad(batch)}`)).toBe(true);
  for (let i = 0; i < 10 && app.count("label:Show more") > 0; i++)
    await app.press("label:Show more");
  expect(cards(app)).toBe(130);
  expect(app.shows("Toolkit 0129")).toBe(true);
  expect(app.count("label:Show more")).toBe(0);
});

test("a picture is only asked for by a card that is drawn", async () => {
  const app = await open("./fixtures/market-batches.tsx", OPEN);
  await app.waitFor("text:Toolkit 0000");
  const batch = batchOf(app);
  await app.waitFor(`text:logos:${batch} calls:${batch}`);
  await app.press("label:Show more");
  await app.waitFor(`text:logos:${batch * 2} calls:${batch * 2}`);
  expect(app.shows(`text:logos:${batch * 2} calls:${batch * 2}`)).toBe(true);
});

test("a search looks through every toolkit, not only the drawn ones", async () => {
  const app = await open("./fixtures/market-batches.tsx", SEARCH);
  await app.waitFor("text:Toolkit 0000");
  await app.type("label:Search plugins", "Toolkit 0125");
  await app.clock!.runFor(400);
  expect(cards(app)).toBe(1);
  expect(app.shows("Toolkit 0125")).toBe(true);
  expect(app.count("label:Show more")).toBe(0);
});

test("a search with more matches than a batch draws one batch again, and Show more goes on from there", async () => {
  const app = await open("./fixtures/market-batches.tsx", SEARCH);
  await app.waitFor("text:Toolkit 0000");
  const batch = batchOf(app);
  await app.press("label:Show more");
  expect(cards(app)).toBe(batch * 2);
  // "toolkit 00" matches Toolkit 0000 to 0099: 100 toolkits, more than a batch.
  await app.type("label:Search plugins", "toolkit 00");
  await app.clock!.runFor(400);
  expect(cards(app)).toBe(batch);
  await app.press("label:Show more");
  expect(cards(app)).toBe(batch * 2);
  for (let i = 0; i < 10 && app.count("label:Show more") > 0; i++)
    await app.press("label:Show more");
  expect(cards(app)).toBe(100);
  expect(app.count("label:Show more")).toBe(0);
});

test("the list follows a search only once the typing pauses", async () => {
  const app = await open("./fixtures/market-batches.tsx", SEARCH);
  await app.waitFor("text:Toolkit 0000");
  const batch = batchOf(app);
  await app.type("label:Search plugins", "Toolkit 0125");
  // The words are in the field at once; the cards wait for the pause.
  expect(cards(app)).toBe(batch);
  await app.clock!.runFor(400);
  expect(cards(app)).toBe(1);
});

// Scrolling: the list draws the next batch when the view comes near its end.
test("scrolling to the end of the list draws the next batch, one batch and no more", async () => {
  const app = await open("./fixtures/market-batches.tsx", OPEN);
  await app.waitFor("text:Toolkit 0000");
  const batch = batchOf(app);
  expect(cards(app)).toBe(batch);
  await app.scroll("text:Toolkit 0000", 100000);
  expect(cards(app)).toBe(batch * 2);
  expect(app.shows(`Toolkit ${pad(batch)}`)).toBe(true);
});

test("a list scrolled a little draws one batch ahead, and a second little scroll draws no more", async () => {
  const app = await open("./fixtures/market-batches.tsx", OPEN);
  await app.waitFor("text:Toolkit 0000");
  const batch = batchOf(app);
  await app.scroll("text:Toolkit 0000", 100);
  expect(cards(app)).toBe(batch * 2);
  await app.scroll("text:Toolkit 0000", 100);
  expect(cards(app)).toBe(batch * 2);
});

test("Show more still draws a batch after a batch was drawn by scrolling", async () => {
  const app = await open("./fixtures/market-batches.tsx", OPEN);
  await app.waitFor("text:Toolkit 0000");
  const batch = batchOf(app);
  await app.scroll("text:Toolkit 0000", 100000);
  expect(cards(app)).toBe(batch * 2);
  await app.press("label:Show more");
  expect(cards(app)).toBe(batch * 3);
});
