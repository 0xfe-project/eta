import type { KnipConfig } from "knip";

// Dead code check for the TypeScript workspaces (`turbo run knip`). The Python
// sidecar only uses package.json for Turbo scripts.
export default {
  // System tools the scripts call (uv for the Python sidecar).
  ignoreBinaries: ["uv", "nsh"],
  // `packages/TOBEREFR` holds plugins parked until the ESM rework is done (TODO.md there).
  ignore: ["**/test/**/fixtures/**", "packages/TOBEREFR/**"],
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
    // The design tokens (#356): the client moves onto them batch by batch, so most are not
    // imported yet.
    "apps/client/src/components/tokens.ts": ["exports", "types"],
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
      entry: [
        "scripts/upgrade-e2e/*.ts",
        "scripts/nsh-host-bootstrap.ts",
        "scripts/host-launcher/test/*.test.ts",
      ],
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
    "apps/tui": {
      // extensions.gen.ts is gitignored, which knip skips, so the feature
      // modules it imports are entries themselves, and so are the scripts
      // package.json runs.
      entry: ["src/ext/*.{ts,tsx}", "src/ext/*/index.{ts,tsx}", "scripts/*.ts"],
      // A feature's message catalog is exported for the test that checks
      // both languages, and used in its own file.
      ignoreExportsUsedInFile: true,
      // scripts/gen-extensions.ts writes it before every build, test and
      // typecheck, which turbo may not have run when knip starts.
      ignoreUnresolved: [
        "./extensions.gen",
        "../src/extensions.gen",
        "../../src/extensions.gen",
      ],
      // tsconfig.json's paths load it in place of highlight.js's own
      // declarations; no module imports it by its path.
      ignore: ["types/highlight.js.d.ts"],
    },
    "apps/client": {
      entry: [
        "App.tsx",
        "test/**/*.test.{ts,tsx}",
        "test/composer-fixture.tsx",
        "test/fixtures/*.tsx",
      ],
      ignoreDependencies: [
        // The Native Shell runtime provides them; nothing installs them.
        "nsh",
        "websocket",
        // scripts/nsh-client.ts stages these packages as bundled WebView assets.
        "es-module-lexer",
        "html2canvas-pro",
        "jsqr",
      ],
    },
    "apps/mobile": {
      // `nsh` builds it: the entries are named in its commands.
      entry: ["App.tsx", "DevApp.tsx", "src/**/*.test.tsx"],
      // The Native Shell runtime provides them; nothing installs them.
      ignoreDependencies: ["nsh", "websocket"],
    },
  },
} satisfies KnipConfig;
