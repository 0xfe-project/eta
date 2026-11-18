import { defineConfig } from "vitest/config";
import { forceRerunTriggers } from "../../vitest.shared.ts";

export default defineConfig({
  test: {
    forceRerunTriggers,
    // These tests start real hosts, spawn processes and walk directories. Alone each takes well
    // under a second, but `bun run check` runs every package's tests at once, and on a loaded
    // machine the default 5s cut off tests that were only slow.
    testTimeout: 20_000,
  },
});
