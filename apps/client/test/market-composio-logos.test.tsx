import { expect, open, test } from "nsh/test";

// 100 Composio toolkits, drawn in batches; the host is asked, before a batch is drawn, for the pictures it kept.
// `reducedMotion: true` keeps the refresh button's finite spin animation from advancing the manual
// clock past `LOGOS_CACHED_WAIT_MS` while `open()` settles.
const WIDE = { width: 1000, height: 800, clock: {}, reducedMotion: true };
type App = Awaited<ReturnType<typeof open>>;
const cards = (app: App) => app.count("id:plugin-avatar");
// A letter avatar holds the first letter of the toolkit's name; a picture replaces it.
const letters = (app: App) => app.count("id:plugin-avatar >> text:T");
/**
 * Lets time pass in small steps, as real time does: an answer and a timeout that are both due within
 * one big step would be settled in one sweep, with the timeout always first.
 */
async function pass(app: App, ms: number) {
  for (let left = ms; left > 0; left -= 20)
    await app.clock!.runFor(Math.min(20, left));
}
/** Opens the market and lets the first batch come: the host's answer may take its time. */
async function first(mode: string, wait = 500) {
  const app = await open(`./fixtures/market-composio-logos-${mode}.tsx`, WIDE);
  await pass(app, wait);
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

test("a batch is asked for before it is drawn: it waits for the answer, then comes with its pictures", async () => {
  const app = await open("./fixtures/market-composio-logos-slow.tsx", WIDE);
  await pass(app, 100);
  // Asked, not answered, not drawn.
  expect(app.shows("asked 30 distinct 30")).toBe(true);
  expect(cards(app)).toBe(0);
  await app.press("label:release");
  await app.waitFor("label:Toolkit 0000");
  const batch = cards(app);
  expect(batch).toBe(30);
  expect(letters(app)).toBe(0);
  // The next one the same way.
  await app.press("label:Show more");
  expect(app.shows(`asked ${batch * 2} distinct ${batch * 2}`)).toBe(true);
  expect(cards(app)).toBe(batch);
  await app.press("label:release");
  expect(cards(app)).toBe(batch * 2);
  expect(letters(app)).toBe(0);
});

test("a host that does not answer holds nothing back: the batch is drawn after the wait, with letters", async () => {
  const app = await open("./fixtures/market-composio-logos-hang.tsx", WIDE);
  await pass(app, 300);
  expect(cards(app)).toBe(0);
  await pass(app, 200);
  await app.waitFor("label:Toolkit 0000");
  const batch = cards(app);
  expect(batch).toBeGreaterThan(0);
  expect(letters(app)).toBe(batch);
  await app.press("label:Show more");
  expect(cards(app)).toBe(batch);
  await pass(app, 450);
  expect(cards(app)).toBe(batch * 2);
});

test("a toolkit already asked about is not asked again after a search, even when the host did not know it", async () => {
  for (const mode of ["hit", "unknown"]) {
    const app = await first(mode);
    const batch = cards(app);
    await app.type("label:Search plugins", "Toolkit 000");
    await pass(app, 900);
    expect(cards(app)).toBe(10);
    expect(app.shows(`asked ${batch} distinct ${batch}`)).toBe(true);
  }
});
