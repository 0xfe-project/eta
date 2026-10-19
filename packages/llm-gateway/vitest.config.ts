import { defineConfig } from "vitest/config";

// The library loads once per process, so every test file gets a process of its own.
export default defineConfig({
  test: { pool: "forks", testTimeout: 60_000 },
});
