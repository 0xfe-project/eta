import type { Plugin } from "vite";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { forceRerunTriggers } from "../../vitest.shared.ts";

// Not vite.config.ts: the tests need none of its plugins (the router plugin writes
// routeTree.gen.ts, Tailwind, the React Compiler), and its config reads the environment.
export default defineConfig({
  plugins: [
    {
      // Tests read index.html and styles.css with `new URL("…", import.meta.url)`. In a DOM
      // environment Vite (asset URLs) and Vitest (normalize-url) rewrite that into a page address,
      // http://localhost:3000/…, as they would for a browser, and readFileSync refuses it. Without
      // the two it stays the file, as it did under rstest.
      name: "eta:keep-import-meta-url",
      configResolved(config) {
        const plugins = config.plugins as Plugin[];
        for (const name of [
          "vite:asset-import-meta-url",
          "vitest:normalize-url",
        ]) {
          const index = plugins.findIndex((plugin) => plugin.name === name);
          if (index !== -1) plugins.splice(index, 1);
        }
      },
    },
  ],
  define: { __ETA_BUILD__: JSON.stringify("test") },
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    forceRerunTriggers,
    include: ["src/**/*.test.{ts,tsx}"],
    environment: "happy-dom",
    setupFiles: ["./src/test-setup.ts"],
    // Rendering tests are fast alone, but `bun run check` runs every package's tests at once, and
    // on a loaded machine the default 5s cut off tests that were only slow.
    testTimeout: 20_000,
    // Vitest empties every CSS import unless told otherwise; `styles.css?raw` is read as text
    // (Vite does not process it), so let it through.
    css: { include: [/\.css\?raw$/] },
  },
});
