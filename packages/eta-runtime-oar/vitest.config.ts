import process from "node:process";
import { defineConfig } from "vitest/config";
import { forceRerunTriggers } from "../../vitest.shared.ts";

export default defineConfig({
  test: {
    forceRerunTriggers,
    testTimeout: process.platform === "win32" ? 15_000 : 5_000,
  },
});
