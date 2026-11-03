import assert from "node:assert/strict";
import { plugin } from "bun";

// The harness reaches the local disk through `node:fs` directly (skills, memory, the ESM
// realm), so that is no longer checked. What still must not leak into a production import
// is test code.
plugin({
  name: "reject-test-code",
  setup(build) {
    build.onLoad(
      { filter: /[/\\](testing|vitest|@vitest)[/\\]/ },
      ({ path }) => {
        throw new Error(`Harness production import loaded test code: ${path}`);
      },
    );
  },
});
const harness = await import("@eta/harness");
assert.equal(typeof harness.openSession, "function");
const result = await Bun.build({
  entrypoints: [new URL("../src/index.ts", import.meta.url).pathname],
  target: "bun",
  packages: "external",
});
assert.equal(result.success, true, String(result.logs));
console.log("Harness production import passed");
