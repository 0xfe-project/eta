import { defineConfig } from "vitest/config";
import { forceRerunTriggers } from "../../vitest.shared.ts";

export default defineConfig({
  // The tsconfig extends what `electrobun prepare` generates, a 300MB download the tests have no
  // use for; these sources need none of it to be stripped of their types.
  oxc: { tsconfig: false },
  // `.hutch` holds Electrobun's own sources, tests included.
  test: { include: ["test/**/*.test.ts"], forceRerunTriggers },
});
