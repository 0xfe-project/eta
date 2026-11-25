import { expect, open, test } from "nsh/test";

// A connection that drops and comes back: the phone says it lost the host only
// once it has been gone for the grace period, reconnects at once when the app
// returns to the foreground, and finds out about a host that stopped answering.

const fixture = "./fixtures/flaky-connection.tsx";
const lost = "text:Can't reach the host";

async function connected() {
  const app = await open(fixture, {
    width: 390,
    height: 844,
    locale: "en-US",
    clock: {},
  });
  await app.press("Greet");
  return app;
}

test("a drop that is over within the grace period shows nothing", async () => {
  const app = await connected();
  await app.press("Drop");
  await app.clock!.runFor(1_000);
  expect(app.shows("text:Attempts 2")).toBe(true);
  expect(app.shows(lost)).toBe(false);
  await app.press("Greet");
  await app.clock!.runFor(5_000);
  expect(app.shows(lost)).toBe(false);
});

test("a drop that outlasts the grace period is shown", async () => {
  const app = await connected();
  await app.press("Drop");
  await app.clock!.runFor(1_900);
  expect(app.shows(lost)).toBe(false);
  await app.clock!.runFor(200);
  expect(app.shows(lost)).toBe(true);
  await app.press("Greet");
  expect(app.shows(lost)).toBe(false);
});

test("coming back to the foreground reconnects at once, not after the pause", async () => {
  const app = await connected();
  // Every attempt fails, and the pause before the next one grows: 8 seconds now.
  for (const pause of [500, 1_000, 2_000, 4_000]) {
    await app.press("Drop");
    await app.clock!.runFor(pause);
  }
  expect(app.shows("text:Attempts 5")).toBe(true);
  await app.press("Drop");
  await app.setLifecycle("background");
  await app.setLifecycle("active");
  expect(app.shows("text:Attempts 6")).toBe(true);
});

test("coming back to the foreground starts again after the retries gave up", async () => {
  const app = await connected();
  await app.press("Drop");
  // Five failed attempts in a row: the app stops retrying and says the host is lost.
  for (const pause of [500, 1_000, 2_000, 4_000, 8_000]) {
    await app.clock!.runFor(pause);
    await app.press("Drop");
  }
  await app.clock!.runFor(30_000);
  expect(app.shows("text:Attempts 6")).toBe(true);
  await app.setLifecycle("background");
  await app.setLifecycle("active");
  expect(app.shows("text:Attempts 7")).toBe(true);
});

test("a host that stops answering pings counts as gone", async () => {
  const app = await open(fixture, {
    width: 390,
    height: 844,
    locale: "en-US",
    clock: {},
  });
  await app.press("Greet with heartbeat");
  // A ping after 15 seconds, unanswered for 10: the connection is dropped and
  // retried, and two seconds later the phone says so.
  await app.clock!.runFor(24_900);
  expect(app.shows("text:Attempts 1")).toBe(true);
  await app.clock!.runFor(600);
  expect(app.shows("text:Attempts 2")).toBe(true);
  await app.clock!.runFor(2_000);
  expect(app.shows(lost)).toBe(true);
});
