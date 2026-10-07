import { defineConfig } from "@rstest/core";

export default defineConfig({
  include: ["src/**/*.test.{ts,tsx}"],
  testEnvironment: "happy-dom",
});
