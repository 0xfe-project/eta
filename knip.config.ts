import type { KnipConfig } from "knip";

// Dead code check for the TypeScript workspaces (`turbo run knip`). The Python
// sidecar only uses package.json for Turbo scripts.
export default {
  // System tools the scripts call (uv for the Python sidecar, hdiutil and ditto on macOS).
  ignoreBinaries: ["uv", "hutch", "nsh", "hdiutil", "ditto"],
  // `packages/TOBEREFR` holds plugins parked until the ESM rework is done (TODO.md there).
  ignore: [".eta/**", "**/test/**/fixtures/**", "packages/TOBEREFR/**"],
  // CSS files are part of the module graph: their @imports reference
  // packages (fonts, tw-animate-css, shadcn) and other stylesheets.
  compilers: {
    css: (text: string) =>
      [...text.matchAll(/@import\s+(?:url\()?["']([^"']+)["']/g)]
        .map(([, specifier]) => `import "${specifier}";`)
        .join("\n"),
  },
  // Re-exports and plugin-facing API of the eta packages that nothing in this
  // repository imports yet; the host and the plugins consume them later.
  ignoreIssues: {
    "packages/eta-core/src/types/events.ts": ["types"],
    "packages/eta-harness/src/skills.ts": ["exports"],
    "packages/eta-harness/src/tools/edit.ts": ["exports"],
    "packages/eta-server/src/bundled/providers.ts": ["exports"],
    "packages/eta-server/src/bundled/sessions.ts": ["types"],
    "packages/eta-server/src/transport.ts": ["exports"],
  },
  workspaces: {
    // Run by the upgrade workflows, and `drive.ts` starts the servers as files.
    ".": {
      entry: ["scripts/upgrade-e2e/*.ts"],
      // Installed by that workflow for its run, to press the real button.
      ignoreDependencies: ["playwright-core"],
    },
    // `apps/eta/scripts/embed.ts` writes the import of this into a compiled host's entry.
    "apps/daemon": {
      entry: ["src/windows-shell.ts"],
    },
    // The eta packages are libraries read straight from source (package.json
    // `exports` and `main` point at src/index.ts and the `testing` subpaths,
    // which knip takes as entries). What they export beyond that is the
    // surface later steps consume, so an export used inside its own file is
    // not dead.
    "packages/{eta-*,client-*}": {
      ignoreExportsUsedInFile: true,
    },
    "packages/client-contracts": {
      // A browser-side consumer, typechecked on its own to prove the client
      // contracts need nothing but the wire package; nothing imports it.
      entry: ["test/browser-consumer.ts"],
    },
    "apps/web": {
      // routeTree.gen.ts is gitignored, which knip skips, so the file routes
      // are entries themselves. public/sw.js is registered by URL in
      // main.tsx.
      entry: ["src/routes/**/*.{ts,tsx}", "public/sw.js"],
      // The router plugin writes it during vite build, which turbo may not
      // have run (or finished) when knip starts.
      ignoreUnresolved: ["./routeTree.gen"],
      // Generated from the shadcn registry; unused exports there are
      // expected.
      ignore: ["src/components/ui/**"],
    },
    "apps/mobile": {
      // `nsh` builds it: the entries are named in its commands.
      entry: ["App.tsx", "DevApp.tsx", "src/**/*.test.tsx"],
      // The Native Shell runtime provides them; nothing installs them.
      ignoreDependencies: ["nsh", "websocket"],
    },
    "apps/desktop": {
      // Electrobun reads the configs by path and bundles both processes from
      // their entrypoints; nothing imports them. release-desktop.yml runs try-app.
      entry: [
        "electrobun.config.ts",
        "hutch.config.ts",
        "scripts/try-app.ts",
        "src/bun/index.ts",
        "src/mainview/index.ts",
      ],
      // Loading vitest.config.mts reads tsconfig.json, which extends what `electrobun prepare`
      // makes, and a clean checkout has not run that: name the tests instead.
      vitest: { config: [], entry: ["vitest.config.mts", "test/**/*.test.ts"] },
    },
  },
} satisfies KnipConfig;
