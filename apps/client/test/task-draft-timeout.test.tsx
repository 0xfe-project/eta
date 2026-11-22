import { expect, open, test } from "nsh/test";

// Settings > Tasks > Task drafts: a draft nobody answers is accepted or discarded by the host after
// a number of minutes. Off, 10 minutes and discard until the user says otherwise; a change goes to
// the host at once and a number outside 1 to 1440 is refused before it is sent.
const fixture = "./fixtures/task-draft-timeout.tsx";
const enable = "label:Handle unanswered drafts automatically";
const minutes = "label:Wait before handling";
const action = "label:When time is up";

async function openIt(locale = "en-US", ready = enable) {
  const app = await open(fixture, {
    width: 1024,
    height: 900,
    locale,
    platform: "web",
  });
  await app.waitFor(ready);
  return app;
}

test("shows the three settings with their defaults, and sends nothing yet", async () => {
  const app = await openIt();
  expect(app.texts()).toContain("Task drafts");
  expect(app.value(minutes)).toBe("10");
  expect(app.texts()).toContain("Discard the draft");
  expect(app.texts().some((text) => text.includes("tasks.setSettings"))).toBe(
    false,
  );
});

test("the switch is sent alone and the host's answer is shown", async () => {
  const app = await openIt();
  await app.press(enable);
  await app.waitFor(
    'text:Sent: tasks.setSettings {"draftTimeout":{"enabled":true}}',
  );
});

test("a whole number of minutes in range is sent, anything else is refused with the range", async () => {
  const app = await openIt();
  await app.clear(minutes);
  await app.type(minutes, "45");
  await app.keyboard.press("enter");
  await app.waitFor(
    'text:Sent: tasks.setSettings {"draftTimeout":{"minutes":45}}',
  );

  for (const bad of ["0", "1441", "2.5", "abc"]) {
    await app.clear(minutes);
    await app.type(minutes, bad);
    await app.keyboard.press("enter");
    await app.waitFor("text:Enter a whole number of minutes from 1 to 1440.");
  }
  // Nothing but the one good change went out, and the field shows what the host kept.
  expect(app.texts()).toContain(
    'Sent: tasks.setSettings {"draftTimeout":{"minutes":45}}',
  );
  expect(app.value(minutes)).toBe("45");
});

test("the action is chosen from the menu and sent alone; the hint says accepting starts the task", async () => {
  const app = await openIt();
  expect(app.texts().join(" ")).toContain("starts it at once");
  await app.press(action);
  await app.press("label:Accept the draft");
  await app.waitFor(
    'text:Sent: tasks.setSettings {"draftTimeout":{"action":"accept"}}',
  );
});

test("is in Chinese too", async () => {
  const app = await openIt("zh-CN", "label:自动处理超时未答复的草稿");
  expect(app.texts()).toContain("任务草稿");
  expect(app.texts()).toContain("丢弃草稿");
});
