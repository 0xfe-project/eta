import type { App } from "nsh/test";
import { expect, open, test } from "nsh/test";

/** A caption is drawn in capitals (on a phone after a dot): the words at its end, whatever their case. */
const reads = (app: App, words: string) =>
  app
    .texts()
    .some(
      (text) => text.toLowerCase().replace(/^· /, "") === words.toLowerCase(),
    );

const note = "I'll check config.json first.";
const answer = "The baseUrl is missing /v1.";

for (const width of [1440, 390]) {
  test(`a reply at work is all in its window, and its answer comes out at the end (${width}px)`, async () => {
    const app = await open("./fixtures/live-reply.tsx", { width, height: 900 });
    // At work: one window with every block in order and nothing outside it.
    expect(app.shows("id:process-window")).toBe(true);
    expect(app.shows("Process · 4 steps")).toBe(true);
    expect(app.enabled("Stop")).toBe(true);
    expect(app.count("label:Note")).toBe(2);
    expect(app.shows(note)).toBe(true);
    expect(app.shows(answer)).toBe(true);
    expect(app.shows("label:Thinking")).toBe(true);
    // A thought starts folded; its words open on a press.
    expect(app.shows("Look at the provider config.")).toBe(false);
    expect(app.shows("id:reply-answer")).toBe(false);
    expect(app.shows("label:Thinking process")).toBe(false);

    await app.press("Finish");
    // Over: the window folds to one row, and the last words come out under it.
    expect(app.shows("id:process-window")).toBe(false);
    expect(app.shows("label:Thinking process")).toBe(true);
    expect(reads(app, "3 steps")).toBe(true);
    expect(app.shows("id:reply-answer")).toBe(true);
    expect(app.shows(answer)).toBe(true);
    expect(app.shows(note)).toBe(false);
    const finished = app.texts();

    // Afresh from the saved row, it reads the same.
    await app.press("Reload");
    expect(app.texts()).toEqual(finished);
  });
}

test("an insert leaves a trace in the window", async () => {
  const app = await open("./fixtures/live-reply.tsx", {
    width: 1440,
    height: 900,
  });
  expect(app.shows("— Received your insert —")).toBe(true);
  expect(app.shows("Also check the key.")).toBe(false);
});

test("a reply without tools is written in the window and comes out whole", async () => {
  const app = await open("./fixtures/live-reply.tsx", {
    width: 1440,
    height: 900,
  });
  await app.press("Write without tools");
  expect(app.shows("id:process-window")).toBe(true);
  expect(app.shows("Process · 1 step")).toBe(true);
  expect(app.shows("Nothing to look up: the answer is 42.")).toBe(true);
  expect(app.shows("id:reply-answer")).toBe(false);
  await app.press("Finish");
  expect(app.shows("id:process-window")).toBe(false);
  expect(app.shows("label:Thinking process")).toBe(false);
  expect(app.shows("id:reply-answer")).toBe(true);
  expect(app.shows("Nothing to look up: the answer is 42.")).toBe(true);
});

for (const [ending, status] of [
  ["End stopped", "Stopped"],
  ["End failed", "Provider said 500."],
] as const)
  test(`a reply that ends on a call says how it ended, and takes no words for an answer (${ending})`, async () => {
    const app = await open("./fixtures/live-reply.tsx", {
      width: 1440,
      height: 900,
    });
    await app.press(ending);
    expect(app.shows("id:process-window")).toBe(false);
    expect(app.shows("label:Thinking process")).toBe(true);
    expect(reads(app, "3 steps")).toBe(true);
    expect(app.texts().some((text) => text.includes(status))).toBe(true);
    expect(app.shows("id:reply-answer")).toBe(false);
    expect(app.shows(note)).toBe(false);
  });

/** The run panel a task's "View process" opens, here opened from a reply. */
const panel = "label:Ada process";

for (const [width, height] of [
  [1440, 900],
  [1024, 768],
  [390, 844],
] as const) {
  test(`"View more" opens the reply's run in the run panel, live, not in place (${width}px)`, async () => {
    const app = await open("./fixtures/live-reply.tsx", { width, height });
    expect(app.shows(panel)).toBe(false);
    await app.press("Write more");
    await app.press("label:View more");
    expect(app.shows(panel)).toBe(true);
    // The window under it is as it was: nothing opened in place.
    expect(app.shows("Process · 4 steps")).toBe(true);
    // The panel's timing strip and the whole process.
    expect(app.shows("label:Generation")).toBe(true);
    expect(app.count(`text:${note}`)).toBe(2);
    expect(app.texts().some((text) => text.includes("config.json"))).toBe(true);
    // What the run writes next comes into the open panel.
    expect(app.shows("Checking the key next.")).toBe(false);
    await app.waitUntil(() => app.count("text:Checking the key next.") === 2);
  });

  test(`a finished reply, and one drawn from its saved row, open the same panel (${width}px)`, async () => {
    const app = await open("./fixtures/live-reply.tsx", { width, height });
    await app.press("Finish");
    await app.press("label:Thinking process");
    expect(app.shows(panel)).toBe(true);
    // Its process and its answer, timed from the session.
    expect(app.shows("label:Generation")).toBe(true);
    expect(app.shows(note)).toBe(true);
    expect(app.count(`text:${answer}`)).toBe(2);
    // A run's next briefing is not this reply's.
    expect(app.shows("Checking the key next.")).toBe(false);

    await app.press(width < 600 ? "label:Back" : "label:Close");
    expect(app.shows(panel)).toBe(false);
    await app.press("Reload");
    await app.press("label:Thinking process");
    expect(app.shows(panel)).toBe(true);
    // No session in view: what the row kept, without a timing strip.
    expect(app.shows("label:Generation")).toBe(false);
    expect(app.shows(note)).toBe(true);
    expect(app.count(`text:${answer}`)).toBe(2);
  });
}

test("an insert leaves a trace in the window, and is not lost in the panel", async () => {
  const app = await open("./fixtures/live-reply.tsx", {
    width: 1440,
    height: 900,
  });
  await app.press("label:View more");
  // The run panel draws what the user inserted as it was written.
  expect(app.shows("Also check the key.")).toBe(true);
});
