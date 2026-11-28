import process from "node:process";
import { defineConfig } from "vitest/config";
import { forceRerunTriggers } from "../../vitest.shared.ts";

export default defineConfig({
  // Resolve TypeScript settings from this package for every file a test imports. Without it, a
  // test that imports apps/client source (trigger-catalog-text) looks up apps/client/tsconfig.json,
  // which extends .nsh/tsconfig.json, a file nsh generates and CI does not have when this runs.
  tsconfig: "./tsconfig.json",
  test: {
    forceRerunTriggers,
    // These tests start real hosts, spawn processes and walk directories. Alone each takes well
    // under a second, but `bun run check` runs every package's tests at once, and on a loaded
    // machine a tighter timeout cuts off tests that are only slow.
    testTimeout: process.platform === "win32" ? 60_000 : 20_000,
    // Git setup and Windows EBUSY cleanup in beforeEach/afterEach can exceed Vitest's 10s hook default under `bun run check`.
    ...(process.platform === "win32" ? { hookTimeout: 60_000 } : {}),
  },
});
