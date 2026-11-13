import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // These tests start real hosts and spawn processes; `bun run check` runs every package's
    // tests at once, and on a loaded machine the default 5s cuts off tests that are only slow.
    testTimeout: 30_000,
    // Cleaning up after a host can wait for Windows to let go of the files it held; under the
    // same load the default 10s cuts off an afterEach that is only slow.
    hookTimeout: 30_000,
  },
});
