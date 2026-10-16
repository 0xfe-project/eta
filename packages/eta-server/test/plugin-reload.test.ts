/**
 * Hot reloading the user's plugins (S29).
 *
 * The subject is not "does it reload" but "is there exactly one of everything afterwards". A
 * reload that leaves the old instance's subscription, timer or registration behind is worse than
 * no reload at all: the plugin looks fine and quietly does its work twice.
 *
 * Ported from eta-old. There the observable was a wire registration; this repository has no wire
 * transport, so the same three facts are observed through cordis itself: a module-level counter
 * (the new code ran), a value the new instance sets (the new one is the one running), and a bus
 * subscription that would double if the old instance survived.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "cordis";
import { afterEach, describe, expect, it } from "vitest";
import { PluginManager } from "../src/plugins";

const roots: string[] = [];
/** What the plugin modules write to, since they cannot close over a test's variables. */
const g = globalThis as unknown as Record<string, unknown>;

afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
  for (const key of Object.keys(g)) {
    if (key.startsWith("__eta_test_")) delete g[key];
  }
});

async function scratch(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "eta-reload-"));
  roots.push(root);
  return root;
}

/** Write a plugin directory, replacing whatever was there. */
async function writePlugin(
  root: string,
  name: string,
  code: string,
): Promise<string> {
  const directory = join(root, name);
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "package.json"),
    JSON.stringify({ name, "eta-plugin": true }),
    "utf8",
  );
  await writeFile(join(directory, "index.ts"), code, "utf8");
  return directory;
}

function harness(): { ctx: Context } {
  return { ctx: new Context() };
}

describe("reloading after an edit", () => {
  it("runs the new code, and leaves exactly one subscription", async () => {
    const plugins = await scratch();
    const modules = await scratch();
    // Each load of the module bumps the counter, so a reload is visible from the outside.
    const source = (version: number) => `
			globalThis.__eta_test_loads = (globalThis.__eta_test_loads ?? 0) + 1;
			export default {
				name: "greeter",
				apply(ctx) {
					globalThis.__eta_test_version = ${version};
					ctx.on("tick", () => {
						globalThis.__eta_test_ticks = (globalThis.__eta_test_ticks ?? 0) + 1;
					});
				},
			};
		`;
    await writePlugin(plugins, "greeter", source(1));
    const { ctx } = harness();
    const manager = new PluginManager({
      modulesDir: modules,
      pluginsDir: plugins,
    });
    await manager.loadAll(ctx);
    expect(g.__eta_test_loads).toBe(1);

    // The user edits the plugin: same plugin, different behaviour.
    await writePlugin(plugins, "greeter", source(2));
    const reloaded = await manager.reloadChanged(ctx);
    expect(reloaded.map((plugin) => plugin.entry.name)).toEqual(["greeter"]);
    // The new code is the one running.
    expect(g.__eta_test_version).toBe(2);

    // One subscription, not two: the old instance is gone, not shadowed.
    (ctx as unknown as { emit: (name: string) => void }).emit("tick");
    expect(g.__eta_test_ticks).toBe(1);
  });

  it("does not reload when nothing changed, and does not reload official plugins", async () => {
    const plugins = await scratch();
    const modules = await scratch();
    await writePlugin(
      plugins,
      "mine",
      `export default { name: "mine", apply() {} };`,
    );
    await writePlugin(
      modules,
      "official",
      `export default { name: "official", apply() {} };`,
    );
    const { ctx } = harness();
    const manager = new PluginManager({
      modulesDir: modules,
      pluginsDir: plugins,
    });
    await manager.loadAll(ctx);
    // Nothing was touched.
    expect(await manager.reloadChanged(ctx)).toEqual([]);
    // Editing an official plugin's files is not a reload: those ship with the server.
    await writePlugin(
      modules,
      "official",
      `export default { name: "official", apply() { throw new Error("should not run"); } };`,
    );
    expect(await manager.reloadChanged(ctx)).toEqual([]);
  });

  it("reports a plugin whose new code is broken, and keeps serving", async () => {
    const plugins = await scratch();
    const modules = await scratch();
    await writePlugin(
      plugins,
      "fragile",
      `
			globalThis.__eta_test_fragile = (globalThis.__eta_test_fragile ?? 0) + 1;
			export default { name: "fragile", apply() {} };
		`,
    );
    const { ctx } = harness();
    const manager = new PluginManager({
      modulesDir: modules,
      pluginsDir: plugins,
    });
    await manager.loadAll(ctx);
    expect(g.__eta_test_fragile).toBe(1);

    // The edit has a syntax error, or throws on load.
    await writePlugin(
      plugins,
      "fragile",
      `throw new Error("my new code is broken");`,
    );
    const reloaded = await manager.reloadChanged(ctx);
    expect(reloaded.map((plugin) => plugin.entry.name)).toEqual(["fragile"]);
    expect(reloaded[0]?.entry.error).toContain("broken");
    // The old instance is gone (a reload is a replace, not a stack), so nothing of it is left
    // running — and the floor keeps serving.
    expect(g.__eta_test_fragile).toBe(1);
    expect(manager.mounted()).toEqual([
      {
        name: "fragile",
        source: "user",
        error: expect.stringContaining("broken"),
      },
    ]);
  });

  it("recovers: a broken plugin that is fixed reloads back into service", async () => {
    const plugins = await scratch();
    const modules = await scratch();
    await writePlugin(plugins, "phoenix", `throw new Error("broken");`);
    const { ctx } = harness();
    const manager = new PluginManager({
      modulesDir: modules,
      pluginsDir: plugins,
    });
    await manager.loadAll(ctx);
    expect(manager.mounted()[0]?.error).toContain("broken");

    await writePlugin(
      plugins,
      "phoenix",
      `export default { name: "phoenix", apply() { globalThis.__eta_test_phoenix = true; } };`,
    );
    const reloaded = await manager.reloadChanged(ctx);
    expect(reloaded[0]?.entry.error).toBeUndefined();
    expect(g.__eta_test_phoenix).toBe(true);
  });
});

describe("the watch", () => {
  it("reloads on its own clock, and says so", async () => {
    const plugins = await scratch();
    const modules = await scratch();
    await writePlugin(
      plugins,
      "watched",
      `export default { name: "watched", apply() {} };`,
    );
    const { ctx } = harness();
    const reloads: string[] = [];
    const manager = new PluginManager({
      modulesDir: modules,
      pluginsDir: plugins,
      watchIntervalMs: 5,
      onReload: (plugin) => reloads.push(plugin.name),
    });
    await manager.loadAll(ctx);
    manager.watch(ctx);
    // The first tick must not reload anything: what is on disk is what was loaded.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(reloads).toEqual([]);

    await writePlugin(
      plugins,
      "watched",
      `export default { name: "watched", apply() { globalThis.__eta_test_watched = true; } };`,
    );
    const deadline = Date.now() + 2_000;
    while (reloads.length === 0 && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 10));
    manager.stop();
    expect(reloads).toEqual(["watched"]);
  });
});
