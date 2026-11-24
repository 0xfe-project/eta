import { expect, open, test } from "nsh/test";

// What a task's token usage reads as: nothing on cards and rows until the View menu's "Show token
// usage" is on; then the total and main model, "with subtasks" on a parent, "No token data" (never
// 0) for a task that ran without any, and nothing for one that never ran. A subtask is folded under
// its parent in the Tasks tab, so its own usage is in the parent's "with subtasks" total, not on a
// row of its own. The task page's Usage section is there either way, with its runs and the one
// that reported nothing.
const fixture = "./fixtures/task-usage.tsx";

async function openWith(storage: Record<string, string> = {}) {
  const app = await open(fixture, {
    width: 1440,
    height: 1400,
    locale: "en-US",
    platform: "web",
    storage,
  });
  await app.waitFor("text:Release v1.0");
  return app;
}

test("off by default: rows say no usage, the task page still does", async () => {
  const app = await openWith();
  const texts = app.texts();
  expect(texts).not.toContain("2.4M tok · gpt-5.1-codex +1");
  expect(texts).not.toContain("4.8M tok · with subtasks");
  // The Usage section: total, the runs line, and the run with nothing reported.
  expect(texts).toContain("Usage");
  expect(texts).toContain("4 runs · 1 without token data");
  expect(texts).toContain("2.4M");
  expect(texts).toContain("No token data");
  expect(texts).not.toContain("0 tok");
});

test("on from the View menu: totals, the main model, with subtasks, and no data", async () => {
  const app = await openWith();
  await app.press("label:View");
  await app.press("label:Show token usage");
  await app.waitFor("text:4.8M tok · with subtasks");
  const texts = app.texts();
  expect(texts).toContain("No token data");
  expect(texts.filter((text) => text.includes("tok")).join("|")).not.toContain(
    "0 tok",
  );
});

test("the setting is kept: on from storage, the rows say their usage", async () => {
  const app = await openWith({ "eta.tasks.usage": "true" });
  await app.waitFor("text:4.8M tok · with subtasks");
  expect(app.texts()).toContain("No token data");
});
