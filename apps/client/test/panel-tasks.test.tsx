import { expect, open, test } from "nsh/test";

// Each row of the Tasks tab says, under its title, its number, who runs it and when it last
// moved. The headless engine is the native runtime (no `Intl.RelativeTimeFormat`), where the
// line used to throw and come out empty on the macOS, Linux and Windows apps.
const sizes = [
  ["desktop", 1440, 900],
  ["tablet", 1024, 768],
  ["phone", 390, 844],
] as const;

const openRows = [
  [5, "Build the login API", "#5 · Bo · 12 minutes ago"],
  [2, "Write the login API tests", "#2 · Ada · 3 hours ago"],
  [7, "Wire up the login page", "#7 · Ada · Just now"],
] as const;

for (const [name, width, height] of sizes) {
  test(`${name}: every task row has its number, executor and time`, async () => {
    const app = await open("./fixtures/panel-tasks.tsx", {
      width,
      height,
      locale: "en-US",
    });
    await app.waitFor("text:Build the login API");
    const texts = app.texts();
    expect(texts).toContain("#2 · Ada · 3 hours ago");
    expect(texts).toContain("#5 · Bo · 12 minutes ago");
    expect(texts).toContain("#7 · Ada · Just now");
  });

  test(`${name}: task status glyph aligns with the title line and metadata aligns under the title`, async () => {
    const app = await open("./fixtures/panel-tasks.tsx", {
      width,
      height,
      locale: "en-US",
    });
    await app.waitFor("text:Build the login API");
    for (const [number, titleText, metaText] of openRows) {
      const glyph = app.layout(`id:panel-task-glyph-${number}`)!;
      const title = app.layout(`text:${titleText}`)!;
      const meta = app.layout(`text:${metaText}`)!;
      expect(glyph).not.toBeNull();
      expect(title).not.toBeNull();
      expect(meta).not.toBeNull();
      expect(
        Math.abs(glyph.y + glyph.height / 2 - (title.y + title.height / 2)),
      ).toBeLessThanOrEqual(1);
      expect(title.x).toBeGreaterThan(glyph.x + glyph.width);
      expect(Math.abs(meta.x - title.x)).toBeLessThanOrEqual(1);
    }
  });
}

// The sort beside the title: by what each task needs from you (the default), or every open task in
// one list by when it last changed, the time leading its second line. Done ones stay folded.
const titles = [
  "Build the login API",
  "Write the login API tests",
  "Wire up the login page",
  "Design the login flow",
];
const order = (texts: string[]) =>
  texts.filter((text) => titles.includes(text));

test("by default the tasks are grouped by what they need", async () => {
  const app = await open("./fixtures/panel-tasks.tsx", {
    width: 1440,
    height: 900,
    locale: "en-US",
  });
  await app.waitFor("text:Build the login API");
  expect(app.texts()).toContain("Needs you first");
  expect(order(app.texts())).toEqual([
    "Build the login API",
    "Write the login API tests",
    "Wire up the login page",
  ]);
});

test("Recently updated lists the open tasks newest first", async () => {
  const app = await open("./fixtures/panel-tasks.tsx", {
    width: 1440,
    height: 900,
    locale: "en-US",
  });
  await app.waitFor("text:Build the login API");
  await app.press("label:Sort tasks");
  await app.press("label:Recently updated");
  expect(app.texts()).toContain("Recently updated");
  expect(app.texts()).not.toContain("Needs you 1");
  expect(order(app.texts())).toEqual([
    "Wire up the login page",
    "Build the login API",
    "Write the login API tests",
  ]);
  expect(app.texts()).toContain("12 minutes ago");

  const glyph5 = app.layout("id:panel-task-glyph-5")!;
  const title5 = app.layout("text:Build the login API")!;
  const time5 = app.layout("text:12 minutes ago")!;
  expect(
    Math.abs(glyph5.y + glyph5.height / 2 - (title5.y + title5.height / 2)),
  ).toBeLessThanOrEqual(1);
  expect(title5.x).toBeGreaterThan(glyph5.x + glyph5.width);
  expect(Math.abs(time5.x - title5.x)).toBeLessThanOrEqual(1);

  // Done tasks are still folded at the end.
  await app.press("text:Completed 1");
  expect(order(app.texts()).at(-1)).toBe("Design the login flow");
});

test("the sort chosen on this device is kept", async () => {
  const app = await open("./fixtures/panel-tasks.tsx", {
    width: 1440,
    height: 900,
    locale: "en-US",
    storage: { "eta.tasks-panel-sort.v1": "updated" },
  });
  await app.waitFor("text:Recently updated");
  expect(order(app.texts())).toEqual([
    "Wire up the login page",
    "Build the login API",
    "Write the login API tests",
  ]);
});
