import { expect, open, test } from "nsh/test";

const fixture = "./fixtures/new-task-scope.tsx";

const created = (app: Awaited<ReturnType<typeof open>>) =>
  app.texts().find((text) => text.startsWith("Calls: tasks.create")) ?? "";

test("picking a group narrows executor choices to its members and updates default", async () => {
  const app = await open(fixture, {
    platform: "macos",
    width: 1280,
    height: 800,
    locale: "en-US",
  });
  await app.waitFor("label:Executor >> text:Ada");

  await app.press("label:In");
  await app.waitFor("label:Design");
  await app.press("label:Design");

  await app.waitFor("label:Executor >> text:Lin");
  await app.press("label:Executor");
  await app.waitFor("label:Lin");
  expect(app.shows("label:Ada")).toBe(false);
  await app.press("label:Lin");

  await app.type("label:Title", "Review color tokens");
  await app.press("label:Create");
  await app.waitUntil(() => created(app) !== "");
  const args = JSON.parse(created(app).slice("Calls: tasks.create ".length));
  expect(args.conversationId).toBe("grp-lin");
  expect(args.tasks[0].assignee).toBe("lin");
});

test("picking a parent task narrows executor choices to its group members and updates default", async () => {
  const app = await open(fixture, {
    platform: "macos",
    width: 1280,
    height: 800,
    locale: "en-US",
  });
  await app.waitFor("label:Executor >> text:Ada");

  await app.press("label:Belongs to");
  await app.waitFor("text:#7 Design pass");
  await app.press("text:#7 Design pass");

  await app.waitFor("label:Executor >> text:Lin");
  await app.press("label:Executor");
  await app.waitFor("label:Lin");
  expect(app.shows("label:Ada")).toBe(false);
  await app.press("label:Lin");

  await app.type("label:Title", "Subtask for design");
  await app.press("label:Create");
  await app.waitUntil(() => created(app) !== "");
  const args = JSON.parse(created(app).slice("Calls: tasks.create ".length));
  expect(args.parent).toBe("parent-1");
  expect(args.tasks[0].assignee).toBe("lin");
});
