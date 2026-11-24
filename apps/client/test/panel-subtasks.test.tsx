import { expect, open, test } from "nsh/test";

// Subtasks in the chat's task lists: folded under their parent until it is opened, and placed
// where the parent is, never on their own (fixtures/panel-subtasks.tsx).
const subtasks = ["Design the screens", "Build the screens", "Test on phones"];

const show = (surface: string, width = 1440, height = 900) =>
  open("./fixtures/panel-subtasks.tsx", {
    width,
    height,
    locale: "en-US",
    storage: { surface },
  });

const absent = (texts: string[], titles: string[]) => {
  for (const title of titles) expect(texts).not.toContain(title);
};

test("Tasks tab: subtasks stay folded and their parent sits in its own group", async () => {
  const app = await show("tasks");
  await app.waitFor("text:Ship the onboarding");
  const texts = app.texts();
  absent(texts, [...subtasks, "Test on Android"]);
  // #3 is in review, but it is #1's: Needs you holds only #7, and #1 is Going.
  expect(texts).toContain("Needs you 1");
  expect(texts).toContain("Going 2");
  expect(texts).toContain("Waiting 1");
  expect(texts).toContain("1/3");
  // Folded, the parent says what in it waits on you.
  expect(texts).toContain("1 needs you");
});

test("Tasks tab: opening a parent shows each subtask with its status", async () => {
  const app = await show("tasks");
  await app.waitFor("text:Ship the onboarding");
  await app.press("label:Show subtasks of Ship the onboarding");
  const texts = app.texts();
  for (const title of subtasks) expect(texts).toContain(title);
  expect(texts).toContain("Completed");
  expect(texts).toContain("In review");
  expect(texts).not.toContain("1 needs you");
  // A subtask with subtasks of its own is folded too, until it is opened.
  expect(texts).not.toContain("Test on Android");
  await app.press("label:Show subtasks of Test on phones");
  expect(app.texts()).toContain("Test on Android");

  await app.press("label:Hide subtasks of Ship the onboarding");
  absent(app.texts(), subtasks);
});

test("Tasks tab: a subtask listed without its parent brings the parent, open", async () => {
  const app = await show("tasks");
  await app.waitFor("text:Move CI to new runners");
  expect(app.texts()).toContain("Port the test jobs");
});

test("Recently updated: a parent is placed by its newest subtask", async () => {
  const app = await show("tasks");
  await app.waitFor("text:Ship the onboarding");
  await app.press("label:Sort tasks");
  await app.press("label:Recently updated");
  const order = app
    .texts()
    .filter((text) =>
      [
        "Ship the onboarding",
        "Update the favicon",
        "Write the release notes",
      ].includes(text),
    );
  // #1 itself last moved 5 hours ago, its #3 five minutes ago.
  expect(order).toEqual([
    "Ship the onboarding",
    "Update the favicon",
    "Write the release notes",
  ]);
  expect(app.texts()).toContain("5 minutes ago");
});

test("Context tab: one row per parent, its subtasks and their statuses when opened", async () => {
  const app = await show("context");
  await app.waitFor("text:Ship the onboarding");
  absent(app.texts(), subtasks);
  expect(app.texts()).toContain("1/3");
  await app.press("label:Show subtasks of Ship the onboarding");
  const texts = app.texts();
  for (const title of subtasks) expect(texts).toContain(title);
  expect(texts).toContain("Completed");
  expect(texts).toContain("In review");
});

test("phone info sheet: subtasks fold under their parent", async () => {
  const app = await show("phone", 390, 844);
  await app.waitFor("text:#1 Ship the onboarding");
  absent(
    app.texts(),
    subtasks.map((title, index) => `#${index + 2} ${title}`),
  );
  await app.press("label:Show subtasks of Ship the onboarding");
  const texts = app.texts();
  expect(texts).toContain("#3 Build the screens");
  expect(texts).toContain("In review");
});
