import { expect, open, test } from "nsh/test";

// Deleting a routine from its page's "⋯" menu, on the desktop and on a phone, and a page left
// open on one another window deleted.

async function routines(width = 1280) {
  const app = await open("./fixtures/routine-delete.tsx", {
    platform: width < 600 ? "ios" : "macos",
    width,
    height: 760,
    locale: "en-US",
  });
  await app.waitFor("label:Routine actions");
  return app;
}

test("a routine deleted from its menu leaves the list", async () => {
  const app = await routines();
  expect(app.shows("text:Inbox sweep")).toBe(true);
  await app.press("label:Routine actions");
  await app.press("label:Delete…");
  expect(app.shows("text:Delete “Weekly digest”?")).toBe(true);
  await app.press("label:Delete");
  await app.waitFor("text:Calls: digest");
  await app.waitUntil(() => !app.shows("text:Weekly digest"));
  expect(app.shows("text:Inbox sweep")).toBe(true);
  expect(app.shows("text:This routine no longer exists")).toBe(false);
});

test("cancelling the question deletes nothing", async () => {
  const app = await routines();
  await app.press("label:Routine actions");
  await app.press("label:Delete…");
  await app.press("label:Cancel");
  await app.waitUntil(() => !app.shows("text:Delete “Weekly digest”?"));
  expect(app.shows("text:Calls: none")).toBe(true);
  expect(app.shows("text:Weekly digest")).toBe(true);
});

test("a routine page open when it is deleted elsewhere says it no longer exists", async () => {
  const app = await routines();
  await app.press("label:Delete elsewhere");
  await app.waitFor("text:This routine no longer exists");
  await app.press("label:Back to routines");
  await app.waitFor("text:Select a routine");
  expect(app.shows("text:This routine no longer exists")).toBe(false);
});

test("on a phone the delete goes back to the list", async () => {
  const app = await routines(390);
  await app.press("label:Routine actions");
  await app.press("label:Delete…");
  await app.press("label:Delete");
  await app.waitFor("text:Calls: digest");
  await app.waitFor("text:Inbox sweep");
  expect(app.shows("text:Weekly digest")).toBe(false);
});

test("a connection that cannot delete routines sees the item dimmed", async () => {
  const app = await routines();
  await app.press("label:Read-only");
  await app.press("label:Routine actions");
  expect(app.enabled("label:Delete…")).toBe(false);
});
