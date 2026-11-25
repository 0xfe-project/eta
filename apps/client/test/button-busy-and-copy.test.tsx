import { expect, open, test } from "nsh/test";

const fixture = "./fixtures/button-busy-and-copy.tsx";

test("busy button preserves width and keyboard reachability while preventing double-submit", async () => {
  const app = await open(fixture, {
    width: 1024,
    height: 700,
    locale: "en-US",
    clock: {},
  });

  const before = app.layout("label:Save changes");
  expect(before).not.toBeNull();

  await app.press("label:Save changes");
  // Stays enabled (keyboard reachable) while busy, and ignores duplicate presses.
  expect(app.enabled("label:Save changes")).toBe(true);
  await app.press("label:Save changes");
  expect(app.shows("text:saves:1")).toBe(true);

  // Even after the 300ms spinner reveal, the button keeps its exact width.
  await app.clock!.runFor(350);
  const during = app.layout("label:Save changes");
  expect(during?.width).toBe(before?.width);
  expect(app.enabled("label:Save changes")).toBe(true);

  await app.press("label:Finish save");
  await app.clock!.runFor(550);
  await app.press("label:Save changes");
  expect(app.shows("text:saves:2")).toBe(true);
});

test("spinning refresh icon prevents double-submit and confirms off-screen result with a short toast", async () => {
  const app = await open(fixture, {
    width: 1024,
    height: 700,
    locale: "en-US",
    clock: {},
  });

  await app.press("label:Refresh catalog");
  expect(app.enabled("label:Refresh catalog")).toBe(true);
  await app.press("label:Refresh catalog");
  expect(app.shows("text:refreshes:1")).toBe(true);

  await app.press("label:Finish refresh");
  expect(app.shows("id:toast")).toBe(true);
  await app.clock!.runFor(3100);
  expect(app.shows("id:toast")).toBe(false);
});

test("copy action writes to clipboard and displays a short Copied confirmation toast", async () => {
  const app = await open(fixture, {
    width: 1024,
    height: 700,
    locale: "en-US",
    clock: {},
  });

  await app.press("label:Copy code");
  expect(app.clipboard()).toBe("eta-secret-code");
  expect(app.shows("text:Copied")).toBe(true);
  await app.clock!.runFor(3100);
  expect(app.shows("text:Copied")).toBe(false);
});
