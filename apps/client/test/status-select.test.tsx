import { expect, open, test } from "nsh/test";

// The task panel and the task page change a task's status with one component: the trigger opens
// "Change status", the seven with a hint under each, and a choice goes to the host.
const fixture = "./fixtures/status-select.tsx";
const trigger = "label:Change status";

const surfaces = [
  ["panel", 1440],
  ["panel", 1024],
  ["page", 1440],
  ["page", 1024],
] as const;

async function openOn(surface: string, width: number) {
  const app = await open(fixture, {
    width,
    height: 900,
    locale: "en-US",
    platform: "web",
    storage: { surface },
    clock: {},
  });
  await app.waitFor(trigger);
  return app;
}

for (const [surface, width] of surfaces) {
  test(`${surface} at ${width}px: a choice is sent, the trigger waits for the host, then shows it`, async () => {
    const app = await openOn(surface, width);
    expect(app.texts()).toContain("In progress");
    const before = app.layout(trigger)!;
    expect(before).not.toBeNull();
    const beforeExecutor =
      surface === "page" && width === 1440 ? app.layout("text:Executor") : null;
    const beforeDescription =
      surface === "page" && width === 1024
        ? app.layout("text:Add POST /api/login.")
        : null;
    const checkStable = () => {
      const current = app.layout(trigger)!;
      expect(current.y).toBe(before.y);
      expect(current.height).toBe(before.height);
      expect(app.shows("id:optimistic-status")).toBe(false);
      expect(app.texts()).not.toContain("Saving…");
      expect(app.texts()).not.toContain("Saved");
      if (beforeExecutor) {
        expect(app.layout("text:Executor")?.y).toBe(beforeExecutor.y);
      }
      if (beforeDescription) {
        expect(app.layout("text:Add POST /api/login.")?.y).toBe(
          beforeDescription.y,
        );
      }
    };

    await app.press(trigger);
    // The detail page's menu: its caption, every status with what it does.
    expect(app.texts()).toContain("CHANGE STATUS");
    expect(app.texts()).toContain("Parked; it won't start");
    expect(app.texts()).toContain(
      "Dropped; the 1 task waiting for it becomes blocked",
    );
    await app.press("label:In review");
    expect(app.texts()).toContain("Sent: tasks.update in_review");

    // On its way: the menu closes (it goes out first) and the trigger takes no presses until
    // the host answers.
    await app.waitUntil(() => !app.texts().includes("Parked; it won't start"));
    expect(app.enabled(trigger)).toBe(false);
    expect(app.texts()).toContain("In review");
    checkStable();
    await app.clock!.runFor(350);
    checkStable();

    await app.press("text:Answer");
    await app.waitUntil(() => app.enabled(trigger));
    expect(app.texts()).toContain("In review");
    checkStable();
  });

  test(`${surface} at ${width}px: a change the host refuses says why and keeps the status`, async () => {
    const app = await openOn(surface, width);
    await app.press(trigger);
    await app.press("label:Blocked");
    await app.press("text:Fail");
    await app.waitFor("text:Status not changed: the host is busy");
    expect(app.shows("label:Retry")).toBe(true);
    expect(app.enabled(trigger)).toBe(true);
    expect(app.texts()).toContain("In progress");

    // Opening the menu again clears it; the same status again sends nothing.
    await app.press(trigger);
    expect(app.texts()).not.toContain("Status not changed: the host is busy");
    await app.press("label:In progress");
    expect(app.texts()).toContain("Sent: tasks.update blocked");
    expect(app.texts()).not.toContain(
      "Sent: tasks.update blocked, tasks.update in_progress",
    );

    await app.press(trigger);
    await app.press("label:Blocked");
    await app.press("text:Fail");
    await app.waitFor("text:Status not changed: the host is busy");
    await app.press("label:Retry");
    expect(app.enabled(trigger)).toBe(false);
    expect(app.texts()).toContain("Blocked");
    await app.press("text:Answer");
    await app.waitUntil(() => app.enabled(trigger));
    expect(app.texts()).toContain("Blocked");
    expect(app.shows("id:optimistic-status")).toBe(false);
  });

  test(`${surface} at ${width}px: the keyboard moves through the menu and chooses`, async () => {
    const app = await openOn(surface, width);
    await app.press(trigger);
    // Down focuses Backlog, then To do, In progress, In review; Return chooses it.
    for (let step = 0; step < 4; step++) await app.keyboard.press("down");
    await app.keyboard.press("enter");
    expect(app.texts()).toContain("Sent: tasks.update in_review");
    await app.press("text:Answer");
    await app.waitUntil(() => app.texts().includes("In review"));

    // Escape closes it with nothing chosen.
    await app.press(trigger);
    expect(app.texts()).toContain("Parked; it won't start");
    await app.keyboard.press("escape");
    await app.waitUntil(() => !app.texts().includes("Parked; it won't start"));
    expect(app.texts()).toContain("Sent: tasks.update in_review");
  });
}

test("panel at 390px: the status opens the phone's sheet, the same seven, and a choice is sent", async () => {
  const app = await openOn("panel", 390);
  const actionsSelector = "label:Task actions";
  const before = app.layout(trigger)!;
  const beforeActions = app.layout(actionsSelector)!;
  expect(before).not.toBeNull();
  expect(beforeActions).not.toBeNull();
  const beforeOffset = before.y - beforeActions.y;
  await app.press(trigger);
  // The task page's phone sheet, titled, not a second menu over it.
  expect(app.texts().filter((text) => text === "Change status")).toHaveLength(
    1,
  );
  expect(app.texts()).not.toContain("CHANGE STATUS");
  expect(app.texts()).toContain("Parked; it won't start");
  await app.press("label:Blocked");
  expect(app.texts()).toContain("Sent: tasks.update blocked");
  // The sheet is titled "Change status" too: the trigger is the first.
  expect(app.enabled(`${trigger} >> nth=0`)).toBe(false);
  await app.press("text:Fail");
  await app.waitUntil(() =>
    app.texts().includes("Status not changed: the host is busy"),
  );
  expect(app.enabled(`${trigger} >> nth=0`)).toBe(true);
  // The sheet closed as the change was made; the refused change put the old status back.
  expect(app.texts()).toContain("In progress");

  const checkPhoneStable = () => {
    const current = app.layout(trigger)!;
    const currentActions = app.layout(actionsSelector)!;
    // Measure offset within TaskTopBar because the fixture's "Sent:" line wraps at 390px.
    expect(current.y - currentActions.y).toBe(beforeOffset);
    expect(current.height).toBe(before.height);
    expect(app.shows("id:optimistic-status")).toBe(false);
    expect(app.texts()).not.toContain("Saving…");
    expect(app.texts()).not.toContain("Saved");
  };
  await app.press(trigger);
  await app.press("label:In review");
  await app.waitUntil(() => !app.texts().includes("Parked; it won't start"));
  expect(app.enabled(trigger)).toBe(false);
  expect(app.texts()).toContain("In review");
  checkPhoneStable();
  await app.clock!.runFor(350);
  checkPhoneStable();
  await app.press("text:Answer");
  await app.waitUntil(() => app.enabled(trigger));
  expect(app.texts()).toContain("In review");
  checkPhoneStable();
});
