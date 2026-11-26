import type { App } from "nsh/test";
import { expect, open, test } from "nsh/test";

// The Artifacts tab finds, narrows, orders and pages a group's artifacts as the web app's tab
// does, and the context tab lists the latest five. These read the list a user sees: the titles
// in the order they are drawn, the counts, the range under the list. The fixture's group has 23
// (see fixtures/artifacts-panel.tsx).

const fixture = "./fixtures/artifacts-panel.tsx";
const plans = Array.from({ length: 20 }, (_, i) => `Plan ${i + 1}`);
const titles = new Set([
  "#5 Guided review",
  ...plans,
  "Ｇuided tour",
  "Changelog",
  "Elsewhere",
]);

/** The artifact titles on screen, in order. */
const rows = (app: App) => app.texts().filter((text) => titles.has(text));

async function artifactsTab(width = 1440, height = 900) {
  const app = await open(fixture, { width, height, locale: "en-US" });
  await app.press("label:Artifacts");
  return app;
}

/** Opens the Filter menu and picks `item` in it. */
async function pick(app: App, item: string) {
  await app.press("label:Filter");
  await pressInMenu(app, item);
}

/** The menu's item, also when the page has a button with that label (an agent's chip). */
async function pressInMenu(app: App, item: string) {
  // The menu is drawn after the page, so its item is the second of two.
  await app
    .press(`label:${item}`)
    .catch(() => app.press(`label:${item} >> nth=1`));
}

test("lists the newest first, 15 to a page, and turns the pages", async () => {
  const app = await artifactsTab();
  expect(rows(app)).toEqual(["#5 Guided review", ...plans.slice(0, 14)]);
  expect(app.texts()).toContain("1–15 / 23");
  expect(rows(app)).not.toContain("Elsewhere");

  await app.press("label:Page 2");
  expect(rows(app)).toEqual([...plans.slice(14), "Ｇuided tour", "Changelog"]);
  expect(app.texts()).toContain("16–23 / 23");

  await app.press("label:Previous page");
  expect(app.texts()).toContain("1–15 / 23");
  await app.press("label:Next page");
  expect(app.texts()).toContain("16–23 / 23");
});

test("searches the titles, whatever the case or width of the letters", async () => {
  const app = await artifactsTab();
  await app.type("label:Search artifacts", "GUIDED");
  expect(rows(app)).toEqual(["#5 Guided review", "Ｇuided tour"]);
  expect(app.texts()).toContain("2 of 23");
  expect(app.texts()).toContain("1–2 / 2");

  await app.press("label:Clear search");
  expect(rows(app)).toHaveLength(15);
  expect(app.texts()).not.toContain("2 of 23");
});

test("a search goes back to the first page", async () => {
  const app = await artifactsTab();
  await app.press("label:Page 2");
  await app.type("label:Search artifacts", "plan 1");
  expect(rows(app)).toEqual([
    "Plan 1",
    ...plans.filter((p) => p.startsWith("Plan 1") && p !== "Plan 1"),
  ]);
  expect(app.texts()).toContain("1–11 / 11");
});

test("keeps one publisher's, with each publisher's count in the menu", async () => {
  const app = await artifactsTab();
  await app.press("label:Filter");
  for (const count of ["23", "20", "2", "1"])
    expect(app.texts()).toContain(count);
  await pressInMenu(app, "Bo");
  expect(rows(app)).toEqual(["#5 Guided review", "Ｇuided tour"]);
  expect(app.texts()).toContain("2 of 23");

  await pick(app, "Cyrus");
  expect(rows(app)).toEqual(["Changelog"]);
  await pick(app, "All");
  expect(rows(app)).toHaveLength(15);
});

test("keeps the ones linked to a task, and the ones with more than one version", async () => {
  const app = await artifactsTab();
  await pick(app, "Linked to a task");
  expect(rows(app)).toEqual(["#5 Guided review", "Changelog"]);
  await pick(app, "Linked to a task");
  expect(rows(app)).toHaveLength(15);

  await pick(app, "More than one version");
  expect(rows(app)).toEqual(["#5 Guided review", "Changelog"]);
  await pick(app, "Bo");
  expect(rows(app)).toEqual(["#5 Guided review"]);
  expect(app.texts()).toContain("1 of 23");
});

test("sorts by title, numbers in order and without day headings, or by creation", async () => {
  const app = await artifactsTab();
  await pick(app, "Title A→Z");
  // The full-width Ｇ sorts as a G; "Plan 2" before "Plan 10".
  expect(rows(app)).toEqual([
    "#5 Guided review",
    "Changelog",
    "Ｇuided tour",
    ...plans.slice(0, 12),
  ]);
  for (const heading of ["Today", "Yesterday", "Earlier"])
    expect(app.texts()).not.toContain(heading);
  // An order narrows nothing: no count, nothing to clear.
  expect(app.texts()).not.toContain("Clear filters");

  await pick(app, "Recently created");
  expect(rows(app).slice(0, 3)).toEqual(["Plan 20", "Plan 19", "Plan 18"]);
});

test("nothing found says so and clearing the filters brings the list back", async () => {
  const app = await artifactsTab();
  await pick(app, "Bo");
  await app.type("label:Search artifacts", "zzz");
  expect(rows(app)).toEqual([]);
  expect(app.texts()).toContain("No artifacts match “zzz”");
  expect(app.texts()).toContain("0 of 23");
  expect(app.texts()).not.toContain("0–0 / 0");

  // The empty state's own button, under the count's.
  await app.press("label:Clear filters >> nth=1");
  expect(rows(app)).toEqual(["#5 Guided review", ...plans.slice(0, 14)]);
  expect(app.texts()).not.toContain("Clear filters");
});

test("a filter with no match says so without a query", async () => {
  const app = await artifactsTab();
  await pick(app, "Cyrus");
  await pick(app, "More than one version");
  await pick(app, "Ada");
  expect(app.texts()).toContain("No artifacts match these filters");
});

test("the filters stay while the panel shows another tab", async () => {
  const app = await artifactsTab();
  await pick(app, "Bo");
  await app.press("label:Context");
  await app.press("label:Artifacts");
  expect(rows(app)).toEqual(["#5 Guided review", "Ｇuided tour"]);
});

for (const [name, width, height] of [
  ["desktop", 1440, 900],
  ["tablet", 834, 1112],
] as const)
  test(`the context tab lists the latest five and View all opens the tab (${name})`, async () => {
    const app = await open(fixture, { width, height, locale: "en-US" });
    if (name === "tablet") await app.press("label:Panel");
    expect(rows(app)).toEqual(["#5 Guided review", ...plans.slice(0, 4)]);
    await app.press("label:View all artifacts");
    expect(app.texts()).toContain("1–15 / 23");
  });

test("the context tab's View all tasks opens the Tasks tab, closed tasks included", async () => {
  const app = await open(fixture, {
    width: 1440,
    height: 900,
    locale: "en-US",
  });
  expect(app.texts()).not.toContain("Completed 1");
  await app.press("label:View all tasks");
  expect(app.texts()).toContain("Needs you first");
  expect(app.texts()).toContain("Completed 1");
});

test("on a phone the info sheet lists the latest five and View all opens the whole list", async () => {
  const app = await open(fixture, { width: 390, height: 844, locale: "en-US" });
  await app.press("label:Conversation info");
  expect(rows(app)).toEqual(["#5 Guided review", ...plans.slice(0, 4)]);
  await app.press("label:View all artifacts");
  expect(app.texts()).toContain("1–15 / 23");

  await app.type("label:Search artifacts", "guided");
  expect(rows(app)).toEqual(["#5 Guided review", "Ｇuided tour"]);
  await pick(app, "Linked to a task");
  expect(rows(app)).toEqual(["#5 Guided review"]);
  await app.press("text:Clear filters");
  expect(rows(app)).toHaveLength(15);

  await app.press("label:Back");
  expect(rows(app)).toEqual(["#5 Guided review", ...plans.slice(0, 4)]);
});
