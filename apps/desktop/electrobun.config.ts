import type { ElectrobunConfig } from "electrobun";

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
    },
    mac: { bundleCEF: false },
    linux: { bundleCEF: false },
    win: { bundleCEF: false },
  },
} satisfies ElectrobunConfig;
