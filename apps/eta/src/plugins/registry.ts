/**
 * What plugins exist on this host, read from where they are.
 *
 * Two places: the directories under `<dataDir>/plugins/` (the user's; a change to one is picked up
 * without asking) and the git sources (held at a commit under `<dataDir>/plugin-sources/`, which
 * only an explicit update moves). An entry is what was read last. A plugin the spec rejects is still
 * an entry, under its directory's name, with the reason: it has to be visible to be fixed.
 *
 * Reading is asynchronous and the wire's sections are not, so everything here reads the entries as
 * they are and `refresh` brings them up to date: a timer calls it, and so does the engine before it
 * opens a session. Only what changed is read again (`pluginSignature`). A timer and not `fs.watch`,
 * whose recursive form does not see every nested change on every platform.
 */
import type { PluginSource } from "@eta/client-contracts";
import type { PluginPackage } from "@eta/daemon";
import type { GitSourceRow, PluginRows } from "./store";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import {
  loadPlugin,
  PluginError,
  pluginHash,
  pluginSignature,
} from "@eta/daemon";
import { cleanPath, fetchInto, isAt, resolveRev, sourceDir } from "./git";

export interface PluginEntry {
  name: string;
  source: PluginSource;
  dir: string;
  /** Its contents' hash; undefined when it could not be read. */
  hash?: string;
  plugin?: PluginPackage;
  /** Why it cannot be used at all. */
  problem?: string;
}

/** A directory under the plugins root that is not a plugin: `PLUGIN_DATA` lives there. */
const DATA_DIR = "data";
const POLL_MS = 2_000;

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * `plugins/` is also where the server's own user plugins live (`package.json` with `eta-plugin`,
 * see `plugins.ts` in `@eta/server`). One of those has no `plugin.json`, and is not a rejected
 * Agent Plugin.
 */
function isServerPlugin(dir: string): boolean {
  if (existsSync(join(dir, "plugin.json"))) return false;
  try {
    const manifest = JSON.parse(
      readFileSync(join(dir, "package.json"), "utf8"),
    ) as Record<string, unknown>;
    return manifest["eta-plugin"] !== undefined;
  } catch {
    return false;
  }
}

export class PluginRegistry {
  readonly #root: string;
  readonly #sources: string;
  readonly #rows: PluginRows;
  readonly #changed: () => void;
  readonly #warn: (message: string) => void;
  #entries = new Map<string, PluginEntry>();
  /** What each directory was read at, with what came of it. */
  readonly #read = new Map<string, { signature: string; entry: PluginEntry }>();
  #refreshing: Promise<void> = Promise.resolve();
  #timer: ReturnType<typeof setInterval> | undefined;

  constructor(options: {
    dataDir: string;
    rows: PluginRows;
    changed: () => void;
    warn: (message: string) => void;
  }) {
    this.#root = join(options.dataDir, "plugins");
    this.#sources = join(options.dataDir, "plugin-sources");
    this.#rows = options.rows;
    this.#changed = options.changed;
    this.#warn = options.warn;
    mkdirSync(this.#root, { recursive: true });
  }

  entries(): PluginEntry[] {
    return [...this.#entries.values()];
  }

  get(name: string): PluginEntry | undefined {
    return this.#entries.get(name);
  }

  /** Bring the entries up to date; overlapping calls queue, and a change says so once. */
  refresh(): Promise<void> {
    this.#refreshing = this.#refreshing
      .catch(() => undefined)
      .then(() => this.#scan());
    return this.#refreshing;
  }

  async #scan(): Promise<void> {
    const found: { dir: string; source: PluginSource; key: string }[] = [];
    for (const name of readdirSync(this.#root).sort()) {
      if (name === DATA_DIR || name.startsWith(".")) continue;
      const dir = join(this.#root, name);
      if (
        statSync(dir, { throwIfNoEntry: false })?.isDirectory() &&
        !isServerPlugin(dir)
      )
        found.push({ dir, source: { kind: "local", path: dir }, key: name });
    }
    for (const row of this.#rows.sources()) {
      const dir = sourceDir(this.#sources, row.repo, row.path);
      found.push({
        dir,
        source: {
          kind: "git",
          repo: row.repo,
          rev: row.rev,
          path: row.path,
          sha: row.sha,
        },
        key: row.name,
      });
    }
    const entries = new Map<string, PluginEntry>();
    for (const { dir, source, key } of found) {
      const entry = await this.#entryOf(dir, source, key);
      const taken = entries.get(entry.name);
      if (taken === undefined) entries.set(entry.name, entry);
      else
        entries.set(`${key}@${source.kind}`, {
          name: `${key}@${source.kind}`,
          source,
          dir,
          problem: `another plugin is named ${entry.name}`,
        });
    }
    const before = this.#fingerprint(this.#entries);
    this.#entries = entries;
    if (this.#fingerprint(entries) !== before) this.#changed();
  }

  #fingerprint(entries: ReadonlyMap<string, PluginEntry>): string {
    return JSON.stringify(
      [...entries.values()].map((entry) => [
        entry.name,
        entry.hash,
        entry.problem,
        entry.plugin?.reports,
      ]),
    );
  }

  async #entryOf(
    dir: string,
    source: PluginSource,
    key: string,
  ): Promise<PluginEntry> {
    let signature: string;
    try {
      signature = existsSync(dir) ? pluginSignature(dir) : "";
    } catch (error) {
      return { name: key, source, dir, problem: messageOf(error) };
    }
    const known = this.#read.get(dir);
    if (known?.signature === signature) return { ...known.entry, source };
    const entry = await this.#load(dir, source, key);
    this.#read.set(dir, { signature, entry });
    return entry;
  }

  async #load(
    dir: string,
    source: PluginSource,
    key: string,
  ): Promise<PluginEntry> {
    try {
      const plugin = await loadPlugin(dir);
      return {
        name: plugin.manifest.name,
        source,
        dir: plugin.root,
        plugin,
        hash: pluginHash(plugin.root),
      };
    } catch (error) {
      if (!(error instanceof PluginError))
        this.#warn(`[eta] plugin ${key}: ${messageOf(error)}`);
      return { name: key, source, dir, problem: messageOf(error) };
    }
  }

  /** Keep looking at the user's directories. */
  watch(): void {
    if (this.#timer !== undefined) return;
    this.#timer = setInterval(() => {
      void this.refresh().catch((error: unknown) =>
        this.#warn(`[eta] plugins: ${messageOf(error)}`),
      );
    }, POLL_MS);
    this.#timer.unref();
  }

  close(): void {
    clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /** Git sources whose files are gone come back, at the commit that was recorded. */
  async restore(): Promise<void> {
    for (const row of this.#rows.sources()) {
      const dir = sourceDir(this.#sources, row.repo, row.path);
      if (isAt(dir, row.sha)) continue;
      await fetchInto({ ...row, dir }).catch((error: unknown) =>
        this.#warn(
          `[eta] plugin ${row.name} could not be restored: ${messageOf(error)}`,
        ),
      );
    }
  }

  /** Fetch a source and say what it is, before anything records it. */
  async #fetched(
    source: Pick<GitSourceRow, "repo" | "rev" | "path">,
  ): Promise<{ row: Omit<GitSourceRow, "name">; name: string }> {
    const path = cleanPath(source.path);
    const { sha, ref } = await resolveRev(source.repo, source.rev);
    const dir = sourceDir(this.#sources, source.repo, path);
    await fetchInto({ dir, repo: source.repo, sha, ref, path });
    this.#read.delete(dir);
    const plugin = await loadPlugin(dir);
    return {
      row: { repo: source.repo, rev: source.rev, path, sha, ref },
      name: plugin.manifest.name,
    };
  }

  async add(repo: string, rev: string, path: string): Promise<string> {
    const { row, name } = await this.#fetched({ repo, rev, path });
    if (this.#entries.has(name) && this.#rows.source(name) === undefined)
      throw new PluginError(`a plugin named ${name} already exists`);
    this.#rows.saveSource({ ...row, name });
    await this.refresh();
    return name;
  }

  /** Resolve `rev` anew. A repository that renamed the plugin is refused, not followed. */
  async update(name: string): Promise<void> {
    const source = this.#rows.source(name);
    if (source === undefined) throw new PluginError(`${name} is not from git`);
    const { row, name: fetched } = await this.#fetched(source);
    if (fetched !== name) {
      await fetchInto({
        ...source,
        dir: sourceDir(this.#sources, source.repo, source.path),
      });
      throw new PluginError(`${source.repo} is now plugin ${fetched}`);
    }
    this.#rows.saveSource({ ...row, name });
    await this.refresh();
  }

  async remove(name: string): Promise<void> {
    const source = this.#rows.source(name);
    if (source === undefined) throw new PluginError(`${name} is not from git`);
    this.#rows.removeSource(name);
    const dir = sourceDir(this.#sources, source.repo, source.path);
    await rm(dir, { recursive: true, force: true });
    await rm(`${dir}.sha`, { force: true });
    this.#read.delete(dir);
    await this.refresh();
  }
}
