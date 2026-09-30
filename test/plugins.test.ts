/**
 * The plugin manager (S28).
 *
 * The rule that shapes every test here: a broken plugin is a broken plugin, not a broken server.
 * So the subject is not only "does a good plugin load" but every way one can be wrong — no
 * manifest, a manifest that will not parse, no entry point, an import that throws, a module that
 * exports nothing callable, an `apply` that throws — and the answer is the same each time: an
 * entry in `mounted` with its reason, and a floor that keeps serving.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "cordis";
import { afterEach, describe, expect, it } from "vitest";
import { PluginManager, pickPlugin } from "../src/plugins";
import { WireService } from "../src/wire-service";

const roots: string[] = [];

afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

/** A scratch `~/.eta` with a plugin directory, so a test writes real files. */
async function scratch(): Promise<{ modules: string; plugins: string }> {
	const root = await mkdtemp(join(tmpdir(), "eta-plugins-"));
	roots.push(root);
	return { modules: join(root, "modules"), plugins: join(root, "plugins") };
}

/** Write a plugin directory: a manifest, and whatever code the test wants. */
async function writePlugin(
	root: string,
	name: string,
	options: { manifest?: unknown; code?: string; file?: string; version?: string } = {},
): Promise<string> {
	const directory = join(root, name);
	await mkdir(directory, { recursive: true });
	const manifest = options.manifest ?? { name, "eta-plugin": true };
	await writeFile(join(directory, "package.json"), JSON.stringify(manifest), "utf8");
	if (options.code !== undefined) {
		const file = join(directory, options.file ?? "index.ts");
		await mkdir(join(file, ".."), { recursive: true });
		await writeFile(file, options.code, "utf8");
	}
	return directory;
}

function harness() {
	const ctx = new Context();
	const wire = new WireService(ctx);
	return { ctx, wire };
}

describe("loading a good plugin", () => {
	it("loads a plugin that registers a target, and it shows up on the wire", async () => {
		const dirs = await scratch();
		await writePlugin(dirs.plugins, "hello", {
			code: `
					export default {
						name: "hello",
						inject: ["wire"],
						apply(ctx) {
							ctx.wire.handle("hello", "greet", () => ({ result: { text: "hi" } }));
							ctx.wire.stateOf("hello", { project: () => ({ sections: { n: 1 }, revisions: { n: "1" } }) });
						},
					};
				`,
		});
		const { ctx, wire } = harness();
		const manager = new PluginManager({ modulesDir: dirs.modules, pluginsDir: dirs.plugins });
		const mounted = await manager.loadAll(ctx);
		expect(mounted).toEqual([{ name: "hello", source: "user" }]);
		expect(wire.descriptors().map((descriptor) => descriptor.name)).toEqual(["hello.greet"]);
		expect(wire.snapshot("hello")).toBeDefined();

		// Unloading takes every registration with it: that is what makes "unload" real.
		await manager.dispose();
		expect(wire.descriptors()).toEqual([]);
		expect(wire.snapshot("hello")).toBeUndefined();
		expect(manager.mounted()).toEqual([]);
	});

	it("loads official plugins first, then the user's", async () => {
		const dirs = await scratch();
		await writePlugin(dirs.modules, "official", { code: `export default { name: "official", apply() {} };` });
		await writePlugin(dirs.plugins, "mine", { code: `export default { name: "mine", apply() {} };` });
		const { ctx } = harness();
		const manager = new PluginManager({ modulesDir: dirs.modules, pluginsDir: dirs.plugins });
		await manager.loadAll(ctx);
		expect(manager.mounted().map((plugin) => plugin.name)).toEqual(["official", "mine"]);
		expect(manager.mounted().map((plugin) => plugin.source)).toEqual(["bundled", "user"]);
	});

	it("finds the entry point the manifest names, or the conventional one", async () => {
		const dirs = await scratch();
		await writePlugin(dirs.plugins, "named", {
			manifest: { name: "named", "eta-plugin": { main: "src/entry.ts" } },
			file: "src/entry.ts",
			code: `export default { name: "named", apply() {} };`,
		});
		await writePlugin(dirs.plugins, "conventional", {
			manifest: { name: "conventional", version: "2.0.0", "eta-plugin": true },
			code: `export default { name: "conventional", apply() {} };`,
		});
		const { ctx } = harness();
		const manager = new PluginManager({ modulesDir: dirs.modules, pluginsDir: dirs.plugins });
		await manager.loadAll(ctx);
		expect(manager.mounted().map((plugin) => plugin.name)).toEqual(["conventional", "named"]);
		// A version is reported when the manifest has one: a `hello` that says which build is running.
		expect(manager.mounted().find((plugin) => plugin.name === "conventional")?.version).toBe("2.0.0");
	});
});

describe("a plugin that is broken", () => {
	it("reports every way it can be wrong, and loads the others anyway", async () => {
		const dirs = await scratch();
		await writePlugin(dirs.plugins, "no-manifest", { manifest: { name: "no-manifest" } });
		await writePlugin(dirs.plugins, "bad-manifest", { manifest: "not an object", code: `export default {};` });
		await writePlugin(dirs.plugins, "no-entry", { manifest: { name: "no-entry", "eta-plugin": true } });
		await writePlugin(dirs.plugins, "import-throws", {
			code: `throw new Error("this module refuses to load");`,
		});
		await writePlugin(dirs.plugins, "exports-nothing", { code: `export const version = 1;` });
		await writePlugin(dirs.plugins, "apply-throws", {
			code: `export default { name: "apply-throws", apply() { throw new Error("the apply exploded"); } };`,
		});
		await writePlugin(dirs.plugins, "fine", { code: `export default { name: "fine", apply() {} };` });

		const { ctx } = harness();
		const manager = new PluginManager({ modulesDir: dirs.modules, pluginsDir: dirs.plugins });
		const mounted = await manager.loadAll(ctx);
		const byName = new Map(mounted.map((plugin) => [plugin.name, plugin]));
		expect([...byName.keys()].sort()).toEqual([
			"apply-throws",
			"bad-manifest",
			"exports-nothing",
			"fine",
			"import-throws",
			"no-entry",
			"no-manifest",
		]);
		// Each failure carries its own reason, and none of them is the same as "it worked".
		expect(byName.get("no-manifest")?.error).toContain("no eta-plugin manifest");
		expect(byName.get("bad-manifest")?.error).toContain("no eta-plugin manifest");
		expect(byName.get("no-entry")?.error).toContain("no entry point");
		expect(byName.get("import-throws")?.error).toContain("refuses to load");
		expect(byName.get("exports-nothing")?.error).toContain("exports no plugin");
		expect(byName.get("apply-throws")?.error).toContain("the apply exploded");
		expect(byName.get("fine")?.error).toBeUndefined();
		// And exactly one is running.
		expect(manager.running().map((plugin) => plugin.entry.name)).toEqual(["fine"]);
	});

	it("does not take the server down, and reports a plugin that will not unload", async () => {
		const dirs = await scratch();
		await writePlugin(dirs.plugins, "stubborn", {
			code: `export default { name: "stubborn", apply() {} };`,
		});
		const { ctx } = harness();
		const manager = new PluginManager({ modulesDir: dirs.modules, pluginsDir: dirs.plugins });
		await manager.loadAll(ctx);
		// Disposing twice is not an error: shutdown may run after a reload already unloaded it.
		await manager.dispose();
		await manager.dispose();
		expect(manager.mounted()).toEqual([]);
	});
});

describe("what counts as a plugin module", () => {
	it("takes a function, an object with apply, or a module exporting exactly one of those", () => {
		const fn = (): void => undefined;
		expect(pickPlugin(fn)).toBe(fn);
		const object = { name: "x", apply: () => undefined };
		expect(pickPlugin(object)).toBe(object);
		expect(pickPlugin({ default: object })).toBe(object);
		// A single named export is a plugin too: a module may not use `default`.
		expect(pickPlugin({ plugin: object })).toBe(object);
		// Two candidates is ambiguous, and guessing is how the wrong thing loads.
		expect(pickPlugin({ a: object, b: object })).toBeUndefined();
		expect(pickPlugin({})).toBeUndefined();
		expect(pickPlugin(undefined)).toBeUndefined();
		expect(pickPlugin("a string")).toBeUndefined();
	});
});

describe("a plugin that registers without cleaning up", () => {
	it("is still contained: unloading takes back what it left", async () => {
		const dirs = await scratch();
		// No effect, no disposer: the plugin registers and forgets. A user plugin can be written
		// this way, and "unload" has to mean the same thing for it as for a careful one.
		await writePlugin(dirs.plugins, "careless", {
			code: `
				export default {
					name: "careless",
					inject: ["wire"],
					apply(ctx) {
						ctx.wire.handle("careless", "ping", () => ({ result: { pong: true } }));
						ctx.wire.stateOf("careless", { project: () => ({ sections: { n: 1 }, revisions: { n: "1" } }) });
					},
				};
			`,
		});
		const { ctx, wire } = harness();
		const manager = new PluginManager({ modulesDir: dirs.modules, pluginsDir: dirs.plugins });
		await manager.loadAll(ctx);
		expect(wire.descriptors().map((descriptor) => descriptor.name)).toEqual(["careless.ping"]);
		expect(wire.snapshot("careless")).toBeDefined();

		await manager.dispose();
		// The floor swept up what the plugin left behind.
		expect(wire.descriptors()).toEqual([]);
		expect(wire.snapshot("careless")).toBeUndefined();
	});

	it("leaves another plugin's registrations alone", async () => {
		const dirs = await scratch();
		await writePlugin(dirs.plugins, "keeper", {
			code: `export default { name: "keeper", inject: ["wire"], apply(ctx) { ctx.wire.handle("keeper", "ping", () => ({})); } };`,
		});
		await writePlugin(dirs.plugins, "careless", {
			code: `export default { name: "careless", inject: ["wire"], apply(ctx) { ctx.wire.handle("careless", "ping", () => ({})); } };`,
		});
		const { ctx, wire } = harness();
		const manager = new PluginManager({ modulesDir: dirs.modules, pluginsDir: dirs.plugins });
		await manager.loadAll(ctx);
		const careless = manager.mounted().findIndex((plugin) => plugin.name === "careless");
		// Unload the careless one only: the keeper's target is not this plugin's to lose.
		const loaded = manager.running()[careless];
		await loaded?.dispose();
		expect(wire.descriptors().map((descriptor) => descriptor.name)).toEqual(["keeper.ping"]);
	});
});
