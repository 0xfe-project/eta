import { expect, open, test } from "nsh/test";

const OPEN = { width: 1000, height: 800 };
// A search is waited for on the clock: it applies once the typing pauses.
const SEARCH = { ...OPEN, clock: {} };
type App = Awaited<ReturnType<typeof open>>;
const cards = (app: App) => app.count("id:plugin-avatar");

// 130 toolkits, one batch is 48.
test("only the first batch of toolkits is drawn, and Show more adds the next batch", async () => {
  const app = await open("./fixtures/market-batches.tsx", OPEN);
  await app.waitFor("text:Toolkit 0000");
  expect(cards(app)).toBe(48);
  expect(app.shows("Toolkit 0047")).toBe(true);
  expect(app.shows("Toolkit 0048")).toBe(false);
  await app.press("label:Show more");
  expect(cards(app)).toBe(96);
  expect(app.shows("Toolkit 0048")).toBe(true);
  await app.press("label:Show more");
  expect(cards(app)).toBe(130);
  expect(app.shows("Toolkit 0129")).toBe(true);
  expect(app.count("label:Show more")).toBe(0);
});

test("a picture is only asked for by a card that is drawn", async () => {
  const app = await open("./fixtures/market-batches.tsx", OPEN);
  await app.waitFor("text:logos:48 calls:48");
  expect(app.shows("text:logos:48 calls:48")).toBe(true);
  await app.press("label:Show more");
  await app.waitFor("text:logos:96 calls:96");
  expect(app.shows("text:logos:96 calls:96")).toBe(true);
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
  await app.press("label:Show more");
  expect(cards(app)).toBe(96);
  // "toolkit 00" matches Toolkit 0000 to 0099: 100 toolkits, more than a batch.
  await app.type("label:Search plugins", "toolkit 00");
  await app.clock!.runFor(400);
  expect(cards(app)).toBe(48);
  await app.press("label:Show more");
  expect(cards(app)).toBe(96);
  await app.press("label:Show more");
  expect(cards(app)).toBe(100);
  expect(app.count("label:Show more")).toBe(0);
});

test("the list follows a search only once the typing pauses", async () => {
  const app = await open("./fixtures/market-batches.tsx", SEARCH);
  await app.waitFor("text:Toolkit 0000");
  await app.type("label:Search plugins", "Toolkit 0125");
  // The words are in the field at once; the cards wait for the pause.
  expect(cards(app)).toBe(48);
  await app.clock!.runFor(400);
  expect(cards(app)).toBe(1);
});

// Scrolling: the list draws the next batch when the view comes near its end.
test("scrolling to the end of the list draws the next batch, one batch and no more", async () => {
  const app = await open("./fixtures/market-batches.tsx", OPEN);
  await app.waitFor("text:Toolkit 0000");
  expect(cards(app)).toBe(48);
  await app.scroll("text:Toolkit 0000", 100000);
  expect(cards(app)).toBe(96);
  expect(app.shows("Toolkit 0048")).toBe(true);
});

test("a list scrolled only a little draws no more", async () => {
  const app = await open("./fixtures/market-batches.tsx", OPEN);
  await app.waitFor("text:Toolkit 0000");
  await app.scroll("text:Toolkit 0000", 100);
  expect(cards(app)).toBe(48);
});

test("the end of the list reached again, with the content grown, draws the last batch, and Show more goes with it", async () => {
  const app = await open("./fixtures/market-batches.tsx", OPEN);
  await app.waitFor("text:Toolkit 0000");
  await app.scroll("text:Toolkit 0000", 100000);
  expect(cards(app)).toBe(96);
  await app.scroll("text:Toolkit 0000", 100000);
  expect(cards(app)).toBe(130);
  expect(app.count("label:Show more")).toBe(0);
});

test("Show more still draws a batch after a batch was drawn by scrolling", async () => {
  const app = await open("./fixtures/market-batches.tsx", OPEN);
  await app.waitFor("text:Toolkit 0000");
  await app.scroll("text:Toolkit 0000", 100000);
  expect(cards(app)).toBe(96);
  await app.press("label:Show more");
  expect(cards(app)).toBe(130);
});

test("a search after a scroll draws the first batch again", async () => {
  const app = await open("./fixtures/market-batches.tsx", SEARCH);
  await app.waitFor("text:Toolkit 0000");
  await app.scroll("text:Toolkit 0000", 100000);
  expect(cards(app)).toBe(96);
  await app.type("label:Search plugins", "toolkit 00");
  await app.clock!.runFor(400);
  expect(cards(app)).toBe(48);
});
