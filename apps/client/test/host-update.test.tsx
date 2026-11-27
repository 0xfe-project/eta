import type { OpenOptions, Platform } from "nsh/test";
import { expect, open, test } from "nsh/test";

// A Host update as the user follows it: Settings › Update says what is happening at each step,
// the whole window is covered from the moment the service stops, and the end is told, with
// what to do next when it did not work. Machines › gpu-box says the same of a daemon's update.

const fixture = "./fixtures/host-update.tsx";

async function settings(
  page = "update",
  script = "",
  options: {
    size?: { width: number; height: number };
    platform?: Platform;
    prereleaseDelay?: number;
    prereleaseFailure?: boolean;
    checks?: boolean;
    checkFailure?: boolean;
    switchChannel?: boolean;
    fresh?: boolean;
    offline?: boolean;
    modules?: OpenOptions["modules"];
    ready?: string;
  } = {},
) {
  const app = await open(fixture, {
    width: options.size?.width ?? 1440,
    height: options.size?.height ?? 900,
    locale: "en-US",
    platform: options.platform ?? "web",
    storage: {
      page,
      script,
      prereleaseDelay: String(options.prereleaseDelay ?? 0),
      prereleaseFailure: String(!!options.prereleaseFailure),
      checks: String(!!options.checks),
      checkFailure: String(!!options.checkFailure),
      switchChannel: String(!!options.switchChannel),
      fresh: String(!!options.fresh),
      offline: String(!!options.offline),
    },
    modules: options.modules,
    clock: {},
  });
  await app.waitFor(
    options.ready ?? (page === "update" ? "text:0.9.0" : "text:gpu-box"),
  );
  return app;
}

/** A release build of the desktop app. */
const desktopApp = {
  platform: "macos",
  modules: {
    "nsh/updater": {
      shellInfo: {
        version: "1.2.0",
        build: 1,
        nshVersion: "0.7.1",
        packages: false,
      },
    },
  },
} as const;

test("before the first answer both rows are there, the Host's without a version yet", async () => {
  const app = await settings("update", "", {
    ...desktopApp,
    fresh: true,
    checks: true,
    ready: "text:Desktop app · this computer",
  });
  expect(app.texts()).toContain("—");
  expect(app.texts()).toContain("eta host · this server");
  expect(app.texts()).toContain("1.2.0");
  expect(app.texts()).toContain("Checking…");

  await app.press("label:Answer");
  await app.waitFor("text:0.9.0");
  expect(app.texts()).toContain("Desktop app · this computer");
});

test("checking again keeps both rows, both say they are checking, and the Host's channel stays open", async () => {
  const app = await settings("update", "", {
    ...desktopApp,
    checks: true,
  });
  await app.press("label:Answer");
  await app.press("label:Check again");

  expect(app.texts().filter((text) => text === "Checking…")).toHaveLength(2);
  expect(app.texts()).toContain("0.9.0");
  expect(app.texts()).toContain("1.2.0");
  expect(app.texts()).toContain("Check again");
  expect(app.enabled("label:Channel")).toBe(true);
  expect(app.enabled("label:App update channel")).toBe(true);
});

test("a channel chosen during a check is saved once the check has answered", async () => {
  const app = await settings("update", "", { checks: true });
  await app.press("label:Channel");
  await app.press("label:Pre-releases too");
  expect(app.texts()).toContain("Sent: upgrade.check");

  expect(app.shows("text:Pre-releases too")).toBe(true);

  await app.press("label:Answer");
  await app.waitFor(
    "text:Sent: upgrade.check, upgrade.setPrerelease, upgrade.check",
  );
  await app.press("label:Answer");
  expect(app.shows("text:Pre-releases too")).toBe(true);
});

test("a first check that fails says so in the Host's row", async () => {
  const app = await settings("update", "", {
    fresh: true,
    checks: true,
    checkFailure: true,
    ready: "text:Checking…",
  });
  await app.press("label:Answer");
  await app.waitFor("text:Couldn't check for updates");
  expect(app.texts()).toContain("GitHub did not answer");
  expect(app.texts()).toContain("—");
  expect(app.texts()).not.toContain("Up to date");
});

test("the desktop app's channel changed during its check is checked again", async () => {
  const channels: string[] = [];
  const app = await settings("update", "", {
    platform: "macos",
    modules: {
      "nsh/updater": {
        ...desktopApp.modules["nsh/updater"],
        checkForUpdate: (options?: { channel?: string }) => {
          channels.push(options?.channel ?? "");
          return options?.channel === "rc"
            ? {
                version: "1.3.0-rc.1",
                url: "https://example.invalid/eta.dmg",
                canInstall: true,
                shell: false,
              }
            : null;
        },
      },
    },
    switchChannel: true,
    ready: "label:Download update",
  });
  expect(channels).toEqual(["stable", "rc"]);
  expect(app.texts()).not.toContain("Up to date");
});

test("a Host that is not connected keeps its row, says so and offers another", async () => {
  const app = await settings("update", "", {
    fresh: true,
    offline: true,
    ready: "text:Not connected",
  });
  expect(app.texts()).toContain("—");
  expect(app.shows("label:Change host")).toBe(true);
  expect(app.enabled("label:Channel")).toBe(false);
});

test("which versions explains the channels before either menu", async () => {
  const app = await settings("update", "", desktopApp);
  const explanation = app.layout(
    "text:Pre-releases (-rc, -beta...) get new features earlier and can be unstable. Switching back never goes to an older version.",
  )!;
  expect(explanation.y).toBeLessThan(app.layout("label:Channel")!.y);
  expect(explanation.y).toBeLessThan(app.layout("label:App update channel")!.y);
});

test("the update channel uses the shared action menu", async () => {
  const app = await settings();
  expect(app.layout("label:Channel")!.height).toBe(32);
  await app.press("label:Channel");
  await app.waitFor("label:Pre-releases too");
});

for (const platform of ["android", "web"] as const) {
  test(`choosing a channel in the ${platform} phone sheet closes it`, async () => {
    const app = await settings("update", "", {
      size: { width: 390, height: 844 },
      platform,
    });
    await app.press("label:Channel");
    await app.waitFor("label:Pre-releases too");
    expect(app.shows("id:menu-grabber")).toBe(true);
    expect(app.layout("id:menu-grabber")!.y).toBeLessThanOrEqual(500);

    await app.press("label:Pre-releases too");

    await app.waitFor("text:Sent: upgrade.setPrerelease");
    await app.waitUntil(() => !app.shows("label:Pre-releases too"));
    await app.clock!.runFor(1_000);
    expect(app.shows("label:Pre-releases too")).toBe(false);
  });
}

for (const platform of ["linux", "windows", "web"] as const) {
  test(`choosing a channel in the ${platform} desktop popup closes it`, async () => {
    const app = await settings("update", "", {
      platform,
      prereleaseDelay: 1_000,
    });
    await app.press("label:Channel");
    await app.waitFor("label:Pre-releases too");
    expect(app.shows("id:menu-grabber")).toBe(false);

    await app.press("label:Pre-releases too");

    await app.waitUntil(() => !app.shows("label:Pre-releases too"));
    await app.clock!.runFor(1_000);
    expect(app.shows("label:Pre-releases too")).toBe(false);
  });
}

test("a channel choice shows before the Host answers", async () => {
  const app = await settings("update", "", { prereleaseDelay: 1_000 });
  await app.press("label:Channel");
  await app.press("label:Pre-releases too");
  await app.waitUntil(() => !app.shows("label:Pre-releases too"));
  await app.clock!.runFor(16);

  expect(app.shows("text:Pre-releases too")).toBe(true);
  await app.clock!.runFor(1_000);
  expect(app.shows("text:Pre-releases too")).toBe(true);
});

test("a failed channel save restores the old choice", async () => {
  const app = await settings("update", "", {
    prereleaseDelay: 1_000,
    prereleaseFailure: true,
  });
  await app.press("label:Channel");
  await app.press("label:Pre-releases too");
  await app.waitUntil(() => !app.shows("label:Pre-releases too"));
  await app.clock!.runFor(16);

  expect(app.shows("text:Pre-releases too")).toBe(true);
  await app.clock!.runFor(1_000);
  await app.waitFor("text:The Host rejected the channel change");
  expect(app.shows("text:Pre-releases too")).toBe(false);
  expect(app.shows("text:Full releases only")).toBe(true);
});

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
