import { expect, open, test } from "nsh/test";

const fixture = "./fixtures/progress-notifications.tsx";

async function openMode(mode: string) {
  return open(fixture, {
    width: 1280,
    height: 800,
    locale: "en-US",
    platform: "web",
    storage: { mode },
    clock: {},
  });
}

test("progress notification reveals after 300ms, survives page navigation, shows ETA, and completes in place", async () => {
  const app = await openMode("cross-page");
  expect(app.texts()).toContain("ETA sample: 1m 30s left");

  await app.press("label:Start export");
  // Hidden before 300ms reveal threshold.
  await app.clock!.runFor(200);
  expect(app.shows("id:progress-notification-export-pdf")).toBe(false);

  // Visible after 300ms with initial "Estimating…" warmup.
  await app.clock!.runFor(150);
  expect(app.shows("id:progress-notification-export-pdf")).toBe(true);
  expect(app.texts().some((t) => t.includes("Estimating…"))).toBe(true);

  // Survives switching to another page and updates ETA after 1s warmup.
  await app.press("label:Switch page");
  expect(app.texts()).toContain("Active page: page-b");
  expect(app.shows("id:progress-notification-export-pdf")).toBe(true);

  await app.clock!.runFor(1100);
  await app.press("label:Advance export");
  expect(app.texts().some((t) => t.includes("50%"))).toBe(true);
  expect(app.texts().some((t) => t.includes("left"))).toBe(true);

  // Transitions in-place to Done and invokes onOpen when clicked.
  await app.press("label:Finish export");
  expect(app.texts()).toContain("Saved quarterly.pdf");
  await app.press("id:progress-notification-export-pdf");
  expect(app.texts()).toContain("Opened: 1");
  expect(app.shows("id:progress-notification-export-pdf")).toBe(false);
});

test("host update download mirrors into ProgressNotification with cancel and clears when restart screen takes over", async () => {
  const app = await openMode("cross-page");
  await app.press("label:Start host download");
  await app.clock!.runFor(350);
  expect(app.shows("id:progress-notification-host-update")).toBe(true);
  expect(app.texts().some((t) => t.includes("50%"))).toBe(true);

  // Cancel button invokes upgrade.cancel.
  await app.press("label:Cancel");
  expect(app.texts()).toContain("Sent: upgrade.cancel");
  expect(app.shows("id:progress-notification-host-update")).toBe(false);

  // Restarting phase dismisses the top-right progress card so only the restart screen is shown.
  await app.press("label:Start host download");
  await app.clock!.runFor(350);
  expect(app.shows("id:progress-notification-host-update")).toBe(true);
  await app.press("label:Host restarting");
  expect(app.shows("id:progress-notification-host-update")).toBe(false);
  expect(app.shows("label:Host update in progress")).toBe(true);
});

test("attachment chip renders inline progress bar without changing chip height", async () => {
  const app = await openMode("chip");
  const idleBox = app.layout("id:chip-wrap");
  expect(idleBox).toBeTruthy();

  await app.press("label:Upload 40%");
  const uploadingBox = app.layout("id:chip-wrap");
  expect(uploadingBox?.height).toBe(idleBox?.height);
  expect(app.shows("role:progressbar")).toBe(true);

  await app.press("label:Upload 85%");
  expect(app.layout("id:chip-wrap")?.height).toBe(idleBox?.height);

  await app.press("label:Upload done");
  expect(app.shows("role:progressbar")).toBe(false);
  expect(app.layout("id:chip-wrap")?.height).toBe(idleBox?.height);
});

test("SSH install shows 'Taking longer than usual…' after 10s and clears on finish", async () => {
  const app = await openMode("ssh");
  await app.press("label:Method");
  await app.press("label:Install over SSH");
  await app.type("label:Target", "dev@gpu-box");
  await app.press(
    "label:Logs in without a password (SSH key or Tailscale SSH)",
  );
  await app.press("label:Install");

  await app.clock!.runFor(9_000);
  expect(app.texts()).not.toContain("Taking longer than usual…");

  await app.clock!.runFor(1_500);
  expect(app.texts()).toContain("Taking longer than usual…");

  await app.press("label:Finish install");
  expect(app.texts()).not.toContain("Taking longer than usual…");
});
