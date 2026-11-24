import { expect, open, test } from "nsh/test";

// The strip above a conversation's transcript points at a question waiting for the user only while
// the question is off screen; pressing it goes to the question (for a task's question, to the
// task's card; with nowhere to go, to the question's dialog). How the strip and the card look is
// shown in the PR with a real browser.
const fixture = "./fixtures/question-strip.tsx";
const strip = "label:Jump to question";

const openAt = (scenario: string) =>
  open(fixture, {
    width: 1440,
    height: 900,
    locale: "en-US",
    platform: "web",
    urlScheme: `eta://fixture/${scenario}`,
  });

test("a question on screen has no strip above the transcript", async () => {
  const app = await openAt("end");
  await app.waitFor("text:Ship rc.9 today?");
  await app.wait(200);
  expect(app.shows(strip)).toBe(false);
});

test("the strip shows once the question scrolls off screen, and goes when it is back", async () => {
  const app = await openAt("end");
  await app.waitFor("text:Ship rc.9 today?");
  await app.scroll("id:conversation-messages", -2500);
  await app.waitFor(strip);
  expect(
    app.shows("text:Ada is waiting for your answer: Ship rc.9 today?"),
  ).toBe(true);
  await app.scroll("id:conversation-messages", 5000);
  await app.waitUntil(() => !app.shows(strip));
});

test("pressing the strip scrolls to the question and the strip goes", async () => {
  const app = await openAt("early");
  await app.waitFor(strip);
  expect(app.shows("text:Reply number 4.")).toBe(false);
  await app.press(strip);
  await app.waitFor("text:Reply number 4.");
  expect(app.shows("id:question-q-early")).toBe(true);
  await app.waitUntil(() => !app.shows(strip));
});

test("a question on a reply not loaded yet loads the older page, then goes to it", async () => {
  const app = await openAt("older");
  await app.waitFor(strip);
  await app.press(strip);
  await app.waitFor("text:Reply number 4.");
  expect(app.shows("text:Keep the old installer?")).toBe(true);
  await app.waitUntil(() => !app.shows(strip));
});

test("a question a task's run asked opens the task, whose card answers it", async () => {
  const app = await openAt("task");
  await app.waitFor(strip);
  expect(
    app.shows(
      "text:Ada is waiting for your answer: Which branch should I cut?",
    ),
  ).toBe(true);
  await app.press(strip);
  await app.waitFor("text:Opened task t-cut");
  await app.waitFor("id:question-q-task");
  await app.press("label:Yes");
  await app.waitFor("text:Answered q-task");
  await app.waitUntil(() => !app.shows(strip));
});

test("a question with nowhere to go opens its dialog, which answers it", async () => {
  const app = await openAt("lost");
  await app.waitFor(strip);
  await app.press(strip);
  await app.waitFor("text:Send answer");
  expect(app.shows("text:No task opened")).toBe(true);
  await app.press("label:No");
  await app.press("text:Send answer");
  await app.waitFor("text:Answered q-task");
});

test("with several questions the strip shows the oldest one off screen and how many more wait", async () => {
  const app = await openAt("many");
  await app.waitFor(strip);
  expect(
    app.shows("text:Ada is waiting for your answer: Bring the IME fix along?"),
  ).toBe(true);
  expect(app.shows("text:2 more")).toBe(true);
  await app.press(strip);
  await app.waitFor("id:question-q-early");
});
