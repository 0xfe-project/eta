import { expect, open, test } from "nsh/test";

// Each row of the Tasks tab says, under its title, its number, who runs it and when it last
// moved. The headless engine is the native runtime (no `Intl.RelativeTimeFormat`), where the
// line used to throw and come out empty on the macOS, Linux and Windows apps.
const sizes = [
  ["desktop", 1440, 900],
  ["tablet", 1024, 768],
  ["phone", 390, 844],
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
