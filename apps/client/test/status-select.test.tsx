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
  });
  await app.waitFor(trigger);
  return app;
}

for (const [surface, width] of surfaces) {
  test(`${surface} at ${width}px: a choice is sent, the trigger waits for the host, then shows it`, async () => {
    const app = await openOn(surface, width);
    expect(app.texts()).toContain("In progress");

    await app.press(trigger);
    // The detail page's menu: its caption, every status with what it does.
    expect(app.texts()).toContain("CHANGE STATUS");
    expect(app.texts()).toContain("Parked; it won't start");
    expect(app.texts()).toContain(
      "Dropped; the 1 task waiting for it becomes blocked",
    );
    await app.press("label:In review");
    expect(app.texts()).toContain("Sent: tasks.update in_review");

    // On its way: the menu is closed and the trigger takes no presses until the host answers.
    expect(app.texts()).not.toContain("Parked; it won't start");
    expect(app.enabled(trigger)).toBe(false);

    await app.press("text:Answer");
    await app.waitUntil(() => app.enabled(trigger));
    expect(app.texts()).toContain("In review");
  });

  test(`${surface} at ${width}px: a change the host refuses says why and keeps the status`, async () => {
    const app = await openOn(surface, width);
    await app.press(trigger);
    await app.press("label:Blocked");
    await app.press("text:Fail");
    await app.waitFor("text:Status not changed: the host is busy");
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
    expect(app.texts()).not.toContain("Parked; it won't start");
    expect(app.texts()).toContain("Sent: tasks.update in_review");
  });
}

test("panel at 390px: the status opens the phone's sheet, the same seven, and a choice is sent", async () => {
  const app = await openOn("panel", 390);
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

  await app.press(trigger);
  await app.press("label:In review");
  await app.press("text:Answer");
  await app.waitUntil(() => !app.texts().includes("Parked; it won't start"));
  expect(app.texts()).toContain("In review");
});
