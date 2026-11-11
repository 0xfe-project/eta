/**
 * The plugin manager: where plugins come from, and what happens when one is broken.
 *
 * Two directories, one loader:
 *
 * ```
 * ~/.eta/modules/<name>/    official, distributed plugins (not hot-reloaded)
 * ~/.eta/plugins/<name>/    user plugins (hot-reloaded; see reload.ts)
 * ```
 *
 * `plugins/` is shared with the product's Agent Plugins, which have a `plugin.json` and keep their
 * data in `plugins/data/`. Those are not plugins of this kind, broken or otherwise: they are left
 * alone here, and the product leaves these alone in turn.
 *
 * A plugin is a directory with a `package.json` that says `"eta-plugin": ...`. That manifest is
 * the whole discovery rule: a directory without one is not a plugin, and a directory with one is
 * loaded even if it is also a perfectly ordinary npm package. The entry point is whatever the
 * manifest names (or the package's own `main`/`module`), imported, and handed to `ctx.plugin` —
 * the same call the bundled plugins go through, because a user plugin and an official one are
 * the same kind of thing and the only difference is who shipped it.
 *
 * The rule that shapes every decision here: **a broken plugin is a broken plugin, not a broken
 * server.** Import failures, a module that exports nothing callable, a plugin whose `apply`
 * throws — all of them become a `mounted` entry with its `error` set, and the floor keeps
 * serving. A server that refuses to start because one plugin in a user directory has a typo is a
 * server whose control plane depends on its business plane, which is exactly what this refactor
 * set out to stop.
 */

import type {
  MountedPlugin,
  PluginPanelDescriptor,
} from "@eta/client-contracts";
import type { Context } from "cordis";
import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";

/** What a plugin's `package.json` says about itself. */
export interface PluginManifest {
  name: string;
  version?: string;
  /** The entry point, relative to the plugin directory. Defaults to `index.js`/`index.ts`. */
  main?: string;
  /**
   * The front-end panel this plugin contributes, as data.
   *
   * The server never renders it and never runs client code: the descriptor says where the client
   * loads it from and which state target feeds it, and the client decides what to do with that.
   * A plugin with no front-end omits this and is still a plugin — most of them are.
   */
  panel?: PluginPanelDescriptor;
}

/** One plugin the manager found, and what became of it. */
export interface LoadedPlugin {
  /** The directory it came from. */
  directory: string;
  source: "bundled" | "user";
  /** A content hash of the directory, for the watch; absent until the first check. */
  fingerprint?: string | undefined;
  /** What `mounted` reports. `error` set means it is not running. */
  entry: MountedPlugin;
  /** Unload this plugin: every effect it registered, gone. */
  dispose: () => Promise<void>;
}

export interface PluginManagerOptions {
  /** Where official, distributed plugins live. */
  modulesDir: string;
  /** Where the user's own plugins live. */
  pluginsDir: string;
  /** Diagnostics. */
  warn?: ((message: string) => void) | undefined;
  /**
   * How often to check the user's plugin directory for changes, in milliseconds. Zero disables
   * watching. Official plugins are not watched: they ship with the server, and reloading them
   * under a running process is a way to have two versions of the same thing loaded.
   */
  watchIntervalMs?: number | undefined;
  /** Called after a reload, with what became of the plugin. */
  onReload?: ((plugin: MountedPlugin) => void) | undefined;
}

/** What the wire held at one moment: the names, so a plugin's own additions can be told apart. */
interface WireSnapshot {
  actions: Set<string>;
  states: Set<string>;
}

function wireSnapshot(ctx: Context): WireSnapshot {
  const wire = (ctx as unknown as { wire?: WireServiceLike }).wire;
  if (wire === undefined) return { actions: new Set(), states: new Set() };
  return {
    actions: new Set(wire.descriptors().map((descriptor) => descriptor.name)),
    states: new Set(wire.targets().map((target) => target.name)),
  };
}

/**
 * What this plugin added, computed as the difference between two snapshots taken around its load.
 *
 * The window matters: a plugin loaded *after* this one adds names that this one must not take
 * away, and a naive "everything that was not here before" sweep does exactly that (found by a
 * test with two plugins where the first one to load was the careless one). So the set is computed
 * once, at load, and it is exactly this plugin's contribution.
 */
function addedBetween(before: WireSnapshot, after: WireSnapshot): WireSnapshot {
  const actions = new Set<string>();
  for (const name of after.actions)
    if (!before.actions.has(name)) actions.add(name);
  const states = new Set<string>();
  for (const name of after.states)
    if (!before.states.has(name)) states.add(name);
  return { actions, states };
}

/** Remove exactly what this plugin added, and only what is still there. */
function sweepWire(ctx: Context, added: WireSnapshot): void {
  const wire = (ctx as unknown as { wire?: WireServiceLike }).wire;
  if (wire === undefined) return;
  for (const descriptor of wire.descriptors()) {
    if (!added.actions.has(descriptor.name)) continue;
    wire.registry.unregister(descriptor.target, descriptor.action);
  }
  for (const target of wire.targets()) {
    if (!added.states.has(target.name)) continue;
    wire.registry.unregisterState(target.name);
  }
}

/** The slice of the wire service the manager needs; kept structural so this file stays a leaf. */
interface WireServiceLike {
  descriptors: () => { name: string; target: string; action: string }[];
  targets: () => { name: string; hasState: boolean }[];
  registry: {
    unregister: (target: string, action: string) => boolean;
    unregisterState: (target: string) => boolean;
  };
}

/** Whether a manifest's `panel` field is a panel descriptor at all. */
function isPanel(value: unknown): value is PluginPanelDescriptor {
  if (typeof value !== "object" || value === null) return false;
  const panel = value as Record<string, unknown>;
  return (
    typeof panel.title === "string" &&
    ["sidebar", "panel", "overlay", "statusbar"].includes(String(panel.slot)) &&
    (panel.entry === undefined || typeof panel.entry === "string") &&
    (panel.state === undefined || typeof panel.state === "string")
  );
}

/** What a plugin may register: its own name, or anything under `name.`. */
function trespassOf(added: WireSnapshot, name: string): string | undefined {
  const allowed = (target: string): boolean =>
    target === name || target.startsWith(`${name}.`);
  for (const action of added.actions) {
    // Action names are `target.action`; the target is everything before the first dot.
    const target = action.split(".")[0] ?? action;
    if (!allowed(target)) return action;
  }
  for (const target of added.states) if (!allowed(target)) return target;
  return undefined;
}

/** A short, stable hash of a fingerprint: the import URL's cache-busting token. */
function hash(value: string): string {
  let h = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    h ^= value.charCodeAt(index);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

/** An Agent Plugin, or where they keep their data: what shares `plugins/` with user plugins. */
const isAgentPlugins = (directory: string, name: string): boolean =>
  name === "data" || existsSync(join(directory, "plugin.json"));

/** The manifest key that marks a directory as a plugin. */
export const PLUGIN_MANIFEST_KEY = "eta-plugin";

export class PluginManager {
  private readonly modulesDir: string;
  private readonly pluginsDir: string;
  private readonly warn: (message: string) => void;
  private readonly loaded: LoadedPlugin[] = [];
  private readonly watchIntervalMs: number;
  private readonly onReload: ((plugin: MountedPlugin) => void) | undefined;
  private watcher: ReturnType<typeof setInterval> | undefined;
  /** Whether a check started by the watch is still running. */
  private polling = false;

  constructor(options: PluginManagerOptions) {
    this.modulesDir = options.modulesDir;
    this.pluginsDir = options.pluginsDir;
    this.warn = options.warn ?? (() => undefined);
    this.watchIntervalMs = options.watchIntervalMs ?? 0;
    this.onReload = options.onReload;
  }

  /**
   * Start noticing edits to the user's plugins.
   *
   * A plugin file's *content* is the trigger, not its timestamp: an editor that writes the same
   * bytes (a save with no change, a formatter that decided nothing needed formatting) must not
   * cause a reload, because a reload tears down live state and rebuilds it. Comparing content
   * also means the check is correct across a `git checkout` that restores an older mtime.
   */
  watch(ctx: Context): void {
    if (this.watchIntervalMs <= 0 || this.watcher !== undefined) return;
    this.watcher = setInterval(() => {
      // One check at a time. A check is asynchronous (it reads files and may reload), and on a
      // busy machine it outlasts the interval: a second one starting meanwhile would see the
      // same edit as new and reload the plugin again, from a list that no longer holds it.
      if (this.polling) return;
      this.polling = true;
      void this.pollForChanges(ctx)
        .catch((error: unknown) =>
          this.warn(`[eta-server] plugin watch: ${String(error)}`),
        )
        .finally(() => {
          this.polling = false;
        });
    }, this.watchIntervalMs);
    (this.watcher as { unref?: () => void }).unref?.();
  }

  stop(): void {
    if (this.watcher === undefined) return;
    clearInterval(this.watcher);
    this.watcher = undefined;
  }

  /** Reload every user plugin whose files changed. Returns the plugins that were reloaded. */
  async reloadChanged(ctx: Context): Promise<LoadedPlugin[]> {
    const reloaded: LoadedPlugin[] = [];
    for (const plugin of [...this.loaded]) {
      if (plugin.source !== "user") continue;
      const fingerprint = await this.fingerprint(plugin.directory);
      if (fingerprint === plugin.fingerprint) continue;
      reloaded.push(await this.reload(ctx, plugin));
    }
    return reloaded;
  }

  /**
   * Unload a plugin and load it again from disk.
   *
   * The order is what makes this safe: the old instance is disposed (every effect it registered
   * runs, and anything it left behind is swept) *before* the new one is loaded. A reload that
   * loaded first would have two instances registering the same target, and the second one's
   * registration would be refused — which reads as "the plugin broke on reload".
   */
  async reload(ctx: Context, plugin: LoadedPlugin): Promise<LoadedPlugin> {
    const index = this.loaded.indexOf(plugin);
    if (index >= 0) this.loaded.splice(index, 1);
    await plugin.dispose().catch((error: unknown) => {
      this.warn(
        `[eta-server] plugin ${plugin.entry.name} did not unload cleanly: ${String(error)}`,
      );
    });
    const loaded = await this.loadOne(ctx, plugin.directory, plugin.source);
    this.onReload?.(loaded.entry);
    return loaded;
  }

  /** A content hash of everything in a plugin directory: the reload trigger. */
  private async fingerprint(directory: string): Promise<string> {
    const files: string[] = [];
    const walk = async (current: string): Promise<void> => {
      const entries = await readdir(current, { withFileTypes: true }).catch(
        () => [],
      );
      for (const entry of entries.sort((left, right) =>
        left.name.localeCompare(right.name),
      )) {
        // `node_modules` is not the plugin's code, and a lockfile churns without meaning
        // anything changed.
        if (entry.name === "node_modules") continue;
        const path = join(current, entry.name);
        if (entry.isDirectory()) {
          await walk(path);
          continue;
        }
        if (!/\.[cm]?[jt]s$|package\.json$/.test(entry.name)) continue;
        const content = await readFile(path, "utf8").catch(() => "");
        files.push(`${path}\u0000${content}`);
      }
    };
    await walk(directory);
    return files.join("\u0001");
  }

  private async pollForChanges(ctx: Context): Promise<void> {
    // First tick only records what is there: a plugin that was never fingerprinted is not a
    // change, it is the state the manager started in.
    for (const plugin of this.loaded) {
      if (plugin.source !== "user" || plugin.fingerprint !== undefined)
        continue;
      plugin.fingerprint = await this.fingerprint(plugin.directory);
    }
    await this.reloadChanged(ctx);
  }

  /** Everything loaded so far, as `hello.mounted` reports it. */
  mounted(): MountedPlugin[] {
    return this.loaded.map((plugin) => plugin.entry);
  }

  /** The plugins that are actually running (their entry has no error). */
  running(): LoadedPlugin[] {
    return this.loaded.filter((plugin) => plugin.entry.error === undefined);
  }

  /**
   * Load everything in both directories.
   *
   * Order is deliberate: official plugins first, then the user's — so a user plugin that wants
   * to replace or wrap something can rely on the official one being there.
   */
  async loadAll(ctx: Context): Promise<MountedPlugin[]> {
    for (const [directory, source] of [
      [this.modulesDir, "bundled"],
      [this.pluginsDir, "user"],
    ] as const) {
      await this.loadDirectory(ctx, directory, source);
    }
    return this.mounted();
  }

  /** Load every plugin directory inside one root. */
  async loadDirectory(
    ctx: Context,
    root: string,
    source: "bundled" | "user",
  ): Promise<void> {
    const entries = await readdir(root, { withFileTypes: true }).catch(
      () => [],
    );
    for (const entry of entries.sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      if (!entry.isDirectory()) continue;
      const directory = join(root, entry.name);
      if (this.loaded.some((plugin) => plugin.directory === directory))
        continue;
      if (source === "user" && isAgentPlugins(directory, entry.name)) continue;
      await this.loadOne(ctx, directory, source);
    }
  }

  /**
   * Load one plugin directory.
   *
   * Never throws: every way this can fail (no manifest, a manifest that will not parse, an
   * import that fails, a module that exports nothing callable, an `apply` that throws, a
   * registration outside the plugin's own namespace) becomes a `mounted` entry carrying the
   * reason.
   */
  async loadOne(
    ctx: Context,
    directory: string,
    source: "bundled" | "user",
  ): Promise<LoadedPlugin> {
    const fallbackName = basename(directory);
    // The fingerprint is taken first, and even a plugin that fails to load records it: a
    // broken plugin that gets fixed is a *change*, and a failure path that recorded nothing
    // would make the fix look like the state it was already in.
    const fingerprint = await this.fingerprint(directory);
    // A plugin that fails to load may still have a front-end worth reporting: the descriptor is
    // read from the manifest, and the reason it is not running is what `error` says.
    let panel: PluginPanelDescriptor | undefined;
    const failed = (
      name: string,
      error: string,
      version?: string,
    ): LoadedPlugin => {
      this.warn(`[eta-server] plugin ${name} is not running: ${error}`);
      const plugin: LoadedPlugin = {
        directory,
        source,
        fingerprint,
        entry: {
          name,
          source,
          ...(version === undefined ? {} : { version }),
          ...(panel === undefined ? {} : { descriptor: panel }),
          error,
        },
        dispose: async () => undefined,
      };
      this.loaded.push(plugin);
      return plugin;
    };

    const manifest = await this.readManifest(directory);
    if (manifest === undefined)
      return failed(fallbackName, "no eta-plugin manifest in package.json");
    panel = manifest.panel;

    const entryFile = await this.resolveEntry(directory, manifest.main);
    if (entryFile === undefined)
      return failed(manifest.name, "no entry point (main/module/index)");

    // A fresh module every time the code changes: the import cache is keyed by URL, so a
    // reload of the *same path* hands back the module that was already loaded — the old code,
    // silently. The content hash makes the URL a different one exactly when the code is.
    const importUrl = `${pathToFileURL(entryFile).href}?v=${hash(fingerprint)}`;
    let module: unknown;
    try {
      module = await import(importUrl);
    } catch (error) {
      return failed(
        manifest.name,
        error instanceof Error ? error.message : String(error),
        manifest.version,
      );
    }

    const plugin = pickPlugin(module);
    if (plugin === undefined) {
      return failed(
        manifest.name,
        "the module exports no plugin (a function, or {name, apply})",
        manifest.version,
      );
    }

    // What the wire looked like before this plugin: whatever it adds and does not remove is
    // this plugin's, and the floor takes it back on unload. A plugin that cleans up after
    // itself (with an effect) leaves nothing here, and one that does not is still contained.
    const before = wireSnapshot(ctx);

    try {
      const fiber = ctx.plugin(
        plugin as never,
        undefined as never,
      ) as unknown as {
        dispose: () => Promise<void>;
      };
      // `await fiber` is what makes a load failure *this* plugin's: cordis reports an `apply`
      // that threw by rejecting the fiber, and awaiting it here is how the reason reaches
      // `mounted` instead of an unhandled rejection.
      await (fiber as unknown as PromiseLike<unknown>);
      // Computed here, not at dispose: a plugin loaded later must not look like this one's
      // doing, and only the moment right after this load can tell the two apart.
      const added = addedBetween(before, wireSnapshot(ctx));
      // A scanned plugin lives in its own namespace. The check is after the fact because a
      // plugin registers through the same door everything else does — but a plugin that
      // claims someone else's name is a plugin that will fight another one for it, and the
      // refusal is worth more than the tolerance.
      const trespass = trespassOf(added, manifest.name);
      if (trespass !== undefined) {
        await fiber.dispose().catch(() => undefined);
        sweepWire(ctx, added);
        return failed(
          manifest.name,
          `registered outside its namespace: ${trespass}`,
          manifest.version,
        );
      }
      const loaded: LoadedPlugin = {
        directory,
        source,
        entry: {
          name: manifest.name,
          source,
          ...(manifest.version === undefined
            ? {}
            : { version: manifest.version }),
          ...(manifest.panel === undefined
            ? {}
            : { descriptor: manifest.panel }),
        },
        // Recorded at load, so the first watch tick sees no change and does not reload.
        fingerprint,
        dispose: async () => {
          await fiber.dispose();
          // The plugin's own effects ran; anything it registered without one is swept up
          // here, so "unload" means the same thing for every plugin.
          sweepWire(ctx, added);
        },
      };
      this.loaded.push(loaded);
      return loaded;
    } catch (error) {
      return failed(
        manifest.name,
        error instanceof Error ? error.message : String(error),
        manifest.version,
      );
    }
  }

  /** Unload everything, newest first (a plugin may depend on one loaded before it). */
  async dispose(): Promise<void> {
    for (const plugin of [...this.loaded].reverse()) {
      await plugin.dispose().catch(() => undefined);
    }
    this.loaded.length = 0;
  }

  /** A plugin's `package.json`, when it declares itself one. */
  private async readManifest(
    directory: string,
  ): Promise<PluginManifest | undefined> {
    let raw: string;
    try {
      raw = await readFile(join(directory, "package.json"), "utf8");
    } catch {
      return undefined;
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return undefined;
    }
    // The marker is the discovery rule. It may be `true` (nothing to declare) or an object
    // with the manifest's own fields; either way the *package* name is what the plugin is
    // called unless the marker names something else.
    const marker = parsed[PLUGIN_MANIFEST_KEY];
    if (marker === undefined) return undefined;
    const declared =
      typeof marker === "object" && marker !== null
        ? (marker as Record<string, unknown>)
        : {};
    const name =
      typeof declared.name === "string" ? declared.name : parsed.name;
    if (typeof name !== "string" || name.trim().length === 0) return undefined;
    return {
      name: name.trim(),
      ...(typeof parsed.version === "string"
        ? { version: parsed.version }
        : {}),
      ...(typeof declared.main === "string" ? { main: declared.main } : {}),
      ...(isPanel(declared.panel) ? { panel: declared.panel } : {}),
    };
  }

  /** Where a plugin's code is: what the manifest says, else the conventional entry files. */
  private async resolveEntry(
    directory: string,
    declared: string | undefined,
  ): Promise<string | undefined> {
    const candidates =
      declared === undefined
        ? ["index.ts", "index.js", "src/index.ts", "src/index.js"]
        : [declared, `${declared}.ts`, `${declared}.js`];
    for (const candidate of candidates) {
      const path = join(directory, candidate);
      if ((await stat(path).catch(() => undefined))?.isFile() === true)
        return path;
    }
    return undefined;
  }
}

/**
 * What a plugin module exports.
 *
 * In order of preference:
 *
 * 1. `default` — what a TypeScript `export default` compiles to, and the conventional shape for a
 *    distributed plugin;
 * 2. an export named `plugin` — the same thing without the default-export convention;
 * 3. the module itself, when it is a plugin (an object with `apply`, or a function);
 * 4. exactly one export that looks like a plugin.
 *
 * Step 4 is deliberately the last resort: a package that also exports a service class, a factory
 * and a constant has several things that *could* be a plugin, and guessing between them is how the
 * wrong thing loads. (Found the honest way: this plugin's own package exports a factory and a
 * service class, and the loader refused to guess — which is what made it export a default.)
 */
export function pickPlugin(module: unknown): unknown {
  if (typeof module === "function") return module;
  if (typeof module !== "object" || module === null) return undefined;
  const record = module as Record<string, unknown>;
  if (isPluginShape(record.default)) return record.default;
  if (isPluginShape(record.plugin)) return record.plugin;
  if (isPluginShape(record)) return record;
  const candidates = Object.entries(record).filter(
    ([key]) =>
      key !== "default" && key !== "plugin" && isPluginShape(record[key]),
  );
  return candidates.length === 1 ? candidates[0]?.[1] : undefined;
}

function isPluginShape(value: unknown): boolean {
  if (typeof value === "function") return true;
  if (typeof value !== "object" || value === null) return false;
  return typeof (value as { apply?: unknown }).apply === "function";
}
