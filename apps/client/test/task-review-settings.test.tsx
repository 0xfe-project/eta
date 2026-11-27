import { expect, open, test } from "nsh/test";

const fixture = "./fixtures/task-review-settings.tsx";
const reactToggle = "label:Review finished tasks";
const maxRounds = "label:Max automatic revision rounds";

async function openIt(locale = "en-US", ready = reactToggle) {
  const app = await open(fixture, {
    width: 1024,
    height: 900,
    locale,
    platform: "web",
  });
  await app.waitFor(ready);
  return app;
}

test("shows default 3 rounds and updated review hint without sending anything", async () => {
  const app = await openIt();
  expect(app.value(maxRounds)).toBe("3");
  expect(app.texts()).toContain("rounds");
  const joined = app.texts().join(" ");
  expect(joined).toContain("0 to 10");
  expect(joined).toContain("0 reviews and reports only");
  expect(joined).toContain("request rework up to the limit");
  expect(app.texts().some((text) => text.includes("tasks.setSettings"))).toBe(
    false,
  );
});

test("submits valid integer rounds on Enter and Blur, and skips unchanged values", async () => {
  const app = await openIt();
  await app.clear(maxRounds);
  await app.type(maxRounds, "10");
  await app.keyboard.press("enter");
  await app.waitFor('text:Sent: tasks.setSettings {"reviewMaxRounds":10}');
  expect(app.value(maxRounds)).toBe("10");

  // Submitting the same value again does not emit another request.
  await app.clear(maxRounds);
  await app.type(maxRounds, "10");
  await app.keyboard.press("enter");
  expect(app.texts()).toContain(
    'Sent: tasks.setSettings {"reviewMaxRounds":10}',
  );

  // Blurring the field (via Tab) commits 0 as well.
  await app.clear(maxRounds);
  await app.type(maxRounds, "0");
  await app.keyboard.press("tab");
  await app.waitFor(
    'text:Sent: tasks.setSettings {"reviewMaxRounds":10} | tasks.setSettings {"reviewMaxRounds":0}',
  );
  expect(app.value(maxRounds)).toBe("0");

  // Toggling Review finished tasks sends reactToResults.
  await app.press(reactToggle);
  await app.waitFor(
    'text:Sent: tasks.setSettings {"reviewMaxRounds":10} | tasks.setSettings {"reviewMaxRounds":0} | tasks.setSettings {"reactToResults":true}',
  );
});

test("rejects out-of-range or non-integer rounds with a red error and sends nothing", async () => {
  const app = await openIt();
  for (const bad of ["-1", "11", "2.5", "abc"]) {
    await app.clear(maxRounds);
    await app.type(maxRounds, bad);
    await app.keyboard.press("enter");
    await app.waitFor("text:Enter a whole number of rounds from 0 to 10.");
  }
  expect(app.texts().some((text) => text.includes("tasks.setSettings"))).toBe(
    false,
  );
  expect(app.value(maxRounds)).toBe("3");
});

test("falls back to default 3 rounds when host omits reviewMaxRounds", async () => {
  const app = await openIt();
  await app.clear(maxRounds);
  await app.type(maxRounds, "7");
  await app.keyboard.press("enter");
  await app.waitFor('text:Sent: tasks.setSettings {"reviewMaxRounds":7}');
  expect(app.value(maxRounds)).toBe("7");

  await app.press("label:Simulate legacy host");
  await app.waitFor("text:Mode: legacy");
  expect(app.value(maxRounds)).toBe("3");
});

test("is localized in Chinese", async () => {
  const app = await openIt("zh-CN", "label:自动打回最大轮次");
  expect(app.texts()).toContain("轮");
  expect(app.texts().join(" ")).toContain("设为 0 表示仅评审汇报、不自动打回");
  await app.clear("label:自动打回最大轮次");
  await app.type("label:自动打回最大轮次", "11");
  await app.keyboard.press("enter");
  await app.waitFor("text:请输入 0 到 10 之间的整数轮次。");
});
