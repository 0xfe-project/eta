import { expect, open, test } from "nsh/test";

const fixture = "./fixtures/task-cards.tsx";
const cardHead = "label:Task card #5 Write the changelog";
const phoneCardHead = "label:Task #5 Write the changelog";
const draftHead = "label:Task draft";

for (const [width, head] of [
  [1440, cardHead],
  [834, cardHead],
  [390, phoneCardHead],
] as const) {
  test(`folds and unfolds a task card and a draft by pressing their head at ${width}px`, async () => {
    const app = await open(fixture, { width, height: 844, locale: "en-US" });
    // A card starts open, a draft folded.
    expect(app.texts()).toContain("Done");
    expect(app.texts()).not.toContain("Wrap the footer links under 360px.");

    await app.press(head);
    expect(app.texts()).not.toContain("Done");
    expect(app.texts()).toContain("Write the changelog");
    await app.press(head);
    expect(app.texts()).toContain("Done");

    await app.press(draftHead);
    expect(app.texts()).toContain("Wrap the footer links under 360px.");
    await app.press(draftHead);
    expect(app.texts()).not.toContain("Wrap the footer links under 360px.");

    // Folding is not opening: the task opens from its number and title.
    expect(app.texts()).toContain("Opened: ");
    await app.press("label:Open task #5");
    expect(app.texts()).toContain("Opened: task-5");
    expect(app.texts()).toContain("Done");
  });
}

test("a fold the reader chose survives a reload, as on the web", async () => {
  const first = await open(fixture, {
    width: 1440,
    height: 844,
    locale: "en-US",
  });
  await first.press(cardHead);
  await first.press(draftHead);
  const saved = first.storage();
  expect(JSON.parse(saved["eta.card-folds.v1"]!)).toEqual({
    "card-1": 0,
    "draft-1": 1,
  });
  first.dispose();

  const again = await open(fixture, {
    width: 1440,
    height: 844,
    locale: "en-US",
    storage: saved,
  });
  await again.waitUntil(() =>
    again.texts().includes("Wrap the footer links under 360px."),
  );
  expect(again.texts()).not.toContain("Done");
});

test("cards nobody folded open as their defaults after a reload", async () => {
  const app = await open(fixture, {
    width: 1440,
    height: 844,
    locale: "en-US",
    storage: { "eta.card-folds.v1": JSON.stringify({ other: 0 }) },
  });
  expect(app.texts()).toContain("Done");
  expect(app.texts()).not.toContain("Wrap the footer links under 360px.");
});

for (const width of [1440, 390] as const) {
  test(`waiting task card pill shows prerequisite #number instead of title at ${width}px`, async () => {
    const app = await open(fixture, { width, height: 844, locale: "en-US" });
    const texts = app.texts();
    expect(texts).toContain("Waiting for #424");
    expect(texts).toContain("Waiting for #424 +2");
    expect(
      texts.some((text) =>
        text.includes("Add Antigravity as a built-in OAR runtime"),
      ),
    ).toBe(false);
    if (width === 390) {
      const link = app.layout("label:Open task #427");
      expect(link).not.toBeNull();
      expect(link!.width).toBeGreaterThan(100);
    }
  });
}

test("waiting task card pill renders Chinese prerequisite #number copy", async () => {
  const app = await open(fixture, {
    width: 1440,
    height: 844,
    locale: "zh-CN",
  });
  const texts = app.texts();
  expect(texts).toContain("等待 #424");
  expect(texts).toContain("等待 #424 +2");
  expect(
    texts.some((text) =>
      text.includes("Add Antigravity as a built-in OAR runtime"),
    ),
  ).toBe(false);
});
