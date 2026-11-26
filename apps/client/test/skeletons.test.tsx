import { expect, open, test } from "nsh/test";

const fixture = "./fixtures/skeletons.tsx";

test("skeleton delays 300ms, holds 500ms minShown, and reveals real rows", async () => {
  const app = await open(fixture, {
    width: 1024,
    height: 768,
    locale: "en-US",
    clock: {},
  });

  // Not shown before 300ms.
  await app.clock!.runFor(250);
  expect(app.shows("label:Loading items…")).toBe(false);

  // Shown at 300ms.
  await app.clock!.runFor(100);
  expect(app.shows("label:Loading items…")).toBe(true);

  // Even when data arrives immediately after reveal, skeleton holds for 500ms minShown.
  await app.press("label:Mark list ready");
  await app.clock!.runFor(350);
  expect(app.shows("label:Loading items…")).toBe(true);
  expect(app.shows("id:real-rows")).toBe(false);

  await app.clock!.runFor(200);
  expect(app.shows("id:real-rows")).toBe(true);
  expect(app.shows("text:Alpha")).toBe(true);
  expect(app.shows("text:Gamma")).toBe(true);
});

test("skeletons and SkeletonReveal render cleanly under reduced motion", async () => {
  const app = await open(fixture, {
    width: 1024,
    height: 768,
    locale: "en-US",
    reducedMotion: true,
    clock: {},
  });

  await app.clock!.runFor(350);
  expect(app.shows("label:Loading items…")).toBe(true);
  await app.press("label:Mark list ready");
  await app.clock!.runFor(550);
  expect(app.shows("text:Alpha")).toBe(true);
});

test("onboarding PersonaStep delays skeleton, avoids duplicate Loading… text, and supports Retry on error", async () => {
  const app = await open(fixture, {
    width: 1024,
    height: 768,
    locale: "en-US",
    clock: {},
  });

  await app.press("label:Tab onboarding");
  await app.clock!.runFor(200);
  expect(app.shows("label:Loading agents…")).toBe(false);
  expect(app.shows("text:Loading…")).toBe(false);

  await app.clock!.runFor(150);
  expect(app.shows("label:Loading agents…")).toBe(true);
  expect(app.shows("text:Loading…")).toBe(false);

  await app.press("label:Fail personas");
  await app.clock!.runFor(550);
  expect(app.shows("text:Agents didn't load")).toBe(true);
  await app.press("label:Retry");
  expect(app.shows("text:persona-retries:1")).toBe(true);
});

test("Widget reserves stable min-height while loading and offers Retry on 8s timeout", async () => {
  const app = await open(fixture, {
    width: 1024,
    height: 768,
    locale: "en-US",
    clock: {},
  });

  await app.press("label:Tab widget");
  const initial = app.layout("id:widget-wrap");
  expect(initial).not.toBeNull();
  expect(initial!.height).toBeGreaterThanOrEqual(160);

  await app.clock!.runFor(350);
  expect(app.shows("label:Drawing Revenue chart…")).toBe(true);

  await app.clock!.runFor(8000);
  expect(app.shows("text:Revenue chart unavailable")).toBe(true);
  await app.press("label:Retry");
  expect(app.shows("text:Revenue chart unavailable")).toBe(false);
});

test("TaskDetail renders gone state with Back to tasks instead of hanging forever on missing target", async () => {
  const app = await open(fixture, {
    width: 1024,
    height: 768,
    locale: "en-US",
    clock: {},
  });

  await app.press("label:Tab task");
  expect(app.shows("text:This task no longer exists")).toBe(true);
  await app.press("label:Back to tasks");
  expect(app.shows("text:task-closed:1")).toBe(true);
});
