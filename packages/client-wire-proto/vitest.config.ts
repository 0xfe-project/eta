import { defineConfig } from "vitest/config";
import { forceRerunTriggers } from "../../vitest.shared.ts";

export default defineConfig({ test: { forceRerunTriggers } });
