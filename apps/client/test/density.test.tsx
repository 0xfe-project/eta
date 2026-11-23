import type { App } from "nsh/test";
import { expect, open, test } from "nsh/test";

// A part of the app that says `compact` (a side panel, a menu, a board card) draws what is in it
// in the compact defaults: small text, and Markdown whose heading, table and code are no larger
// than its text. A part that says nothing, a `Compact` that is off, and a dialog opened from a
// compact part keep the regular ones.
const start = (region: string, dialog = false) =>
  open("./fixtures/density.tsx", {
    width: 1280,
    height: 900,
    locale: "en-US",
    platform: "web",
    storage: { region, ...(dialog ? { dialog: "1" } : {}) },
  });

const size = (app: App, text: string) => app.spanStyle(`text:${text}`).fontSize;

test("compact: labels, the task bar and Markdown take the small text", async () => {
  const app = await start("compact");
  await app.waitFor("text:Plain label");
  const body = size(app, "Pick the faster one.");
  expect(size(app, "Plain label")).toBe(body);
  expect(size(app, "#7")).toBe(body);
  expect(size(app, "Tasks")).toBe(body);
  expect(size(app, "Goal")).toBe(body);
  expect(size(app, "Option")).toBe(body);
  expect(size(app, "12 ms")).toBe(body);
  expect(size(app, "bun run bench")).toBe(body);
  expect(app.layout("label:Back to tasks")?.height).toBe(24);
});

test("regular, and a Compact that is off: the regular sizes", async () => {
  for (const region of ["regular", "off"]) {
    const app = await start(region);
    await app.waitFor("text:Plain label");
    const label = size(app, "Plain label");
    expect(size(app, "Pick the faster one.")).toBe(label);
    expect(size(app, "#7")).toBe(label);
    expect(size(app, "Tasks")).toBe(label);
    expect(size(app, "Goal")).toBeGreaterThan(label);
    expect(app.layout("label:Back to tasks")?.height).toBe(28);
  }
});

test("a dialog opened from a compact part is regular", async () => {
  const compact = await start("compact", true);
  await compact.waitFor("text:Dialog label");
  const regular = await start("regular");
  await regular.waitFor("text:Plain label");
  expect(size(compact, "Dialog label")).toBe(size(regular, "Plain label"));
  expect(size(compact, "Dialog label")).toBeGreaterThan(
    size(compact, "Plain label"),
  );
});
