import { expect, open, test } from "nsh/test";

const fixture = "./fixtures/process-detail.tsx";
const size = { width: 1440, height: 900 };
const thought = "Look at the provider config.";
const note = "I'll check config.json first.";

test("Process detail switches a shown reply between its count row, its steps, and its steps with thoughts open", async () => {
  const app = await open(fixture, size);
  // Standard: the steps, a thought folded, words open.
  await app.waitFor("Process · 3 steps");
  expect(app.shows("label:Thinking")).toBe(true);
  expect(app.shows(note)).toBe(true);
  expect(app.shows(thought)).toBe(false);
  const standard = app.texts();

  await app.press("label:Process detail");
  await app.press("text:Brief");
  await app.waitUntil(() => !app.shows("label:Thinking"));
  expect(app.shows("Process · 3 steps")).toBe(true);
  expect(app.shows(note)).toBe(false);
  expect(app.enabled("Stop")).toBe(true);

  await app.press("label:Process detail");
  await app.press("text:Detailed");
  await app.waitFor(thought);
  expect(app.shows(note)).toBe(true);
  // A thought the reader folds stays folded.
  await app.press("label:Thinking");
  expect(app.shows(thought)).toBe(false);

  await app.press("label:Process detail");
  // The menu opens over the page, after the chat width row that also reads Standard.
  await app.press("text:Standard >> nth=1");
  await app.waitUntil(() => app.shows(note) && !app.shows("text:Brief"));
  expect(app.shows(thought)).toBe(false);
  expect(app.texts()).toEqual(standard);
});

test("the chosen detail is kept on the device", async () => {
  const first = await open(fixture, size);
  await first.waitFor("Process · 3 steps");
  await first.press("label:Process detail");
  await first.press("text:Detailed");
  await first.waitFor(thought);
  const saved = first.storage();
  first.dispose();

  const again = await open(fixture, { ...size, storage: saved });
  await again.waitFor(thought);
  expect(again.shows("text:Detailed")).toBe(true);
});
