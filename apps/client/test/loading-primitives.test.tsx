import { expect, open, test } from "nsh/test";

const fixture = "./fixtures/loading-primitives.tsx";

test("shownWhile and settled wait 300ms before revealing and stay at least 500ms", async () => {
  const app = await open(fixture, {
    width: 1200,
    height: 800,
    locale: "en-US",
    clock: {},
  });

  // Fast wait (<300ms) never reveals pending UI.
  await app.press("label:Start busy");
  await app.clock!.runFor(250);
  expect(app.shows("text:pending:hidden")).toBe(true);
  await app.press("label:Stop busy");
  await app.clock!.runFor(100);
  expect(app.shows("text:pending:hidden")).toBe(true);
  expect(app.shows("text:region:settled")).toBe(true);

  // Wait >=300ms reveals and holds for at least 500ms even if work finishes at 350ms.
  await app.press("label:Start busy");
  await app.clock!.runFor(299);
  expect(app.shows("text:pending:hidden")).toBe(true);
  await app.clock!.runFor(10);
  expect(app.shows("text:pending:shown")).toBe(true);
  expect(app.shows("text:region:skeleton")).toBe(true);

  await app.clock!.runFor(50);
  await app.press("label:Stop busy");
  // Still within 500ms minimum display window.
  await app.clock!.runFor(400);
  expect(app.shows("text:pending:shown")).toBe(true);
  expect(app.shows("text:region:skeleton")).toBe(true);

  // Past 500ms from reveal: clears cleanly.
  await app.clock!.runFor(100);
  expect(app.shows("text:pending:hidden")).toBe(true);
  expect(app.shows("text:region:settled")).toBe(true);
});

test("short confirmation toast auto-dismisses at 3000ms while Undo toast stays 6000ms", async () => {
  const app = await open(fixture, {
    width: 1200,
    height: 800,
    locale: "en-US",
    clock: {},
  });

  await app.press("label:Short toast");
  expect(app.shows("text:Copied")).toBe(true);
  await app.clock!.runFor(2900);
  expect(app.shows("text:Copied")).toBe(true);
  await app.clock!.runFor(200);
  expect(app.shows("text:Copied")).toBe(false);

  await app.press("label:Undo toast");
  expect(app.shows("text:Archived task")).toBe(true);
  await app.clock!.runFor(3500);
  expect(app.shows("text:Archived task")).toBe(true);
  await app.press("label:Undo");
  expect(app.shows("text:Archived task")).toBe(false);
  expect(app.shows("text:undo")).toBe(true);

  await app.press("label:Custom toast");
  expect(app.shows("text:Quick note")).toBe(true);
  await app.clock!.runFor(1300);
  expect(app.shows("text:Quick note")).toBe(false);
});

test("ProgressNotification supports cancel, >10s slow hint on indeterminate work, and failure retry", async () => {
  const app = await open(fixture, {
    width: 1200,
    height: 800,
    locale: "en-US",
    clock: {},
  });

  await app.press("label:Start indeterminate");
  await app.clock!.runFor(350);
  expect(app.shows("id:progress-notification-clone")).toBe(true);
  expect(app.shows("text:Taking longer than usual…")).toBe(false);

  await app.clock!.runFor(10_000);
  expect(app.shows("text:Taking longer than usual…")).toBe(true);

  await app.press("id:progress-notification-clone >> label:Cancel");
  expect(app.shows("id:progress-notification-clone")).toBe(false);
  expect(app.shows("text:clone:cancelled")).toBe(true);

  await app.press("label:Start export");
  await app.clock!.runFor(350);
  await app.press("label:Fail progress");
  expect(app.shows("text:Export failed")).toBe(true);
  await app.press("id:progress-notification-export >> label:Retry");
  expect(app.shows("id:progress-notification-export")).toBe(false);
  expect(app.texts().some((t) => t.includes("export:retried"))).toBe(true);
});

test("under reduced motion a progress card still reveals", async () => {
  const app = await open(fixture, {
    width: 1200,
    height: 800,
    locale: "en-US",
    reducedMotion: true,
    clock: {},
  });

  await app.press("label:Start indeterminate");
  await app.clock!.runFor(400);
  expect(app.shows("id:progress-notification-clone")).toBe(true);
});
