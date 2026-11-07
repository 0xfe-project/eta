import type { ElectrobunConfig } from "electrobun";
import process from "node:process";
import { parseUpstream } from "@eta/releases";
import { buildVersion } from "./src/version";

// The repository the app downloads its host from (`src/bun/download.ts`), as the host's own build
// names the one it upgrades from: `release-desktop.yml` names its own, so a fork's app follows the
// fork. Read now: an app that cannot find a host would only find out on someone's computer.
const upstream = process.env.ETA_HOST_UPSTREAM?.trim();

export default {
  app: {
    name: "eta",
    identifier: "dev.eta.desktop",
    // From the `desktop-v*` tag in a release, package.json otherwise (`src/version.ts`).
    version: buildVersion(),
  },
  runtime: {
    // Closing the last window keeps the app (and its host) alive; Dock brings the window back.
    exitOnLastWindowClosed: false,
  },
  build: {
    mainProcess: "bun",
    bun: {
      entrypoint: "src/bun/index.ts",
      ...(upstream
        ? {
            define: {
              ETA_HOST_UPSTREAM: JSON.stringify(parseUpstream(upstream).api),
            },
          }
        : {}),
    },
    views: {
      mainview: {
        entrypoint: "src/mainview/index.ts",
      },
    },
    copy: {
      "src/mainview/index.html": "views/mainview/index.html",
      // The Windows window icon: `win.icon` below is what Explorer and the taskbar shortcut wear,
      // but the HWND of a running window needs its own copy, and the shell loads it out of the
      // bundle (`src/bun/platform/windows/icon.ts`) — a packaged app has no checkout to read.
      "Eta-Logo.ico": "views/mainview/Eta-Logo.ico",
      // No host: a packaged app downloads one the first time it runs it (`src/bun/download.ts`).
    },
    mac: {
      bundleCEF: false,
      // Nine PNGs; hutch runs `iconutil` over the folder and lands `AppIcon.icns` in the bundle's
      // Resources. Without it the app wears the runtime's generic icon in the Dock.
      icons: "icon.iconset",
    },
    linux: { bundleCEF: false },
    win: {
      bundleCEF: false,
      // Installer, shortcuts and taskbar. An ICO already carrying 16/32/48/256 needs no conversion;
      // a PNG here would be turned into one by hutch.
      icon: "Eta-Logo.ico",
    },
  },
} satisfies ElectrobunConfig;
