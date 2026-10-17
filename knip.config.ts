import type { KnipConfig } from "knip";

// Dead code check for the TypeScript workspaces (`turbo run knip`).
export default {
  ignoreDependencies: [],
  // CSS files are part of the module graph: their @imports reference
  // packages (fonts, tw-animate-css, shadcn) and other stylesheets.
  compilers: {
    css: (text: string) =>
      [...text.matchAll(/@import\s+(?:url\()?["']([^"']+)["']/g)]
        .map(([, specifier]) => `import "${specifier}";`)
        .join("\n"),
  },
  workspaces: {
    "packages/eta-core": {
      // types/events.ts ends in a compile-time lock (_VocabularyMatches): its consumer is
      // the compiler, not an import, so knip would flag it forever. The rest of that file is
      // type declarations for the kernel's event vocabulary.
      ignore: ["src/types/events.ts"],
    },
    "apps/web": {
      // routeTree.gen.ts is gitignored, which knip skips, so the file routes
      // are entries themselves. public/sw.js is registered by URL in
      // main.tsx.
      entry: ["src/routes/**/*.{ts,tsx}", "public/sw.js"],
      // Generated code: the shadcn registry, and the API contracts' type files
      // (redocly.yaml). Unused exports there are expected — a document
      // describes every route, a client imports only what it calls.
      ignore: ["src/components/ui/**", "src/api/*.gen.ts"],
      ignoreUnresolved: [],
    },
  },
} satisfies KnipConfig;
