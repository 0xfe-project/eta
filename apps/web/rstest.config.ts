import { defineConfig } from "@rstest/core";

export default defineConfig({
  include: ["src/**/*.test.{ts,tsx}"],
  testEnvironment: "happy-dom",
  source: { define: { __AXP_BUILD__: JSON.stringify("test") } },
  tools: {
    swc: { jsc: { transform: { react: { runtime: "automatic" } } } },
  },
});
