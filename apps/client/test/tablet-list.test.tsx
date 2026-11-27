import { expect, open, test } from "nsh/test";

// On a tablet the group list can be folded away so the conversation takes the width: a button in
// the list's header folds it, one at the start of the conversation's header brings it back. Only
// the tablet layout has them.

const fixture = "./fixtures/tablet-list.tsx";
const list = "label:New conversation";
const fold = "label:Collapse sidebar";
const unfold = "label:Expand sidebar";
const composer = "id:conversation-composer";

async function start(width: number, height: number) {
  const app = await open(fixture, { width, height, locale: "en-US" });
  await app.waitFor("text:Website redesign");
  await app.wait(300);
  return app;
}

test("tablet: the list is folded by its button and comes back by the conversation's", async () => {
  const app = await start(834, 1112);
  expect(app.shows(list)).toBe(true);
  expect(app.shows(unfold)).toBe(false);
  expect(app.accessibility(fold)?.expanded).toBe(true);
  await app.press(fold);
  expect(app.shows(list)).toBe(false);
  expect(app.shows(fold)).toBe(false);
  expect(app.accessibility(unfold)?.expanded).toBe(false);
  // The conversation is still there, with its own Panel button.
  expect(app.shows("label:Panel")).toBe(true);
  await app.press(unfold);
  expect(app.shows(list)).toBe(true);
  expect(app.shows(unfold)).toBe(false);
});

test("tablet: the conversation takes the width the list gave up", async () => {
  const app = await start(834, 1112);
  const before = app.layout(composer)!;
  await app.press(fold);
  const after = app.layout(composer)!;
  expect(after.width).toBeGreaterThan(before.width);
});

test("tablet: a folded list stays folded on Captain's page, and can be brought back there", async () => {
  const app = await start(834, 1112);
  await app.press(fold);
  await app.press("label:Captain");
  expect(app.shows(list)).toBe(false);
  expect(app.shows(unfold)).toBe(true);
  await app.press(unfold);
  expect(app.shows(list)).toBe(true);
});

test("desktop keeps its own sidebar toggle and has no list button of its own", async () => {
  const app = await start(1440, 900);
  expect(app.count(fold)).toBe(1);
  expect(app.shows(unfold)).toBe(false);
  await app.press(fold);
  expect(app.count(unfold)).toBe(1);
  expect(app.shows(fold)).toBe(false);
  // The expand button replaces the wordmark in the sidebar's top row.
  expect(app.layout(unfold)!.y).toBeLessThan(app.layout("label:Captain")!.y);
});

test("phone has neither button", async () => {
  const app = await start(390, 844);
  expect(app.shows(fold)).toBe(false);
  expect(app.shows(unfold)).toBe(false);
});
