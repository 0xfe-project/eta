import assert from "node:assert/strict";
import { plugin } from "bun";

plugin({
	name: "reject-node-adapter",
	setup(build) {
		build.onLoad({ filter: /[/\\](eta-execution-node|testing|vitest|@vitest)[/\\]/ }, ({ path }) => {
			throw new Error(`Harness production import loaded adapter/test code: ${path}`);
		});
	},
});
const harness = await import("@eta/harness");
assert.equal(typeof harness.openSession, "function");
for (const name of ["NodeEnvironment", "NodeFileSystem", "NodeShell", "killProcessTree"]) {
	assert.equal(name in harness, false, `${name} belongs in @eta/execution-node`);
}
// Check harness-owned reachable modules with third-party dependencies external:
// third-party SDK platform internals are outside the adapter extraction.
const result = await Bun.build({
	entrypoints: [new URL("../src/index.ts", import.meta.url).pathname],
	target: "bun",
	packages: "external",
});
assert.equal(result.success, true, String(result.logs));
const output = await result.outputs[0].text();
assert.doesNotMatch(output, /(?:from|import)\s*["'](?:node:)?(?:fs(?:\/promises)?|child_process)["']/);
console.log("Harness production import passed");
