import { expect, open, test } from "nsh/test";
import { flatpakBundleUrl, isFlatpakRuntime } from "../src/services/flatpak";

const fixture = "./fixtures/flatpak-client.tsx";

const flatpakUpdaterModule = (opened: string[]) => ({
  nsh: {
    openUrl: (url: string) => {
      opened.push(url);
      return { opened: true };
    },
  },
  "nsh/updater": {
    shellInfo: {
      version: "1.2.0",
      build: 1,
      nshVersion: "0.7.1",
      packages: false,
    },
    checkForUpdate: () => ({
      version: "1.3.0",
      url: "https://github.com/0xfe-project/eta/releases/download/desktop-v1.3.0/Eta-1.3.0-linux-x86_64.tar.gz",
      canInstall: true,
      shell: false,
    }),
  },
});

test("detects Flatpak from FLATPAK_ID or /app bundle URL only on Linux", () => {
  expect(isFlatpakRuntime("linux", { FLATPAK_ID: "dev.eta.client" })).toBe(
    true,
  );
  expect(
    isFlatpakRuntime(
      "linux",
      {},
      "file:///app/lib/dev.eta.client/nsh/bundle.nshc",
    ),
  ).toBe(true);
  expect(isFlatpakRuntime("linux", {}, "file:///opt/Eta/nsh/bundle.nshc")).toBe(
    false,
  );
  expect(
    isFlatpakRuntime(
      "macos",
      { FLATPAK_ID: "dev.eta.client" },
      "file:///app/lib/dev.eta.client/nsh/bundle.nshc",
    ),
  ).toBe(false);
});

test("rewrites Linux update archive URLs to the sibling Flatpak bundle", () => {
  expect(
    flatpakBundleUrl(
      "https://github.com/0xfe-project/eta/releases/download/desktop-v1.3.0/Eta-1.3.0-linux-x86_64.tar.gz",
    ),
  ).toBe(
    "https://github.com/0xfe-project/eta/releases/download/desktop-v1.3.0/eta-desktop-linux-x64.flatpak",
  );
  expect(flatpakBundleUrl("https://example.invalid/custom-release")).toBe(
    "https://example.invalid/custom-release",
  );
});

test("disables Run on this computer and pre-selects connecting to an existing host in Flatpak", async () => {
  const app = await open(fixture, {
    width: 1440,
    height: 900,
    locale: "en-US",
    platform: "linux",
    storage: { page: "connection" },
  });
  await app.waitFor("text:Where should eta run?");
  expect(app.enabled("label:Run on this computer")).toBe(false);
  expect(app.shows("text:/Unavailable inside Flatpak/")).toBe(true);
  expect(app.shows("text:/Install eta-host on your host OS/")).toBe(true);
  expect(app.shows("label:Connect")).toBe(true);
});

test("shows Flatpak update guidance and opens the .flatpak bundle from Settings", async () => {
  const opened: string[] = [];
  const app = await open(fixture, {
    width: 1440,
    height: 900,
    locale: "en-US",
    platform: "linux",
    storage: { page: "update-settings" },
    modules: flatpakUpdaterModule(opened),
    clock: {},
  });
  await app.waitFor("label:Download Flatpak");
  expect(app.shows("text:Desktop app · Flatpak")).toBe(true);
  expect(app.shows("text:/Single-file Flatpak bundles/")).toBe(true);
  expect(app.shows("label:Download APK")).toBe(false);

  await app.press("label:Download Flatpak");
  await app.waitUntil(() => opened.length === 1);
  expect(opened).toEqual([
    "https://github.com/0xfe-project/eta/releases/download/desktop-v1.3.0/eta-desktop-linux-x64.flatpak",
  ]);
});

test("shows Flatpak update notice copy and opens the .flatpak bundle from the banner", async () => {
  const opened: string[] = [];
  const app = await open(fixture, {
    width: 1440,
    height: 900,
    locale: "en-US",
    platform: "linux",
    storage: { page: "update-notice" },
    modules: flatpakUpdaterModule(opened),
    clock: {},
  });
  await app.waitFor("label:Download Flatpak");
  expect(
    app.shows(
      "text:/Download the new Flatpak and install it with flatpak install --user/",
    ),
  ).toBe(true);
  expect(app.shows("text:/needs a new APK/")).toBe(false);

  await app.press("label:Download Flatpak");
  await app.waitUntil(() => opened.length === 1);
  expect(opened).toEqual([
    "https://github.com/0xfe-project/eta/releases/download/desktop-v1.3.0/eta-desktop-linux-x64.flatpak",
  ]);
});
