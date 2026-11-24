import type { App } from "nsh/test";
import { expect, open, test } from "nsh/test";
import { light } from "../src/components/theme";
import { weight } from "../src/components/tokens";

// A table in Markdown is shown as a table wherever a text system shows text: its cells are cells,
// and none of its pipes or its delimiter row are left as text. So are the other GFM blocks around
// it: task lists, footnotes, alerts, rules, code.

const start = () =>
  open("./fixtures/text-tables.tsx", {
    width: 1200,
    height: 3000,
    locale: "en-US",
  });

/** Texts on screen that show Markdown's own syntax: a table's pipes, its delimiter row. */
const raw = (app: App) => app.texts().filter((text) => /\||---/.test(text));
/** A palette token as a span reports it: `#rrggbbaa`. */
const rgba = (hex: string) => (hex.length === 7 ? `${hex}ff` : hex);
/** `label`'s text shows `text` as a text of its own (a cell, a paragraph). */
const shows = (app: App, label: string, text: string) =>
  app.shows(`label:${label} >> text:${text}`);

// A table's header used to be the only part of a chat body with no token of its own: the header
// cell took nothing but `fit()` (sizing), so its colour and weight were the renderer's defaults
// and clashed with the palette. It is a label now — the palette's muted ink, strong — and the
// body's cells say the ink outright, so the two read apart in either palette.
test("a table's header takes the theme's tokens, not the renderer's default", async () => {
  const app = await start();
  await app.waitFor("label:Spaced");
  const head = app.spanStyle("label:Spaced >> text:Name");
  const cell = app.spanStyle("label:Spaced >> text:alpha");
  expect(head.color).toBe(rgba(light.mutedInk));
  expect(cell.color).toBe(rgba(light.ink));
  expect(head.fontWeight).toBe(weight.strong);
  expect(cell.fontWeight).toBe(weight.regular);
});

/** `label`'s text shows its table as cells, and nothing on screen is a table left as text. */
function showsTable(app: App, label: string, cells: string[]) {
  expect(raw(app)).toEqual([]);
  for (const cell of cells) expect(shows(app, label, cell)).toBe(true);
}

test("a table shows as a table, after a blank line or right under a line of text", async () => {
  const app = await start();
  await app.waitFor("label:Spaced");
  showsTable(app, "Spaced", ["Name", "Size", "alpha", "12", "beta", "7"]);
  expect(shows(app, "Spaced", "Here is the comparison:")).toBe(true);
  showsTable(app, "Tight", ["名字", "Size", "alpha", "beta"]);
  expect(shows(app, "Tight", "下面是对比：")).toBe(true);
  // The lines before it are still lines of their own.
  showsTable(app, "Lines", ["Name", "Count", "alpha", "beta"]);
  expect(shows(app, "Lines", "First line\nsecond line")).toBe(true);
});

test("a table between folded pastes, and in a task's description", async () => {
  const app = await start();
  await app.waitFor("label:Pasted");
  showsTable(app, "Pasted", ["Name", "Size", "alpha", "beta"]);
  expect(app.count("label:Pasted >> label:Unfold pasted text (30 lines)")).toBe(
    2,
  );
  showsTable(app, "Description", ["Name", "Size", "gamma", "beta"]);
});

test("a reply's table cells keep their mention, code and link", async () => {
  const app = await start();
  await app.waitFor("text:Owners:");
  expect(raw(app)).toEqual([]);
  expect(app.shows("text:Who")).toBe(true);
  expect(app.shows("text:run.ts and docs")).toBe(true);
  expect(app.shows("label:Open Opus")).toBe(true);
  expect(app.shows("text:docs")).toBe(true);
});

test("the GFM blocks around a table keep their kind", async () => {
  const app = await start();
  await app.waitFor("label:Blocks");
  // A task list, a footnote, an alert (its [!NOTE] is its look, not its text), code on both sides.
  for (const text of [
    "write it",
    "✓",
    "A claim1 here.",
    "The source.",
    "Watch out.",
    "const before = 1;",
    "echo after",
  ])
    expect(shows(app, "Blocks", text)).toBe(true);
  expect(app.texts().some((text) => text.includes("[!NOTE]"))).toBe(false);
  showsTable(app, "Blocks", ["Kind", "Count", "fence", "2"]);
});

test("a table being written shows as a table as it comes, and whole once done", async () => {
  const app = await start();
  await app.waitFor("label:Streaming");
  showsTable(app, "Streaming", ["Step", "State", "one", "do"]);
  await app.press("label:Finish");
  await app.waitFor("label:Streaming >> text:two");
  showsTable(app, "Streaming", ["Step", "State", "one", "done", "two"]);
});
