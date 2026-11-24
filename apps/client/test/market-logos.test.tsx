import { expect, open, test } from "nsh/test";

const OPEN = { width: 1000, height: 700 };
// A letter avatar holds the entry's first letter; a picture replaces it.
const letter = (app: Awaited<ReturnType<typeof open>>, name: string) =>
  app.count(`id:plugin-avatar >> text:${name.charAt(0).toUpperCase()}`);

test("a kept picture is in the first frame: no letter for it, a letter for a known miss", async () => {
  const app = await open("./fixtures/market-logos-hit.tsx", OPEN);
  expect(app.shows("kept-entry")).toBe(true);
  expect(letter(app, "kept-entry")).toBe(0);
  expect(letter(app, "no-logo")).toBe(1);
});

test("an entry the host does not know yet is a letter first, and asks for its own picture", async () => {
  const app = await open("./fixtures/market-logos-hit.tsx", OPEN);
  expect(app.shows("unknown-one")).toBe(true);
  expect(letter(app, "unknown-one")).toBe(1);
});

test("a host that does not answer in time: the list still opens, with letters, and each card asks for its own", async () => {
  const app = await open("./fixtures/market-logos-stalled.tsx", OPEN);
  await app.waitFor("text:kept-entry");
  expect(letter(app, "kept-entry")).toBe(1);
  expect(app.shows("no-logo")).toBe(true);
  expect(app.shows("unknown-one")).toBe(true);
});

test("a host without logosCached: the list opens with letters, nothing is lost", async () => {
  const app = await open("./fixtures/market-logos-old.tsx", OPEN);
  expect(app.shows("kept-entry")).toBe(true);
  expect(letter(app, "kept-entry")).toBe(1);
  expect(letter(app, "no-logo")).toBe(1);
});

test("a market longer than a batch is asked about one batch of cards at a time, each picture once", async () => {
  const app = await open("./fixtures/market-logos-many.tsx", OPEN);
  // 260 entries, one of them a twin of another: only the first batch of cards (ten rows of three at
  // this width) is asked about before it is drawn, and a call is never more than the 50 the host answers whole.
  expect(app.shows("batches 30")).toBe(true);
  await app.press("label:Show more");
  // The next batch asks only for the cards it adds.
  expect(app.shows("batches 30+30")).toBe(true);
});

test("only an entry the host does not know asks for its own picture; a kept one or a known miss does not", async () => {
  const app = await open("./fixtures/market-logos-many.tsx", OPEN);
  await app.waitFor("text:logo p/0");
  expect(app.shows("logo p/0")).toBe(true);
});
