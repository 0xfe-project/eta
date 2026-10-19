import { defineConfig } from "@rstest/core";

export default defineConfig({
  include: ["src/**/*.test.{ts,tsx}"],
  testEnvironment: "happy-dom",
  // Rendering tests are fast alone, but `bun run check` runs every package's tests at once, and on
  // a loaded machine the default 5s cut off tests that were only slow.
  testTimeout: 20_000,
  setupFiles: ["./src/test-setup.ts"],
  source: { define: { __ETA_BUILD__: JSON.stringify("test") } },
  tools: {
    swc: { jsc: { transform: { react: { runtime: "automatic" } } } },
  },
});
