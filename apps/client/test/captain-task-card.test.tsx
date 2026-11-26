import { expect, open, test } from "nsh/test";

const fixture = "./fixtures/captain-task-card.tsx";

for (const [width, prefix] of [
  [1440, "Task card"],
  [834, "Task card"],
  [390, "Task"],
] as const) {
  test(`renders Captain task_card, custom captainNote, legacy dispatch row, and deleted fallback at ${width}px`, async () => {
    const app = await open(fixture, { width, height: 1600, locale: "en-US" });
    const texts = app.texts();

    // (a) New Captain task_card without custom note renders as TaskSummary and hides raw fallback text.
    expect(texts).toContain("Captain");
    expect(texts).toContain("assigned to Ada");
    expect(texts).toContain("Ship the Captain patch");
    expect(texts.some((text) => text.includes("Dispatched task"))).toBe(false);

    // (b) New Captain task_card with custom captainNote renders note + assignee + TaskSummary.
    expect(texts).toContain("assigned to Bola");
    expect(texts).toContain("Bola takes Step B after Step A.");
    expect(texts).toContain("Verify deployment");

    // (c) Legacy kind:"message" dispatch row renders as TaskSummary (open by default) without raw English string.
    expect(texts).toContain("Migrate old timeline");
    expect(texts).toContain("Done");

    // (d) Deleted task fallbacks (both new and legacy) render taskGone copy.
    expect(
      texts.filter((text) => text === "This task no longer exists"),
    ).toHaveLength(2);

    // (e) Regular assign_in_group Captain message still renders its text.
    expect(texts).toContain("Please review the release notes.");

    // (f) Captain task cards and legacy dispatch cards match regular agent task_card width/alignment.
    const capNewHead = app.layout(
      `label:${prefix} #101 Ship the Captain patch`,
    )!;
    const capNoteHead = app.layout(`label:${prefix} #102 Verify deployment`)!;
    const legacyHead = app.layout(`label:${prefix} #103 Migrate old timeline`)!;
    const agentHead = app.layout(`label:${prefix} #107 Write unit tests`)!;
    expect(capNewHead.x).toBe(agentHead.x);
    expect(capNewHead.width).toBe(agentHead.width);
    expect(capNoteHead.x).toBe(agentHead.x);
    expect(capNoteHead.width).toBe(agentHead.width);
    expect(legacyHead.x).toBe(agentHead.x);
    expect(legacyHead.width).toBe(agentHead.width);

    // Folding works on legacy dispatch cards just like task_card rows.
    await app.press(`label:${prefix} #103 Migrate old timeline`);
    expect(app.texts()).toContain("Migrate old timeline");
    await app.press(`label:${prefix} #103 Migrate old timeline`);

    // Clicking each Captain task card (new, custom note, legacy) opens its task detail.
    await app.press("label:Open task #101");
    await app.press("label:Open task #102");
    await app.press("label:Open task #103");
    expect(app.texts()).toContain("Opened: task-101,task-102,task-103");

    app.dispose();
  });
}

test("renders localized Captain dispatch attribution and deleted fallback in zh-CN", async () => {
  const app = await open(fixture, {
    width: 1440,
    height: 1600,
    locale: "zh-CN",
  });
  const texts = app.texts();
  expect(texts).toContain("指派给 Ada");
  expect(texts).toContain("指派给 Bola");
  expect(texts).toContain("Bola takes Step B after Step A.");
  expect(texts.filter((text) => text === "这个任务已不存在")).toHaveLength(2);
  expect(texts.some((text) => text.includes("Dispatched task"))).toBe(false);
  app.dispose();
});
