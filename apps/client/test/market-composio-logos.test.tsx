import { expect, open, test } from "nsh/test";

// 100 Composio toolkits, drawn in batches; the host is asked, before a batch is drawn, for the pictures it kept.
const WIDE = { width: 1000, height: 800, clock: {} };
type App = Awaited<ReturnType<typeof open>>;
const cards = (app: App) => app.count("id:plugin-avatar");
// A letter avatar holds the first letter of the toolkit's name; a picture replaces it.
const letters = (app: App) => app.count("id:plugin-avatar >> text:T");
/** Opens the market and lets the first batch come: the host's answer may take its time. */
async function first(mode: string, wait = 500) {
  const app = await open(`./fixtures/market-composio-logos-${mode}.tsx`, WIDE);
  await app.clock!.runFor(wait);
  await app.waitFor("label:Toolkit 0000");
  return app;
}

test("a toolkit the host kept a picture for has it in the first frame, and never asks for its own", async () => {
  const app = await first("hit");
  expect(cards(app)).toBeGreaterThan(0);
  expect(letters(app)).toBe(0);
  expect(app.shows("logo 0")).toBe(true);
});

test("a host that does not know the toolkit entries answers unknown: letters first, and each card asks for its own", async () => {
  const app = await first("unknown");
  expect(letters(app)).toBe(cards(app));
  await app.waitFor("text:logo 4");
  expect(app.shows("logo 4")).toBe(true);
});

test("a host without logosCached: the list opens with letters, and each card asks for its own", async () => {
  const app = await first("old");
  expect(cards(app)).toBeGreaterThan(0);
  expect(letters(app)).toBe(cards(app));
  await app.waitFor("text:logo 4");
});

test("only the batch about to be drawn is asked for, not every toolkit, and each toolkit once", async () => {
  const app = await first("hit");
  const batch = cards(app);
  expect(batch).toBeLessThan(100);
  expect(app.shows(`asked ${batch} distinct ${batch}`)).toBe(true);
});

test("the next batch is asked for before it is drawn: it waits for the answer, then comes with its pictures", async () => {
  const app = await first("slow");
  const batch = cards(app);
  expect(letters(app)).toBe(0);
  await app.press("label:Show more");
  // Asked at once, drawn when the answer is in.
  expect(app.shows(`asked ${batch * 2} distinct ${batch * 2}`)).toBe(true);
  expect(cards(app)).toBe(batch);
  await app.clock!.runFor(300);
  expect(cards(app)).toBe(batch * 2);
  expect(letters(app)).toBe(0);
});

test("a host that does not answer holds nothing back: the batch is drawn after the wait, with letters", async () => {
  const app = await open("./fixtures/market-composio-logos-hang.tsx", WIDE);
  await app.clock!.runFor(300);
  expect(cards(app)).toBe(0);
  await app.clock!.runFor(200);
  await app.waitFor("label:Toolkit 0000");
  const batch = cards(app);
  expect(batch).toBeGreaterThan(0);
  expect(letters(app)).toBe(batch);
  await app.press("label:Show more");
  expect(cards(app)).toBe(batch);
  await app.clock!.runFor(450);
  expect(cards(app)).toBe(batch * 2);
});

test("a toolkit already asked about is not asked again after a search, even when the host did not know it", async () => {
  for (const mode of ["hit", "unknown"]) {
    const app = await first(mode);
    const batch = cards(app);
    await app.type("label:Search plugins", "Toolkit 000");
    await app.clock!.runFor(900);
    expect(cards(app)).toBe(10);
    expect(app.shows(`asked ${batch} distinct ${batch}`)).toBe(true);
  }
});
