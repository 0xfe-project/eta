import { expect, open, test } from "nsh/test";

const fixture = "./fixtures/optimistic-updates.tsx";

async function openMode(mode: string) {
  return open(fixture, {
    width: 1280,
    height: 800,
    locale: "en-US",
    platform: "web",
    storage: { mode },
    clock: {},
  });
}

test("plugin switch updates optimistically, rolls back on failure, and retries inline", async () => {
  const app = await openMode("plugin");
  await app.press("label:Mode: succeed");
  // Now in fail mode.
  await app.press("label:Enabled");
  // Immediately shows off before host responds, and after 300ms shows Saving…
  await app.clock!.runFor(350);
  expect(app.texts()).toContain("Saving…");

  // Reject rolls back and renders Retry.
  await app.press("label:Reject");
  expect(app.texts()).toContain("Host rejected");
  expect(app.shows("label:Retry")).toBe(true);

  // Switch to succeed mode and click Retry.
  await app.press("label:Mode: fail");
  await app.press("label:Retry");
  await app.press("label:Resolve");
  expect(app.texts()).toContain("Saved");
});

test("routine pause/resume toggles optimistically and rolls back on failure with Retry", async () => {
  const app = await openMode("routine");
  await app.press("label:Mode: succeed"); // switch to fail mode
  await app.press("label:Pause");
  // Immediately flipped to Resume (paused state) optimistically.
  expect(app.shows("label:Resume")).toBe(true);

  await app.press("label:Reject");
  // Rolled back to Pause with inline Retry.
  expect(app.shows("label:Pause")).toBe(true);
  expect(app.shows("label:Retry")).toBe(true);

  await app.press("label:Mode: fail"); // switch to succeed mode
  await app.press("label:Retry");
  await app.press("label:Resolve");
  expect(app.texts()).toContain("Saved");
});

test("archive restore hides row optimistically and brings it back on failure with Retry", async () => {
  const app = await openMode("archive");
  expect(app.texts()).toContain("Archived cleanup");
  await app.press("label:Mode: succeed"); // fail mode
  await app.press("label:Restore");
  // Immediately hidden optimistically.
  expect(app.texts()).not.toContain("Archived cleanup");

  // Failure restores it and offers Retry.
  await app.press("label:Reject");
  expect(app.texts()).toContain("Archived cleanup");
  expect(app.shows("label:Retry")).toBe(true);
});

test("task inline rename and comment post optimistically, roll back on error, and reuse idempotent clientId on retry", async () => {
  const app = await openMode("task");
  await app.press("label:Mode: succeed"); // fail mode

  // Inline title rename updates immediately, then rolls back on error.
  await app.press("label:Rename task");
  expect(app.texts()).toContain("Title: Updated title");
  await app.press("label:Reject");
  expect(app.texts()).toContain("Title: Initial title");
  expect(app.texts()).toContain("Edit status: error");

  // Comment inserts optimistically, rolls back on error, and reuses the same clientId on retry.
  await app.press("label:Post comment");
  expect(app.texts()).toContain("Activity count: 1");
  const firstCall = app.texts().find((t) => t.startsWith("Last call:"))!;
  await app.press("label:Reject");
  expect(app.texts()).toContain("Activity count: 0");
  expect(app.texts()).toContain("Comment status: error");

  await app.press("label:Mode: fail"); // succeed mode
  await app.press("label:Post comment");
  const retryCall = app.texts().find((t) => t.startsWith("Last call:"))!;
  expect(retryCall).toBe(firstCall);
  await app.press("label:Resolve");
  expect(app.texts()).toContain("Comment status: saved");
});
