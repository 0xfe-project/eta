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

function expectNoInlineStatus(app: Awaited<ReturnType<typeof open>>) {
  expect(app.shows("id:optimistic-status")).toBe(false);
  expect(app.texts()).not.toContain("Saving…");
  expect(app.texts()).not.toContain("Saved");
}

test("plugin switches (compact, full, Composio) and steward picker update optimistically and retry via toast", async () => {
  const app = await openMode("plugin");

  // Switch to fail mode.
  await app.press("label:Mode: succeed");

  // 1. Compact plugin switch: flips immediately, rolls back on error, retries via toast.
  await app.press("label:Enabled >> nth=0");
  expect(app.accessibility("label:Enabled >> nth=0")?.checked).toBe("false");
  expectNoInlineStatus(app);
  await app.clock!.runFor(350);
  expectNoInlineStatus(app);

  await app.press("label:Reject");
  expect(app.accessibility("label:Enabled >> nth=0")?.checked).toBe("true");
  expect(app.shows("id:toast")).toBe(true);
  expect(app.texts()).toContain("Couldn’t save");
  expect(app.texts()).toContain("Host rejected");
  expect(app.shows("id:toast >> label:Retry")).toBe(true);
  expectNoInlineStatus(app);

  await app.press("label:Mode: fail");
  await app.press("id:toast >> label:Retry");
  expect(app.accessibility("label:Enabled >> nth=0")?.checked).toBe("false");
  expectNoInlineStatus(app);
  await app.clock!.runFor(350);
  expectNoInlineStatus(app);
  await app.press("label:Resolve");
  expect(app.accessibility("label:Enabled >> nth=0")?.checked).toBe("false");
  expectNoInlineStatus(app);

  // 2. Full plugin switch: updates caption immediately, rolls back on error, retries via toast.
  await app.press("label:Mode: succeed");
  await app.press("label:Enabled >> nth=1");
  expect(app.accessibility("label:Enabled >> nth=1")?.checked).toBe("false");
  expect(app.shows("id:plugin-full >> text:Off for all agents")).toBe(true);
  expectNoInlineStatus(app);
  await app.clock!.runFor(350);
  expectNoInlineStatus(app);

  await app.press("label:Reject");
  expect(app.accessibility("label:Enabled >> nth=1")?.checked).toBe("true");
  expect(app.shows("id:plugin-full >> text:Off for all agents")).toBe(false);
  expect(app.shows("id:toast >> label:Retry")).toBe(true);
  expectNoInlineStatus(app);

  await app.press("label:Mode: fail");
  await app.press("id:toast >> label:Retry");
  expect(app.accessibility("label:Enabled >> nth=1")?.checked).toBe("false");
  expect(app.shows("id:plugin-full >> text:Off for all agents")).toBe(true);
  expectNoInlineStatus(app);
  await app.clock!.runFor(350);
  expectNoInlineStatus(app);
  await app.press("label:Resolve");
  expect(app.accessibility("label:Enabled >> nth=1")?.checked).toBe("false");
  expectNoInlineStatus(app);

  // 3. Composio plugin switch: flips its caption, rolls back on error, retries via toast.
  await app.press("label:Mode: succeed");
  await app.press("label:Enabled: @composio/gmail");
  expect(app.shows("id:composio-plugin-off")).toBe(true);
  expectNoInlineStatus(app);
  await app.clock!.runFor(350);
  expectNoInlineStatus(app);

  await app.press("label:Reject");
  expect(app.shows("id:composio-plugin-off")).toBe(false);
  expect(app.shows("id:toast >> label:Retry")).toBe(true);
  expectNoInlineStatus(app);

  await app.press("label:Mode: fail");
  await app.press("id:toast >> label:Retry");
  expect(app.shows("id:composio-plugin-off")).toBe(true);
  expectNoInlineStatus(app);
  await app.clock!.runFor(350);
  expectNoInlineStatus(app);
  await app.press("label:Resolve");
  expect(app.shows("id:composio-plugin-off")).toBe(true);
  expectNoInlineStatus(app);

  // 4. Steward picker: flips immediately, with no Saving/Saved text, rolls back to Ada, retries via toast.
  await app.press("label:Mode: succeed");
  await app.press("label:Steward");
  await app.waitFor("label:Ben");
  await app.press("label:Ben");
  expect(app.shows("label:Steward >> text:Ben")).toBe(true);
  expectNoInlineStatus(app);
  await app.clock!.runFor(350);
  expectNoInlineStatus(app);

  await app.press("label:Reject");
  expect(app.shows("label:Steward >> text:Ada")).toBe(true);
  expect(app.shows("id:toast >> label:Retry")).toBe(true);
  expectNoInlineStatus(app);

  await app.press("label:Mode: fail");
  await app.press("id:toast >> label:Retry");
  expect(app.shows("label:Steward >> text:Ben")).toBe(true);
  expectNoInlineStatus(app);
  await app.clock!.runFor(350);
  expectNoInlineStatus(app);
  await app.press("label:Resolve");
  expect(app.shows("label:Steward >> text:Ben")).toBe(true);
  expectNoInlineStatus(app);
});

test("routine pause/resume toggles optimistically, rolls back on failure, and retries via toast", async () => {
  const app = await openMode("routine");
  await app.waitFor("label:Pause");

  await app.press("label:Mode: succeed"); // switch to fail mode
  await app.press("label:Pause");
  // Immediately flipped to Resume (paused state) optimistically.
  expect(app.shows("label:Resume")).toBe(true);
  expectNoInlineStatus(app);
  await app.clock!.runFor(350);
  expectNoInlineStatus(app);

  await app.press("label:Reject");
  // Rolled back to Pause with toast Retry.
  expect(app.shows("label:Pause")).toBe(true);
  expect(app.shows("id:toast")).toBe(true);
  expect(app.texts()).toContain("Couldn’t save");
  expect(app.texts()).toContain("Host rejected");
  expect(app.shows("id:toast >> label:Retry")).toBe(true);
  expectNoInlineStatus(app);

  await app.press("label:Mode: fail"); // switch to succeed mode
  await app.press("id:toast >> label:Retry");
  expect(app.shows("label:Resume")).toBe(true);
  expectNoInlineStatus(app);
  await app.clock!.runFor(350);
  expectNoInlineStatus(app);
  await app.press("label:Resolve");
  expect(app.shows("label:Resume")).toBe(true);
  expectNoInlineStatus(app);
});

test("archive restore hides row optimistically, brings it back on failure, and retries via toast", async () => {
  const app = await openMode("archive");
  await app.waitFor("text:Archived cleanup");

  await app.press("label:Mode: succeed"); // fail mode
  await app.press("label:Restore");
  // Immediately hidden optimistically.
  expect(app.texts()).not.toContain("Archived cleanup");
  expectNoInlineStatus(app);
  await app.clock!.runFor(350);
  expectNoInlineStatus(app);

  // Failure restores it and offers Retry via toast.
  await app.press("label:Reject");
  expect(app.texts()).toContain("Archived cleanup");
  expect(app.shows("id:toast")).toBe(true);
  expect(app.texts()).toContain("Couldn’t save");
  expect(app.texts()).toContain("Host rejected");
  expect(app.shows("id:toast >> label:Retry")).toBe(true);
  expectNoInlineStatus(app);

  await app.press("label:Mode: fail");
  await app.press("id:toast >> label:Retry");
  expect(app.texts()).not.toContain("Archived cleanup");
  expectNoInlineStatus(app);
  await app.clock!.runFor(350);
  expectNoInlineStatus(app);
  await app.press("label:Resolve");
  expect(app.texts()).not.toContain("Archived cleanup");
  expectNoInlineStatus(app);
});

test("model source toggle updates optimistically, rolls back on failure, and retries via toast", async () => {
  const app = await openMode("models");
  await app.waitFor("text:Codex");
  expect(app.texts()).toContain("Working");

  await app.press("label:Mode: succeed"); // fail mode
  await app.press("label:Work");
  await app.waitFor("label:Disable");
  await app.press("label:Disable");
  expect(app.texts()).toContain("Disabled");
  expectNoInlineStatus(app);
  await app.clock!.runFor(350);
  expectNoInlineStatus(app);

  await app.press("label:Reject");
  expect(app.texts()).toContain("Working");
  expect(app.texts()).not.toContain("Disabled");
  expect(app.shows("id:toast")).toBe(true);
  expect(app.texts()).toContain("Couldn’t save");
  expect(app.texts()).toContain("Host rejected");
  expect(app.shows("id:toast >> label:Retry")).toBe(true);
  expectNoInlineStatus(app);

  await app.press("label:Mode: fail");
  await app.press("id:toast >> label:Retry");
  expect(app.texts()).toContain("Disabled");
  expectNoInlineStatus(app);
  await app.clock!.runFor(350);
  expectNoInlineStatus(app);
  await app.press("label:Resolve");
  expect(app.texts()).toContain("Disabled");
  expectNoInlineStatus(app);
});

test("task inline rename and description edit update optimistically, roll back on error, and retry via toast", async () => {
  const app = await openMode("task");
  await app.waitFor("text:Goal");

  // Inline title rename.
  await app.press("label:Mode: succeed"); // fail mode
  await app.press("label:Rename task");
  expect(app.texts()).toContain("Updated title");
  expectNoInlineStatus(app);
  await app.clock!.runFor(350);
  expectNoInlineStatus(app);

  await app.press("label:Reject");
  expect(app.texts()).toContain("Initial title");
  expect(app.texts()).not.toContain("Updated title");
  expect(app.shows("id:toast")).toBe(true);
  expect(app.texts()).toContain("Couldn’t save");
  expect(app.texts()).toContain("Host rejected");
  expect(app.shows("id:toast >> label:Retry")).toBe(true);
  expectNoInlineStatus(app);

  await app.press("label:Mode: fail");
  await app.press("id:toast >> label:Retry");
  expect(app.texts()).toContain("Updated title");
  expectNoInlineStatus(app);
  await app.clock!.runFor(350);
  expectNoInlineStatus(app);
  await app.press("label:Resolve");
  expect(app.texts()).toContain("Updated title");
  expectNoInlineStatus(app);

  // Inline description edit.
  await app.press("label:Mode: succeed");
  await app.press("label:Save description");
  expect(app.texts()).toContain("Updated description");
  expectNoInlineStatus(app);
  await app.clock!.runFor(350);
  expectNoInlineStatus(app);

  await app.press("label:Reject");
  expect(app.texts()).toContain("Initial description");
  expect(app.texts()).not.toContain("Updated description");
  expect(app.shows("id:toast >> label:Retry")).toBe(true);
  expectNoInlineStatus(app);

  await app.press("label:Mode: fail");
  await app.press("id:toast >> label:Retry");
  expect(app.texts()).toContain("Updated description");
  expectNoInlineStatus(app);
  await app.clock!.runFor(350);
  expectNoInlineStatus(app);
  await app.press("label:Resolve");
  expect(app.texts()).toContain("Updated description");
  expectNoInlineStatus(app);
});

test("task comment posts optimistically, rolls back on error, reuses idempotent clientId on toast retry, and clears composer", async () => {
  const app = await openMode("task-comment");
  await app.waitFor("label:Comment");

  await app.press("label:Mode: succeed"); // fail mode
  await app.type("label:Comment", "Ship it!");
  expect(app.enabled("label:Send comment")).toBe(true);
  await app.press("label:Send comment");

  expect(app.texts()).toContain("Activity count: 1");
  const firstCall = app.texts().find((t) => t.startsWith("Last call:"))!;
  expectNoInlineStatus(app);
  await app.clock!.runFor(350);
  expectNoInlineStatus(app);

  await app.press("label:Reject");
  expect(app.texts()).toContain("Activity count: 0");
  // Draft preserved when post fails.
  expect(app.enabled("label:Send comment")).toBe(true);
  expect(app.shows("id:toast")).toBe(true);
  expect(app.texts()).toContain("Couldn’t save");
  expect(app.texts()).toContain("Host rejected");
  expect(app.shows("id:toast >> label:Retry")).toBe(true);
  expectNoInlineStatus(app);

  await app.press("label:Mode: fail"); // succeed mode
  await app.press("id:toast >> label:Retry");
  expect(app.texts()).toContain("Activity count: 1");
  const retryCall = app.texts().find((t) => t.startsWith("Last call:"))!;
  expect(retryCall).toBe(firstCall);
  expectNoInlineStatus(app);
  await app.clock!.runFor(350);
  expectNoInlineStatus(app);

  await app.press("label:Resolve");
  // Composer cleared once the retry succeeds.
  expect(app.enabled("label:Send comment")).toBe(false);
  expectNoInlineStatus(app);
});
