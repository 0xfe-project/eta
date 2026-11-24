import { expect, open, test } from "nsh/test";

const fixture = "./fixtures/task-live-runs.tsx";

const sizes = [
  ["desktop", 1440, 900],
  ["tablet", 1024, 768],
  ["phone", 390, 844],
] as const;

const has = (texts: string[], text: string) =>
  texts.some((entry) => entry.includes(text));

for (const [name, width, height] of sizes) {
  test(`the executor working and a mentioned agent answering show a line each (${name})`, async () => {
    const app = await open(fixture, { width, height, locale: "en-US" });
    await app.waitUntil(() => has(app.texts(), "Bo is answering"));
    expect(has(app.texts(), "Ada is working")).toBe(true);
    expect(has(app.texts(), "Bo is answering (mentioned)")).toBe(true);
  });

  test(`a mentioned agent's line opens its own session's log (${name})`, async () => {
    const app = await open(fixture, { width, height, locale: "en-US" });
    await app.waitUntil(() => has(app.texts(), "Bo is answering"));
    await app.press("label:Execution log · Bo");
    await app.waitUntil(() => app.shows("Bo looks the question up."));
    expect(app.shows("Ada reads the footer.")).toBe(false);
    // Its title says whose run it is: Bo's, not the executor's.
    expect(
      app.texts().includes("Bo") || has(app.texts(), "Bo (mentioned)"),
    ).toBe(true);
    expect(has(app.texts(), "steer Ada")).toBe(false);
  });

  test(`only a mentioned agent answering is not the task running (${name})`, async () => {
    const app = await open(fixture, { width, height, locale: "en-US" });
    await app.press("Only Bo");
    await app.waitUntil(() => !has(app.texts(), "Ada is working"));
    expect(has(app.texts(), "Bo is answering (mentioned)")).toBe(true);
    // The task's own run state is its executor's: delivered, not running.
    expect(app.texts()).not.toContain("Running");
    expect(has(app.texts(), "In progress")).toBe(false);
  });
}

test("the chat's task panel shows each run and opens the one pressed", async () => {
  const app = await open(fixture, {
    width: 1440,
    height: 900,
    locale: "en-US",
  });
  await app.press("Side panel");
  await app.waitUntil(() => has(app.texts(), "Bo is answering"));
  expect(has(app.texts(), "Ada is working")).toBe(true);
  await app.press("label:Execution log · Bo");
  await app.waitUntil(() => app.shows("Bo looks the question up."));
  expect(app.shows("Ada reads the footer.")).toBe(false);
});
