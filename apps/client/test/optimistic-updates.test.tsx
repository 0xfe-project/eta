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

test("plugin switches (compact, full, Composio) and steward picker update optimistically with zero layout shift and retry via toast", async () => {
  const app = await openMode("plugin");

  const compactAfter0 = app.layout("id:plugin-compact-after")!;
  const pluginFull0 = app.layout("id:plugin-full")!;
  const pluginAfter0 = app.layout("id:plugin-after")!;
  const composioRow0 = app.layout("id:composio-row")!;
  const composioAfter0 = app.layout("id:composio-after")!;
  const stewardAfterAda = app.layout("id:steward-after")!;

  const checkAllStable = () => {
    expectNoInlineStatus(app);
    const compactAfter = app.layout("id:plugin-compact-after")!;
    expect(compactAfter.x).toBe(compactAfter0.x);
    expect(compactAfter.y).toBe(compactAfter0.y);
    const pluginFull = app.layout("id:plugin-full")!;
    expect(pluginFull.height).toBe(pluginFull0.height);
    const pluginAfter = app.layout("id:plugin-after")!;
    expect(pluginAfter.y).toBe(pluginAfter0.y);
    const composioRow = app.layout("id:composio-row")!;
    expect(composioRow.height).toBe(composioRow0.height);
    const composioAfter = app.layout("id:composio-after")!;
    expect(composioAfter.y).toBe(composioAfter0.y);
    const stewardAfter = app.layout("id:steward-after")!;
    expect(stewardAfter.y).toBe(stewardAfterAda.y);
  };

  // Switch to fail mode.
  await app.press("label:Mode: succeed");

  // 1. Compact plugin switch: flips immediately, zero horizontal/vertical shift, rolls back on error, retries via toast.
  await app.press("label:Enabled >> nth=0");
  expect(app.accessibility("label:Enabled >> nth=0")?.checked).toBe("false");
  checkAllStable();
  await app.clock!.runFor(350);
  checkAllStable();

  await app.press("label:Reject");
  expect(app.accessibility("label:Enabled >> nth=0")?.checked).toBe("true");
  expect(app.shows("id:toast")).toBe(true);
  expect(app.texts()).toContain("Couldn’t save");
  expect(app.texts()).toContain("Host rejected");
  expect(app.shows("id:toast >> label:Retry")).toBe(true);
  checkAllStable();

  await app.press("label:Mode: fail");
  await app.press("id:toast >> label:Retry");
  expect(app.accessibility("label:Enabled >> nth=0")?.checked).toBe("false");
  checkAllStable();
  await app.clock!.runFor(350);
  checkAllStable();
  await app.press("label:Resolve");
  expect(app.accessibility("label:Enabled >> nth=0")?.checked).toBe("false");
  checkAllStable();

  // 2. Full plugin switch: updates caption immediately, zero layout shift, rolls back on error, retries via toast.
  await app.press("label:Mode: succeed");
  await app.press("label:Enabled >> nth=1");
  expect(app.accessibility("label:Enabled >> nth=1")?.checked).toBe("false");
  expect(app.shows("id:plugin-full >> text:Off for all agents")).toBe(true);
  checkAllStable();
  await app.clock!.runFor(350);
  checkAllStable();

  await app.press("label:Reject");
  expect(app.accessibility("label:Enabled >> nth=1")?.checked).toBe("true");
  expect(app.shows("id:plugin-full >> text:Off for all agents")).toBe(false);
  expect(app.shows("id:toast >> label:Retry")).toBe(true);
  checkAllStable();

  await app.press("label:Mode: fail");
  await app.press("id:toast >> label:Retry");
  expect(app.accessibility("label:Enabled >> nth=1")?.checked).toBe("false");
  expect(app.shows("id:plugin-full >> text:Off for all agents")).toBe(true);
  checkAllStable();
  await app.clock!.runFor(350);
  checkAllStable();
  await app.press("label:Resolve");
  expect(app.accessibility("label:Enabled >> nth=1")?.checked).toBe("false");
  checkAllStable();

  // 3. Composio plugin switch: keeps caption height and row height, rolls back on error, retries via toast.
  await app.press("label:Mode: succeed");
  await app.press("label:Enabled: @composio/gmail");
  expect(app.shows("id:composio-plugin-off")).toBe(true);
  checkAllStable();
  await app.clock!.runFor(350);
  checkAllStable();

  await app.press("label:Reject");
  expect(app.shows("id:composio-plugin-off")).toBe(false);
  expect(app.shows("id:toast >> label:Retry")).toBe(true);
  checkAllStable();

  await app.press("label:Mode: fail");
  await app.press("id:toast >> label:Retry");
  expect(app.shows("id:composio-plugin-off")).toBe(true);
  checkAllStable();
  await app.clock!.runFor(350);
  checkAllStable();
  await app.press("label:Resolve");
  expect(app.shows("id:composio-plugin-off")).toBe(true);
  checkAllStable();

  // 4. Steward picker: flips immediately, zero Saving/Saved horizontal jitter, rolls back to Ada's x, retries via toast.
  await app.press("label:Mode: succeed");
  await app.press("label:Steward");
  await app.waitFor("label:Ben");
  await app.press("label:Ben");
  expect(app.shows("label:Steward >> text:Ben")).toBe(true);
  const stewardAfterBen = app.layout("id:steward-after")!;
  checkAllStable();
  await app.clock!.runFor(350);
  expect(app.layout("id:steward-after")!.x).toBe(stewardAfterBen.x);
  checkAllStable();

  await app.press("label:Reject");
  expect(app.shows("label:Steward >> text:Ada")).toBe(true);
  expect(app.layout("id:steward-after")!.x).toBe(stewardAfterAda.x);
  expect(app.shows("id:toast >> label:Retry")).toBe(true);
  checkAllStable();

  await app.press("label:Mode: fail");
  await app.press("id:toast >> label:Retry");
  expect(app.shows("label:Steward >> text:Ben")).toBe(true);
  expect(app.layout("id:steward-after")!.x).toBe(stewardAfterBen.x);
  checkAllStable();
  await app.clock!.runFor(350);
  expect(app.layout("id:steward-after")!.x).toBe(stewardAfterBen.x);
  checkAllStable();
  await app.press("label:Resolve");
  expect(app.shows("label:Steward >> text:Ben")).toBe(true);
  expect(app.layout("id:steward-after")!.x).toBe(stewardAfterBen.x);
  checkAllStable();
});

test("routine pause/resume toggles optimistically with zero layout shift, rolls back on failure, and retries via toast", async () => {
  const app = await openMode("routine");
  await app.waitFor("label:Pause");

  const runNow0 = app.layout("label:Run now >> nth=0")!;
  const schedule0 = app.layout("text:Schedule")!;

  const checkRoutineStable = (
    switchSelector: string,
    switch0: { x: number; y: number; height: number },
  ) => {
    expectNoInlineStatus(app);
    const sw = app.layout(switchSelector)!;
    expect(sw.x).toBe(switch0.x);
    expect(sw.y).toBe(switch0.y);
    expect(sw.height).toBe(switch0.height);
    const runNow = app.layout("label:Run now >> nth=0")!;
    expect(runNow.x).toBe(runNow0.x);
    expect(runNow.y).toBe(runNow0.y);
    expect(app.layout("text:Schedule")!.y).toBe(schedule0.y);
  };

  const pause0 = app.layout("label:Pause")!;
  await app.press("label:Mode: succeed"); // switch to fail mode
  await app.press("label:Pause");
  // Immediately flipped to Resume (paused state) optimistically.
  expect(app.shows("label:Resume")).toBe(true);
  checkRoutineStable("label:Resume", pause0);
  await app.clock!.runFor(350);
  checkRoutineStable("label:Resume", pause0);

  await app.press("label:Reject");
  // Rolled back to Pause with toast Retry and zero layout shift.
  expect(app.shows("label:Pause")).toBe(true);
  expect(app.shows("id:toast")).toBe(true);
  expect(app.texts()).toContain("Couldn’t save");
  expect(app.texts()).toContain("Host rejected");
  expect(app.shows("id:toast >> label:Retry")).toBe(true);
  checkRoutineStable("label:Pause", pause0);

  await app.press("label:Mode: fail"); // switch to succeed mode
  await app.press("id:toast >> label:Retry");
  expect(app.shows("label:Resume")).toBe(true);
  checkRoutineStable("label:Resume", pause0);
  await app.clock!.runFor(350);
  checkRoutineStable("label:Resume", pause0);
  await app.press("label:Resolve");
  expect(app.shows("label:Resume")).toBe(true);
  checkRoutineStable("label:Resume", pause0);
});

test("archive restore hides row optimistically with zero layout shift, brings it back on failure, and retries via toast", async () => {
  const app = await openMode("archive");
  await app.waitFor("text:Archived cleanup");

  const oldChat0 = app.layout("text:Old chat")!;
  const checkArchiveStable = () => {
    expectNoInlineStatus(app);
    expect(app.layout("text:Old chat")!.y).toBe(oldChat0.y);
  };

  await app.press("label:Mode: succeed"); // fail mode
  await app.press("label:Restore");
  // Immediately hidden optimistically without shifting the section above/around.
  expect(app.texts()).not.toContain("Archived cleanup");
  checkArchiveStable();
  await app.clock!.runFor(350);
  checkArchiveStable();

  // Failure restores it and offers Retry via toast.
  await app.press("label:Reject");
  expect(app.texts()).toContain("Archived cleanup");
  expect(app.shows("id:toast")).toBe(true);
  expect(app.texts()).toContain("Couldn’t save");
  expect(app.texts()).toContain("Host rejected");
  expect(app.shows("id:toast >> label:Retry")).toBe(true);
  checkArchiveStable();

  await app.press("label:Mode: fail");
  await app.press("id:toast >> label:Retry");
  expect(app.texts()).not.toContain("Archived cleanup");
  checkArchiveStable();
  await app.clock!.runFor(350);
  checkArchiveStable();
  await app.press("label:Resolve");
  expect(app.texts()).not.toContain("Archived cleanup");
  checkArchiveStable();
});

test("model source toggle updates optimistically with zero layout shift, rolls back on failure, and retries via toast", async () => {
  const app = await openMode("models");
  await app.waitFor("text:Codex");
  expect(app.texts()).toContain("Working");

  const codex0 = app.layout("text:Codex")!;
  const checkModelsStable = () => {
    expectNoInlineStatus(app);
    expect(app.layout("text:Codex")!.y).toBe(codex0.y);
  };

  await app.press("label:Mode: succeed"); // fail mode
  await app.press("label:Work");
  await app.waitFor("label:Disable");
  await app.press("label:Disable");
  expect(app.texts()).toContain("Disabled");
  checkModelsStable();
  await app.clock!.runFor(350);
  checkModelsStable();

  await app.press("label:Reject");
  expect(app.texts()).toContain("Working");
  expect(app.texts()).not.toContain("Disabled");
  expect(app.shows("id:toast")).toBe(true);
  expect(app.texts()).toContain("Couldn’t save");
  expect(app.texts()).toContain("Host rejected");
  expect(app.shows("id:toast >> label:Retry")).toBe(true);
  checkModelsStable();

  await app.press("label:Mode: fail");
  await app.press("id:toast >> label:Retry");
  expect(app.texts()).toContain("Disabled");
  checkModelsStable();
  await app.clock!.runFor(350);
  checkModelsStable();
  await app.press("label:Resolve");
  expect(app.texts()).toContain("Disabled");
  checkModelsStable();
});

test("task inline rename and description edit update optimistically with zero layout shift, roll back on error, and retry via toast", async () => {
  const app = await openMode("task");
  await app.waitFor("text:Goal");

  const goal0 = app.layout("text:Goal")!;
  const checkTaskStable = () => {
    expectNoInlineStatus(app);
    expect(app.layout("text:Goal")!.y).toBe(goal0.y);
  };

  // Inline title rename.
  await app.press("label:Mode: succeed"); // fail mode
  await app.press("label:Rename task");
  expect(app.texts()).toContain("Updated title");
  checkTaskStable();
  await app.clock!.runFor(350);
  checkTaskStable();

  await app.press("label:Reject");
  expect(app.texts()).toContain("Initial title");
  expect(app.texts()).not.toContain("Updated title");
  expect(app.shows("id:toast")).toBe(true);
  expect(app.texts()).toContain("Couldn’t save");
  expect(app.texts()).toContain("Host rejected");
  expect(app.shows("id:toast >> label:Retry")).toBe(true);
  checkTaskStable();

  await app.press("label:Mode: fail");
  await app.press("id:toast >> label:Retry");
  expect(app.texts()).toContain("Updated title");
  checkTaskStable();
  await app.clock!.runFor(350);
  checkTaskStable();
  await app.press("label:Resolve");
  expect(app.texts()).toContain("Updated title");
  checkTaskStable();

  // Inline description edit.
  await app.press("label:Mode: succeed");
  await app.press("label:Save description");
  expect(app.texts()).toContain("Updated description");
  checkTaskStable();
  await app.clock!.runFor(350);
  checkTaskStable();

  await app.press("label:Reject");
  expect(app.texts()).toContain("Initial description");
  expect(app.texts()).not.toContain("Updated description");
  expect(app.shows("id:toast >> label:Retry")).toBe(true);
  checkTaskStable();

  await app.press("label:Mode: fail");
  await app.press("id:toast >> label:Retry");
  expect(app.texts()).toContain("Updated description");
  checkTaskStable();
  await app.clock!.runFor(350);
  checkTaskStable();
  await app.press("label:Resolve");
  expect(app.texts()).toContain("Updated description");
  checkTaskStable();
});

test("task comment posts optimistically with zero layout shift, rolls back on error, reuses idempotent clientId on toast retry, and clears composer", async () => {
  const app = await openMode("task-comment");
  await app.waitFor("label:Comment");

  const sendBefore = app.layout("label:Send comment")!;
  const checkCommentStable = () => {
    expectNoInlineStatus(app);
    const current = app.layout("label:Send comment")!;
    expect(current.y).toBe(sendBefore.y);
    expect(current.height).toBe(sendBefore.height);
  };

  await app.press("label:Mode: succeed"); // fail mode
  await app.type("label:Comment", "Ship it!");
  expect(app.enabled("label:Send comment")).toBe(true);
  await app.press("label:Send comment");

  expect(app.texts()).toContain("Activity count: 1");
  const firstCall = app.texts().find((t) => t.startsWith("Last call:"))!;
  checkCommentStable();
  await app.clock!.runFor(350);
  checkCommentStable();

  await app.press("label:Reject");
  expect(app.texts()).toContain("Activity count: 0");
  // Draft preserved when post fails.
  expect(app.enabled("label:Send comment")).toBe(true);
  expect(app.shows("id:toast")).toBe(true);
  expect(app.texts()).toContain("Couldn’t save");
  expect(app.texts()).toContain("Host rejected");
  expect(app.shows("id:toast >> label:Retry")).toBe(true);
  checkCommentStable();

  await app.press("label:Mode: fail"); // succeed mode
  await app.press("id:toast >> label:Retry");
  expect(app.texts()).toContain("Activity count: 1");
  const retryCall = app.texts().find((t) => t.startsWith("Last call:"))!;
  expect(retryCall).toBe(firstCall);
  checkCommentStable();
  await app.clock!.runFor(350);
  checkCommentStable();

  await app.press("label:Resolve");
  // Composer cleared once the retry succeeds.
  expect(app.enabled("label:Send comment")).toBe(false);
  checkCommentStable();
});
