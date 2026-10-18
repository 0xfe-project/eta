import assert from "node:assert/strict";
import { plugin } from "bun";
plugin({
  name: "focused-entry-no-runtime",
  setup(build) {
    build.onLoad(
      { filter: /[/\\](kernel|cordis|pi-ai|testing|vitest|@vitest)[/\\]/ },
      ({ path }) => {
        throw new Error(
          `Focused entry loaded runtime or testing code: ${path}`,
        );
      },
    );
  },
});
const entry = await import(process.argv[2]);
assert.equal("Runner" in entry, false);
assert.equal("Kernel" in entry, false);
assert.equal(
  typeof entry[
    process.argv[2].endsWith("/session") ? "SessionLog" : "MemoryStorage"
  ],
  "function",
);
console.log("Focused entry import passed");
