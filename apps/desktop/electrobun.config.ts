import type { ElectrobunConfig } from "electrobun";
import { existsSync } from "node:fs";

export default {
  app: {
    name: "eta",
    identifier: "dev.eta.desktop",
    version: "0.1.0",
  },
  runtime: {
    // Closing the last window keeps the app (and its host) alive; Dock brings the window back.
    exitOnLastWindowClosed: false,
  },
  build: {
    mainProcess: "bun",
    bun: {
      entrypoint: "src/bun/index.ts",
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
      // The host the app carries, one executable (`scripts/stage-host.ts`; `bun run package`
      // stages it first).
      // Without it the app runs the host out of the checkout it was built in, as dev does. Found
      // from this file: hutch does not load the config from this directory.
      ...(existsSync(new URL("dist/host/eta-host", import.meta.url))
        ? { "dist/host": "host" }
        : {}),
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
