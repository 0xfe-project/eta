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

    // Opened, the fold holds the process without the answer.
    await app.press("label:Thinking process");
    expect(app.shows(note)).toBe(true);
    expect(app.count(`text:${answer}`)).toBe(1);
    await app.press("label:Thinking process");

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
  await app.press("Finish");
  await app.press("label:Thinking process");
  expect(app.shows("— Received your insert —")).toBe(true);
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
