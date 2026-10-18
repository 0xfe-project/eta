import assert from "node:assert/strict";
import { plugin } from "bun";

// Run outside Vitest so test-runner globals cannot hide a production import leak.
plugin({
	name: "reject-test-dependencies",
	setup(build) {
		build.onLoad({ filter: /[/\\](testing|vitest|@vitest)[/\\]/ }, ({ path }) => {
			throw new Error(`Production import loaded a test dependency: ${path}`);
		});
	},
});

const core = await import("@eta/core");
assert.equal(typeof core.Kernel, "function");
assert.equal(typeof core.MemoryStorage, "function");
for (const name of ["fakeModels", "assistantMessage", "storageContract", "realModels", "selectProvider"]) {
	assert.equal(name in core, false, `${name} must stay in @eta/core/testing`);
}
console.log("Production import smoke passed");

for (const path of ["@eta/core/session", "@eta/core/storage"]) {
 const focused = await import(path);
 for (const [name, value] of Object.entries(focused)) assert.equal(core[name], value, `${name} root compatibility`);
}
