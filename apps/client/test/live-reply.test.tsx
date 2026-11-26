import type { App } from "nsh/test";
import { expect, open, test } from "nsh/test";
import { palette } from "../src/components/theme";

const rgba = (hex: string) => `${hex.toLowerCase()}ff`;

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
  test(`a reply streams its answer directly with a caret while steps stay collapsible above (${width}px)`, async () => {
    const app = await open("./fixtures/live-reply.tsx", { width, height: 900 });
    // At work: collapsible process window for steps + live streaming answer with caret.
    expect(app.shows("id:process-window")).toBe(true);
    expect(app.shows("Process · 3 steps")).toBe(true);
    expect(app.enabled("Stop")).toBe(true);
    expect(app.count("label:Note")).toBe(1);
    expect(app.shows(note)).toBe(true);
    expect(app.shows("label:Thinking")).toBe(true);
    // A thought starts folded; its words open on a press.
    expect(app.shows("Look at the provider config.")).toBe(false);
    // Streaming answer is visible directly in reply-answer with 2px accent caret.
    expect(app.shows("id:reply-answer")).toBe(true);
    expect(app.shows("id:streaming-caret")).toBe(true);
    expect(app.shows(answer)).toBe(true);
    // Completed tool step renders check icon instead of text badge.
    expect(app.shows("id:step-check")).toBe(true);

    // Collapsing the live process window hides the step rows while keeping Stop & streaming answer.
    await app.press("label:Thinking process");
    expect(app.shows(note)).toBe(false);
    expect(app.shows("id:reply-answer")).toBe(true);
    expect(app.enabled("Stop")).toBe(true);

    await app.press("Finish");
    // Over: the window folds to one row, caret disappears, Copy & Retry appear.
    expect(app.shows("id:process-window")).toBe(false);
    expect(app.shows("id:streaming-caret")).toBe(false);
    expect(app.shows("label:Thinking process")).toBe(true);
    expect(reads(app, "3 steps")).toBe(true);
    expect(app.shows("id:reply-answer")).toBe(true);
    expect(app.shows(answer)).toBe(true);
    expect(app.shows(note)).toBe(false);
    expect(app.shows("label:Copy")).toBe(true);
    expect(app.shows("label:Retry")).toBe(true);
    const finished = app.texts();

    // Afresh from the saved row, it reads the same.
    await app.press("Reload");
    expect(app.texts()).toEqual(finished);
  });
}

test("running tool step shows spinner turning into check when completed", async () => {
  const app = await open("./fixtures/live-reply.tsx", {
    width: 1440,
    height: 900,
  });
  await app.press("Running tool");
  expect(app.shows("id:step-spinner")).toBe(true);
  expect(app.shows("id:step-check")).toBe(false);

  await app.press("Complete tool");
  expect(app.shows("id:step-spinner")).toBe(false);
  expect(app.shows("id:step-check")).toBe(true);
});

test("Copy and Retry actions work on completed and failed replies", async () => {
  const app = await open("./fixtures/live-reply.tsx", {
    width: 1440,
    height: 900,
  });
  await app.press("Finish");
  await app.press("label:Copy");
  expect(app.shows("id:toast")).toBe(true);
  expect(app.texts()).toContain("Copied");

  await app.press("label:Retry");
  expect(app.texts()).toContain("Retried: 1");

  await app.press("End failed");
  expect(app.shows("label:Retry")).toBe(true);
  await app.press("label:Retry");
  expect(app.texts()).toContain("Retried: 2");
});

test("an insert leaves a trace in the window", async () => {
  const app = await open("./fixtures/live-reply.tsx", {
    width: 1440,
    height: 900,
  });
  expect(app.shows("— Received your insert —")).toBe(true);
  expect(app.shows("Also check the key.")).toBe(false);
});

test("a reply without tools streams directly in reply-answer with Stop header", async () => {
  const app = await open("./fixtures/live-reply.tsx", {
    width: 1440,
    height: 900,
  });
  await app.press("Write without tools");
  expect(app.shows("id:process-window")).toBe(true);
  expect(app.shows("Working…")).toBe(true);
  expect(app.shows("id:reply-answer")).toBe(true);
  expect(app.shows("id:streaming-caret")).toBe(true);
  expect(app.shows("Nothing to look up: the answer is 42.")).toBe(true);
  await app.press("Finish");
  expect(app.shows("id:process-window")).toBe(false);
  expect(app.shows("id:streaming-caret")).toBe(false);
  expect(app.shows("label:Thinking process")).toBe(false);
  expect(app.shows("id:reply-answer")).toBe(true);
  expect(app.shows("Nothing to look up: the answer is 42.")).toBe(true);
});

for (const [ending, status] of [
  ["End stopped", "Stopped"],
  ["End failed", "The run failed."],
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
    expect(app.shows("Process · 3 steps")).toBe(true);
    // The panel's timing strip and the whole process.
    expect(app.shows("label:Generation")).toBe(true);
    expect(app.count(`text:${note}`)).toBe(2);
    expect(app.texts().some((text) => text.includes("config.json"))).toBe(true);
    // What the run writes next comes into the open panel and streams live.
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
    // The panel goes out before it is gone.
    await app.waitUntil(() => !app.shows(panel));
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

for (const width of [1440, 1024, 390]) {
  test(`the process window keeps its height from before the first step so the answer does not jump (${width}px)`, async () => {
    const app = await open("./fixtures/live-reply.tsx", {
      width,
      height: 900,
    });
    // Start right after send: 0 steps, header says "Working…".
    await app.press("Start waiting");
    expect(app.shows("Working…")).toBe(true);
    const waitingWindow = app.layout("id:process-window")!;
    const waitingBelow = app.layout("id:below-message")!;

    // Streaming answer with 0 process steps yet.
    await app.press("Write without tools");
    expect(app.shows("Working…")).toBe(true);
    const beforeWindow = app.layout("id:process-window")!;
    const beforeAnswer = app.layout("id:reply-answer")!;

    // First process step arrives while the answer is streaming.
    await app.press("First step");
    expect(app.shows("Process · 1 step")).toBe(true);
    const afterWindow = app.layout("id:process-window")!;
    const afterAnswer = app.layout("id:reply-answer")!;

    // Nothing jumped vertically across the first step.
    expect(waitingWindow.height).toBe(afterWindow.height);
    expect(beforeWindow.height).toBe(afterWindow.height);
    expect(afterAnswer.y).toBe(beforeAnswer.y);

    // Collapsing still folds to just the header; expanding restores full height.
    await app.press("label:Thinking process");
    const collapsedWindow = app.layout("id:process-window")!;
    expect(collapsedWindow.height).toBe(26);
    await app.press("label:Thinking process");
    expect(app.layout("id:process-window")!.height).toBe(afterWindow.height);

    // Waiting with 0 steps -> 1 step without answer also keeps everything below put.
    await app.press("Start waiting");
    const belowBefore = app.layout("id:below-message")!;
    expect(belowBefore.y).toBe(waitingBelow.y);
    // Collapsing also works before the first step lands.
    await app.press("label:Thinking process");
    expect(app.layout("id:process-window")!.height).toBe(
      collapsedWindow.height,
    );
    await app.press("label:Thinking process");
    expect(app.layout("id:process-window")!.height).toBe(afterWindow.height);
    await app.press("Running tool");
    expect(app.layout("id:process-window")!.height).toBe(afterWindow.height);
    expect(app.layout("id:below-message")!.y).toBe(belowBefore.y);
  });
}

async function assertStopButtonFlush(
  app: App,
  width: number,
  scheme: "light" | "dark",
) {
  const windowBox = app.layout("id:process-window")!;
  const stopBox = app.layout("label:Stop")!;
  expect(stopBox.x + stopBox.width).toBe(windowBox.x + windowBox.width - 1);
  expect(stopBox.y).toBeGreaterThanOrEqual(windowBox.y + 1);
  expect(stopBox.y + stopBox.height).toBeLessThanOrEqual(windowBox.y + 24);

  if (width >= 600) {
    expect(app.viewStyle("label:Stop")?.backgroundColor ?? null).toBeNull();
    await app.hover("label:Stop");
    expect(app.viewStyle("label:Stop")?.backgroundColor).toBe(
      rgba(palette(scheme).selected),
    );
    await app.hover("label:Thinking process");
  }

  await app.press("label:Thinking process");
  const collapsedWindow = app.layout("id:process-window")!;
  const collapsedStop = app.layout("label:Stop")!;
  expect(collapsedWindow.height).toBe(26);
  expect(collapsedStop.x + collapsedStop.width).toBe(
    collapsedWindow.x + collapsedWindow.width - 1,
  );
  expect(collapsedStop.y).toBeGreaterThanOrEqual(collapsedWindow.y + 1);
  expect(collapsedStop.y + collapsedStop.height).toBeLessThanOrEqual(
    collapsedWindow.y + collapsedWindow.height - 1,
  );
}

for (const width of [1440, 1024, 390]) {
  test(`the process window Stop button aligns flush with the right edge across themes and states (${width}px)`, async () => {
    const app = await open("./fixtures/live-reply.tsx", {
      width,
      height: 900,
      platform: width < 600 ? "ios" : "macos",
      colorScheme: "light",
    });

    await assertStopButtonFlush(app, width, "light");

    await app.press("label:Thinking process");
    await app.setColorScheme("dark");
    await assertStopButtonFlush(app, width, "dark");

    await app.press("label:Stop");
    expect(app.texts()).toContain(
      'conversations.stop {"conversationId":"group","messageId":"ada-1"}',
    );
  });
}
