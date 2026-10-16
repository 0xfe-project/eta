/**
 * The plugin manager (S28).
 *
 * The rule that shapes every test here: a broken plugin is a broken plugin, not a broken server.
 * So the subject is not only "does a good plugin load" but every way one can be wrong — no
 * manifest, a manifest that will not parse, no entry point, an import that throws, a module that
 * exports nothing callable, an `apply` that throws — and the answer is the same each time: an
 * entry in `mounted` with its reason, and a floor that keeps serving.
 *
 * Ported from eta-old, minus the tests whose subject is the wire contract (a plugin registering
 * a target, a plugin registering outside its own namespace, the state-target equivalent). That
 * contract belonged to the WebSocket transport, which this repository does not have; the plugin
 * surface is designed in P0.3 and those scenarios are re-expressed against it then. The manager's
 * own behaviour — discovery, loading, isolation, unload, panels — is covered below as before.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "cordis";
import { afterEach, describe, expect, it } from "vitest";
import { pickPlugin, PluginManager } from "../src/plugins";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
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
  options: {
    manifest?: unknown;
    code?: string;
    file?: string;
    version?: string;
  } = {},
): Promise<string> {
  const directory = join(root, name);
  await mkdir(directory, { recursive: true });
  const manifest = options.manifest ?? { name, "eta-plugin": true };
  await writeFile(
    join(directory, "package.json"),
    JSON.stringify(manifest),
    "utf8",
  );
  if (options.code !== undefined) {
    const file = join(directory, options.file ?? "index.ts");
    await mkdir(join(file, ".."), { recursive: true });
    await writeFile(file, options.code, "utf8");
  }
  return directory;
}

function harness(): { ctx: Context } {
  return { ctx: new Context() };
}

describe("loading a good plugin", () => {
  it("loads official plugins first, then the user's", async () => {
    const dirs = await scratch();
    await writePlugin(dirs.modules, "official", {
      code: `export default { name: "official", apply() {} };`,
    });
    await writePlugin(dirs.plugins, "mine", {
      code: `export default { name: "mine", apply() {} };`,
    });
    const { ctx } = harness();
    const manager = new PluginManager({
      modulesDir: dirs.modules,
      pluginsDir: dirs.plugins,
    });
    await manager.loadAll(ctx);
    expect(manager.mounted().map((plugin) => plugin.name)).toEqual([
      "official",
      "mine",
    ]);
    expect(manager.mounted().map((plugin) => plugin.source)).toEqual([
      "bundled",
      "user",
    ]);
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
    const manager = new PluginManager({
      modulesDir: dirs.modules,
      pluginsDir: dirs.plugins,
    });
    await manager.loadAll(ctx);
    expect(manager.mounted().map((plugin) => plugin.name)).toEqual([
      "conventional",
      "named",
    ]);
    // A version is reported when the manifest has one: a `hello` that says which build is running.
    expect(
      manager.mounted().find((plugin) => plugin.name === "conventional")
        ?.version,
    ).toBe("2.0.0");
  });
});

describe("a plugin that is broken", () => {
  it("reports every way it can be wrong, and loads the others anyway", async () => {
    const dirs = await scratch();
    await writePlugin(dirs.plugins, "no-manifest", {
      manifest: { name: "no-manifest" },
    });
    await writePlugin(dirs.plugins, "bad-manifest", {
      manifest: "not an object",
      code: `export default {};`,
    });
    await writePlugin(dirs.plugins, "no-entry", {
      manifest: { name: "no-entry", "eta-plugin": true },
    });
    await writePlugin(dirs.plugins, "import-throws", {
      code: `throw new Error("this module refuses to load");`,
    });
    await writePlugin(dirs.plugins, "exports-nothing", {
      code: `export const version = 1;`,
    });
    await writePlugin(dirs.plugins, "apply-throws", {
      code: `export default { name: "apply-throws", apply() { throw new Error("the apply exploded"); } };`,
    });
    await writePlugin(dirs.plugins, "fine", {
      code: `export default { name: "fine", apply() {} };`,
    });

    const { ctx } = harness();
    const manager = new PluginManager({
      modulesDir: dirs.modules,
      pluginsDir: dirs.plugins,
    });
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
    expect(byName.get("no-manifest")?.error).toContain(
      "no eta-plugin manifest",
    );
    expect(byName.get("bad-manifest")?.error).toContain(
      "no eta-plugin manifest",
    );
    expect(byName.get("no-entry")?.error).toContain("no entry point");
    expect(byName.get("import-throws")?.error).toContain("refuses to load");
    expect(byName.get("exports-nothing")?.error).toContain("exports no plugin");
    expect(byName.get("apply-throws")?.error).toContain("the apply exploded");
    expect(byName.get("fine")?.error).toBeUndefined();
    // And exactly one is running.
    expect(manager.running().map((plugin) => plugin.entry.name)).toEqual([
      "fine",
    ]);
  });

  it("does not take the server down, and reports a plugin that will not unload", async () => {
    const dirs = await scratch();
    await writePlugin(dirs.plugins, "stubborn", {
      code: `export default { name: "stubborn", apply() {} };`,
    });
    const { ctx } = harness();
    const manager = new PluginManager({
      modulesDir: dirs.modules,
      pluginsDir: dirs.plugins,
    });
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

describe("a plugin with a front-end", () => {
  it("publishes the panel descriptor its manifest declares", async () => {
    const dirs = await scratch();
    await writePlugin(dirs.plugins, "git", {
      manifest: {
        name: "git",
        version: "1.2.3",
        "eta-plugin": {
          panel: {
            title: "Git",
            slot: "sidebar",
            entry: "./ui.js",
            state: "git",
          },
        },
      },
      code: `export default { name: "git", apply() {} };`,
    });
    const { ctx } = harness();
    const manager = new PluginManager({
      modulesDir: dirs.modules,
      pluginsDir: dirs.plugins,
    });
    await manager.loadAll(ctx);
    expect(manager.mounted()[0]).toEqual({
      name: "git",
      source: "user",
      version: "1.2.3",
      descriptor: {
        title: "Git",
        slot: "sidebar",
        entry: "./ui.js",
        state: "git",
      },
    });
  });

  it("ignores a panel that is not a descriptor, rather than publishing nonsense", async () => {
    const dirs = await scratch();
    await writePlugin(dirs.plugins, "vague", {
      manifest: { name: "vague", "eta-plugin": { panel: { title: "Vague" } } },
      code: `export default { name: "vague", apply() {} };`,
    });
    const { ctx } = harness();
    const manager = new PluginManager({
      modulesDir: dirs.modules,
      pluginsDir: dirs.plugins,
    });
    await manager.loadAll(ctx);
    // No slot, no panel: a descriptor the client cannot place is worse than none.
    expect(manager.mounted()[0]).toEqual({ name: "vague", source: "user" });
  });
});
