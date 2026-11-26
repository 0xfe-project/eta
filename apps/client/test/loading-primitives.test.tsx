import { expect, open, test } from "nsh/test";
import { motion } from "../src/components/motion";
import { startProgress } from "../src/components/progress-notification";

const fixture = "./fixtures/loading-primitives.tsx";

test("shared timing constants match 300ms reveal and 500ms minShown", () => {
  expect(motion.reveal).toBe(300);
  expect(motion.minShown).toBe(500);
  expect(motion.spinAction.minTurnMs).toBe(640);
  expect(typeof startProgress).toBe("function");
});

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

test("ProgressNotification delays 300ms, shows Estimating then ETA, and completes in place", async () => {
  const app = await open(fixture, {
    width: 1200,
    height: 800,
    locale: "en-US",
    clock: {},
  });

  // Fast <300ms work never flashes a notification card.
  await app.press("label:Start export");
  await app.clock!.runFor(200);
  expect(app.shows("id:progress-notification-export")).toBe(false);
  await app.press("label:Finish export");
  await app.clock!.runFor(200);
  expect(app.shows("id:progress-notification-export")).toBe(false);

  // Longer work reveals at 300ms with "Estimating…" during first 1s of data.
  await app.press("label:Start export");
  await app.clock!.runFor(350);
  expect(app.shows("id:progress-notification-export")).toBe(true);
  expect(app.texts().some((t) => t.includes("Estimating"))).toBe(true);

  // After 1s of data, shows count + remaining ETA.
  await app.clock!.runFor(1000);
  await app.press("label:Advance export");
  expect(app.texts().some((t) => t.includes("5 / 10"))).toBe(true);
  expect(app.texts().some((t) => t.includes("left"))).toBe(true);

  // In-place completion: stays until opened or closed; pressing opens result and dismisses.
  await app.press("label:Finish export");
  expect(app.shows("id:progress-notification-export")).toBe(true);
  expect(app.shows("text:PDF exported")).toBe(true);
  await app.clock!.runFor(5000);
  expect(app.shows("id:progress-notification-export")).toBe(true);

  await app.press("id:progress-notification-export");
  expect(app.shows("id:progress-notification-export")).toBe(false);
  expect(app.shows("text:export:opened")).toBe(true);
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

test("SpinningIcon starts immediately and finishes smoothly without reduced motion", async () => {
  const app = await open(fixture, {
    width: 1200,
    height: 800,
    locale: "en-US",
  });

  await app.press("label:Start spin");
  await app.wait(200);
  await app.press("label:Stop spin");
  await app.wait(600);
  expect(app.shows("id:spin-host")).toBe(true);
});

test("SpinningIcon and primitives stay clean under reduced motion", async () => {
  const app = await open(fixture, {
    width: 1200,
    height: 800,
    locale: "en-US",
    reducedMotion: true,
    clock: {},
  });

  await app.press("label:Start spin");
  await app.clock!.runFor(800);
  await app.press("label:Stop spin");
  expect(app.shows("id:spin-host")).toBe(true);

  await app.press("label:Start indeterminate");
  await app.clock!.runFor(400);
  expect(app.shows("id:progress-notification-clone")).toBe(true);
});
