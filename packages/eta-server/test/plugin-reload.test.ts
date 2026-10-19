/**
 * Hot reloading the user's plugins (S29).
 *
 * The subject is not "does it reload" but "is there exactly one of everything afterwards". A
 * reload that leaves the old instance's subscription, timer or target behind is worse than no
 * reload at all: the plugin looks fine and quietly does its work twice.
 *
 * So each test here is a side effect that is easy to duplicate — a wire registration, a timer, a
 * bus subscription — and the assertion is that after an edit there is one of it, and that
 * the *new* code is the one running.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "cordis";
import { afterEach, describe, expect, it } from "vitest";
import { PluginManager } from "../src/plugins";
import { WireService } from "../src/wire-service";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
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

function harness() {
  const ctx = new Context();
  const wire = new WireService(ctx);
  return { ctx, wire };
}

describe("reloading after an edit", () => {
  it("runs the new code, and leaves exactly one registration", async () => {
    const plugins = await scratch();
    const modules = await scratch();
    await writePlugin(
      plugins,
      "greeter",
      `export default {
			name: "greeter",
			inject: ["wire"],
			apply(ctx) { ctx.wire.handle("greeter", "hello", () => ({ result: { version: 1 } })); },
		};`,
    );
    const { ctx, wire } = harness();
    const manager = new PluginManager({
      modulesDir: modules,
      pluginsDir: plugins,
    });
    await manager.loadAll(ctx);
    expect(wire.descriptors().map((descriptor) => descriptor.name)).toEqual([
      "greeter.hello",
    ]);

    // The user edits the plugin: the same target, different behaviour.
    await writePlugin(
      plugins,
      "greeter",
      `export default {
			name: "greeter",
			inject: ["wire"],
			apply(ctx) { ctx.wire.handle("greeter", "hello", () => ({ result: { version: 2 } })); },
		};`,
    );
    const reloaded = await manager.reloadChanged(ctx);
    expect(reloaded.map((plugin) => plugin.entry.name)).toEqual(["greeter"]);
    // One registration, and it is the new one: the old handler is gone, not shadowed.
    expect(wire.descriptors().map((descriptor) => descriptor.name)).toEqual([
      "greeter.hello",
    ]);
    const outcome = await wire.dispatch(
      { op: "call", target: "greeter", action: "hello" },
      {
        reply: () => undefined,
      } as never,
    );
    expect(outcome.result).toEqual({ version: 2 });
  });

  it("leaves nothing of the old instance: no duplicate state target, no second subscription", async () => {
    const plugins = await scratch();
    const modules = await scratch();
    await writePlugin(
      plugins,
      "watcher",
      `
			let seen = 0;
			export default {
				name: "watcher",
				inject: ["wire"],
				apply(ctx) {
					ctx.wire.handle("watcher", "count", () => ({ result: { seen } }));
					ctx.wire.stateOf("watcher", { project: () => ({ sections: { seen }, revisions: { seen: String(seen) } }) });
					// A subscription that would double if the old instance survived.
					ctx.on("tick", () => { seen += 1; });
				},
			};
		`,
    );
    const { ctx, wire } = harness();
    const manager = new PluginManager({
      modulesDir: modules,
      pluginsDir: plugins,
    });
    await manager.loadAll(ctx);

    await writePlugin(
      plugins,
      "watcher",
      `
			let seen = 0;
			export default {
				name: "watcher",
				inject: ["wire"],
				apply(ctx) {
					ctx.wire.handle("watcher", "count", () => ({ result: { seen } }));
					ctx.wire.stateOf("watcher", { project: () => ({ sections: { seen }, revisions: { seen: String(seen) } }) });
					ctx.on("tick", () => { seen += 1; });
				},
			};
		`,
    );
    await manager.reloadChanged(ctx);

    // Fire one tick. If the old instance's listener survived, the counter moves twice.
    (ctx as unknown as { emit: (name: string) => void }).emit("tick");
    const outcome = await wire.dispatch(
      { op: "call", target: "watcher", action: "count" },
      {
        reply: () => undefined,
      } as never,
    );
    expect(outcome.result).toEqual({ seen: 1 });
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
      `export default { name: "fragile", inject: ["wire"], apply(ctx) { ctx.wire.handle("fragile", "ping", () => ({})); } };`,
    );
    const { ctx, wire } = harness();
    const manager = new PluginManager({
      modulesDir: modules,
      pluginsDir: plugins,
    });
    await manager.loadAll(ctx);
    expect(wire.descriptors().map((descriptor) => descriptor.name)).toEqual([
      "fragile.ping",
    ]);

    // The edit has a syntax error, or throws on load.
    await writePlugin(
      plugins,
      "fragile",
      `throw new Error("my new code is broken");`,
    );
    const reloaded = await manager.reloadChanged(ctx);
    expect(reloaded.map((plugin) => plugin.entry.name)).toEqual(["fragile"]);
    expect(reloaded[0]?.entry.error).toContain("broken");
    // The old instance is gone (a reload is a replace, not a stack), so nothing answers — and
    // the pipe is fine.
    expect(wire.descriptors()).toEqual([]);
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
    const { ctx, wire } = harness();
    const manager = new PluginManager({
      modulesDir: modules,
      pluginsDir: plugins,
    });
    await manager.loadAll(ctx);
    expect(manager.mounted()[0]?.error).toContain("broken");

    await writePlugin(
      plugins,
      "phoenix",
      `export default { name: "phoenix", inject: ["wire"], apply(ctx) { ctx.wire.handle("phoenix", "rise", () => ({ result: { up: true } })); } };`,
    );
    const reloaded = await manager.reloadChanged(ctx);
    expect(reloaded[0]?.entry.error).toBeUndefined();
    expect(wire.descriptors().map((descriptor) => descriptor.name)).toEqual([
      "phoenix.rise",
    ]);
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
      `export default { name: "watched", apply() { globalThis.__watched = true; } };`,
    );
    const deadline = Date.now() + 2_000;
    while (reloads.length === 0 && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 10));
    manager.stop();
    expect(reloads).toEqual(["watched"]);
  });
});
