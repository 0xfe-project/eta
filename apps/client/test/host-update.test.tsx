import { expect, open, test } from "nsh/test";

// A Host update as the user follows it: Settings › Update says what is happening at each step,
// the whole window is covered from the moment the service stops, and the end is told, with
// what to do next when it did not work. Machines › gpu-box says the same of a daemon's update.

const fixture = "./fixtures/host-update.tsx";

async function settings(page = "update", script = "") {
  const app = await open(fixture, {
    width: 1440,
    height: 900,
    locale: "en-US",
    platform: "web",
    storage: { page, script },
    clock: {},
  });
  await app.waitFor(page === "update" ? "text:0.9.0" : "text:gpu-box");
  return app;
}

test("pressing Update closes the dialog and says it is starting at once", async () => {
  const app = await settings();
  await app.press("label:Update to 0.9.1");
  await app.press("label:Update");
  expect(app.texts()).toContain("Sent: upgrade.start");
  expect(app.shows("text:Update the Host to 0.9.1?")).toBe(false);
  expect(app.texts()).toContain("Starting…");
  expect(app.texts()).toContain(
    "Starting the update. Nothing stops until the restart.",
  );
});

test("the download says how far it is", async () => {
  const app = await settings();
  await app.press("label:Downloading");
  expect(app.texts()).toContain("Downloading 62%");
  expect(app.texts()).toContain(
    "243.5 MB of 391.6 MB. Eta keeps working until the restart.",
  );
});

test("waiting for work names it, and can go now instead", async () => {
  const app = await settings();
  await app.press("label:Waiting");
  expect(app.texts()).toContain("Waiting for running work");
  expect(app.texts()).toContain("• Task #1 Write the release notes");
  await app.press("label:Update now");
  expect(app.texts()).toContain("Sent: upgrade.cancel, upgrade.start");
});

test("from the restart the whole window is covered, step by step", async () => {
  const app = await settings();
  await app.press("label:Restarting");
  expect(app.shows("label:Host update in progress")).toBe(true);
  expect(app.texts()).toContain("Updating the Host to 0.9.1");
  expect(app.texts()).toContain("Backed up the data");
  expect(app.texts()).toContain("Restarting on 0.9.1");
  expect(app.texts()).toContain("Checking the new version");
});

test("a Host gone for five minutes is said to be not normal", async () => {
  const app = await settings("update", "Restarting@0,Gone@0");
  await app.clock!.runFor(4 * 60_000);
  expect(app.shows("text:This is taking longer than it should")).toBe(false);
  await app.clock!.runFor(61_000);
  expect(app.texts()).toContain("This is taking longer than it should");
  expect(app.texts()).toContain("The Host hasn't answered for 5 minutes.");
  expect(app.shows("label:Change host")).toBe(true);
});

test("a new version is said, then the window goes back to the app with a toast", async () => {
  const app = await settings(
    "update",
    "Restarting@0,Gone@0,Done@1000,Back@5000",
  );
  await app.clock!.runFor(1_100);
  expect(app.texts()).toContain("Updated to 0.9.1");
  expect(app.texts()).toContain("Reconnecting…");
  // Until the socket is open again the screen stays.
  await app.clock!.runFor(3_000);
  expect(app.shows("label:Host update in progress")).toBe(true);
  await app.clock!.runFor(2_200);
  expect(app.shows("label:Host update in progress")).toBe(false);
  expect(app.shows("id:toast")).toBe(true);
  expect(app.texts()).toContain("Updated to 0.9.1");
  expect(app.texts()).toContain("From 0.9.0. The data was backed up first.");
  // Settings itself keeps no notice of it, and the toast goes by itself.
  expect(app.shows("id:update-result")).toBe(false);
  await app.clock!.runFor(6_100);
  expect(app.texts()).not.toContain("Updated to 0.9.1");
});

test("rolling back is shown, then told once, then kept in Settings", async () => {
  const app = await settings("update", "Rolling back@0,Rolled back@1000");
  await app.clock!.runFor(10);
  expect(app.texts()).toContain(
    "The new version didn't hold. Putting 0.9.0 back.",
  );
  expect(app.texts()).toContain("Restoring 0.9.0 and its data");
  await app.clock!.runFor(1_000);
  expect(app.texts()).toContain("The update to 0.9.3 didn't hold");
  await app.press("label:Back to Eta");
  expect(app.shows("label:Host update in progress")).toBe(false);
  expect(app.texts()).toContain("Went back to 0.9.0");
  expect(app.texts()).toContain("0.9.3 didn't hold, so Eta went back to 0.9.0");
  expect(app.texts()).toContain(
    "0.9.3 did not hold (it exited after coming up)",
  );
});

test("a Host that needs a hand says what to do", async () => {
  const app = await settings("update", "Rolling back@0,Broken@1000");
  await app.clock!.runFor(1_100);
  expect(app.texts()).toContain("The Host needs a hand");
  expect(app.texts()).toContain(
    "The update to 0.9.3 failed, and putting 0.9.0 back failed too.",
  );
  expect(app.shows("label:Reconnect")).toBe(true);
  expect(app.shows("label:Change host")).toBe(true);
});

test("a failed, cancelled or lost update is explained in Settings with a next step", async () => {
  const app = await settings();
  await app.press("label:Failed");
  expect(app.shows("label:Host update in progress")).toBe(false);
  expect(app.texts()).toContain("Update failed");
  expect(app.texts()).toContain("The update to 0.9.5 failed. Nothing changed.");
  expect(app.shows("label:Try again")).toBe(true);

  await app.press("label:Cancelled");
  expect(app.texts()).toContain("Update cancelled");
  expect(app.texts()).toContain("Nothing changed. The Host stayed on 0.9.0.");
  expect(app.shows("label:Update to 0.9.1")).toBe(true);

  await app.press("label:Lost");
  expect(app.texts()).toContain("Update interrupted");
  expect(app.texts()).toContain("The update stopped partway");
});

test("a machine's row says it is updating, then a toast says it was updated", async () => {
  const app = await settings("machines");
  expect(app.texts()).toContain("Needs update");
  await app.press("label:Machine updating");
  expect(app.texts()).toContain("Updating to 0.9.0…");
  await app.press("label:Machine updated");
  expect(app.texts()).toContain("gpu-box updated to 0.9.0");
  expect(app.texts()).not.toContain("Updating to 0.9.0…");
  expect(app.texts()).not.toContain("Updated to 0.9.0");
});

test("a machine whose update failed says why and can try again", async () => {
  const app = await settings("machines");
  await app.press("label:Machine failed");
  expect(app.texts()).toContain("Update failed");
  expect(app.texts()).toContain(
    "it is not run by a service, so it cannot restart itself",
  );
  await app.press("label:Try again");
  expect(app.texts()).toContain("Sent: machines.upgrade");
});
