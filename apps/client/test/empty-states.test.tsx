import { expect, open, test } from "nsh/test";
import { motion } from "../src/components/motion";

// One region in its three states (#378): never "No tasks yet" while the list is on its way or did
// not come; what a search found nothing for keeps the search.
const tasksPage = () =>
  open("./fixtures/empty-states.tsx", { width: 1280, height: 800 });

test("while the list is on its way it is loading, not empty", async () => {
  const app = await tasksPage();
  // The skeleton, once its wait has lasted (#380).
  await app.wait(motion.reveal * 2 + 50);
  expect(app.shows("label:Loading tasks…")).toBe(true);
  expect(app.shows("No tasks yet")).toBe(false);
  expect(app.shows("Tasks didn't load")).toBe(false);
});

test("a list that did not load says so with Retry, and Retry asks again", async () => {
  const app = await tasksPage();
  await app.press("Fail");
  await app.waitFor("text:Tasks didn't load");
  expect(app.shows("No tasks yet")).toBe(false);
  expect(app.shows("label:Loading tasks…")).toBe(false);
  await app.press("label:Retry");
  expect(app.shows("Retries 1")).toBe(true);
  // What came after the retry takes the failure's place.
  await app.press("Load two");
  await app.waitFor("text:Fix the footer");
  expect(app.shows("Tasks didn't load")).toBe(false);
});

test("an empty list says what comes here, with one way to start", async () => {
  const app = await tasksPage();
  await app.press("Load none");
  await app.waitFor("text:No tasks yet");
  expect(app.shows("label:New task")).toBe(true);
  expect(app.shows("label:Retry")).toBe(false);
});

test("a search that found nothing names it, keeps it, and clearing it brings the list back", async () => {
  const app = await tasksPage();
  await app.press("Load two");
  await app.waitFor("text:Fix the footer");
  await app.type("label:Search tasks", "zzqx");
  expect(app.shows("No tasks match “zzqx”")).toBe(true);
  expect(app.shows("No tasks yet")).toBe(false);
  expect(app.value("label:Search tasks")).toBe("zzqx");
  await app.press("text:Clear search");
  expect(app.shows("Fix the footer")).toBe(true);
  expect(app.value("label:Search tasks")).toBe("");
});
