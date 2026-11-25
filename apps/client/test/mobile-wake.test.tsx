import { expect, open, test } from "nsh/test";

// A phone that went to the background and came back: the workspace, once the app has been
// online, is not replaced by the connection page — the socket dropped, the retries gave up, the
// app woke up and reconnected, and what the user had open is still behind it. Only a cold start,
// or the user asking for another host, goes back to the connection page.

const fixture = "./fixtures/mobile-wake.tsx";

async function started() {
  return open(fixture, { width: 390, height: 844, locale: "en-US", clock: {} });
}

test("a cold start is the connection page", async () => {
  const app = await started();
  expect(app.shows("text:Connection")).toBe(true);
  expect(app.shows("text:Workspace")).toBe(false);
});

test("after the host answers, the workspace is what is shown", async () => {
  const app = await started();
  await app.press("Greet");
  expect(app.shows("text:Workspace")).toBe(true);
  expect(app.shows("text:Connection")).toBe(false);
});

test("the retries giving up does not throw the workspace away", async () => {
  const app = await started();
  await app.press("Greet");
  await app.press("Drop");
  await app.clock!.runFor(120_000);
  expect(app.shows("text:Paused yes")).toBe(true);
  expect(app.shows("text:Workspace")).toBe(true);
});

test("waking up and reconnecting keeps the workspace on screen", async () => {
  const app = await started();
  await app.press("Greet");
  await app.press("Drop");
  await app.clock!.runFor(120_000);
  await app.press("Wake");
  // The wire starts over, so the app is not connected at this instant.
  expect(app.shows("text:Workspace")).toBe(true);
});

test("asking for another host goes back to the connection page", async () => {
  const app = await started();
  await app.press("Greet");
  await app.press("Switch host");
  expect(app.shows("text:Connection")).toBe(true);
});
