import { expect, open, test } from "nsh/test";

const fixture = "./fixtures/process-detail.tsx";
const size = { width: 1440, height: 900 };
const thought = "Look at the provider config.";
const note = "I'll check config.json first.";
const tally = "Process · 10 steps · bash ×3 · web_fetch ×2 · grep ×1 · +2 more";

async function brief(app: Awaited<ReturnType<typeof open>>) {
  await app.press("label:Process detail");
  await app.press("text:Brief");
  await app.waitUntil(() => !app.shows("label:Thinking"));
}

test("Process detail switches a shown reply between its count row, its steps, and its steps with thoughts open", async () => {
  const app = await open(fixture, size);
  // Standard: the steps, a thought folded, words open.
  await app.waitFor("Process · 10 steps");
  expect(app.shows("label:Thinking")).toBe(true);
  expect(app.shows(note)).toBe(true);
  expect(app.shows(thought)).toBe(false);
  const standard = app.texts();

  await app.press("label:Process detail");
  await app.press("text:Brief");
  await app.waitUntil(() => !app.shows("label:Thinking"));
  expect(app.shows(tally)).toBe(true);
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
  await first.waitFor("Process · 10 steps");
  await first.press("label:Process detail");
  await first.press("text:Detailed");
  await first.waitFor(thought);
  const saved = first.storage();
  first.dispose();

  const again = await open(fixture, { ...size, storage: saved });
  await again.waitFor(thought);
  expect(again.shows("text:Detailed")).toBe(true);
});

test("Brief adds the calls by kind to the row, most first, three kinds and the rest as +N more", async () => {
  const app = await open(fixture, size);
  await app.waitFor("Process · 10 steps");
  expect(app.texts().some((text) => text.includes("×"))).toBe(false);
  await brief(app);
  expect(app.shows(tally)).toBe(true);
  expect(app.enabled("Stop")).toBe(true);
});

test("a run that only thought keeps the bare step count in Brief", async () => {
  const app = await open(fixture, size);
  await app.press("Only thought");
  await app.waitFor("Process · 1 step");
  await brief(app);
  expect(app.shows("Process · 1 step")).toBe(true);
  expect(app.texts().some((text) => text.includes("×"))).toBe(false);
});

test("another call while the reply runs counts at once", async () => {
  const app = await open(fixture, size);
  await app.waitFor("Process · 10 steps");
  await brief(app);
  await app.press("Call once more");
  await app.waitFor(
    "Process · 11 steps · bash ×4 · web_fetch ×2 · grep ×1 · +2 more",
  );
});

for (const [width, row] of [
  [800, "Process · 10 steps · bash ×3 · +4 more"],
  [720, "Process · 10 steps"],
] as const)
  test(`short of room, Brief names fewer kinds, then only the step count (${width}px)`, async () => {
    const app = await open(fixture, { width, height: 900 });
    await app.waitFor("Process · 10 steps");
    await brief(app);
    await app.waitFor(row);
  });
