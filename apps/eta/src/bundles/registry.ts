import type { BundleSource } from "@eta/client-contracts";
/**
 * The bundles this host knows, and where each one's files are.
 *
 * Three places, later ones winning a name:
 *
 * 1. **built in**: `bundles/<name>/` in the repository;
 * 2. **from git**: rows of `bundle_source`, each in `~/.eta/bundles/git/<hash>/` at the commit it
 *    was resolved to;
 * 3. **local**: `~/.eta/bundles/<name>/`, the user's own. A local directory with a built-in's name
 *    replaces it, which is how a bundle is customised.
 *
 * Nothing is cached past a change: every read first looks at the files' sizes and times, and
 * reads the manifests again if any moved. That is the hot reload; a watcher on the local directory
 * only tells the wire sooner.
 */
import type { ActiveBundle, Bundle, BundleFiles } from "@eta/daemon";
import type { Dirent, FSWatcher } from "node:fs";
import type { BundleRows, SourceRow } from "./rows";
import { existsSync, mkdirSync, readdirSync, statSync, watch } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import {
  BundleError,
  hashBundle,
  isConfigured,
  readBundle,
  snapshotBundle,
} from "@eta/daemon";
import {
  cleanPath,
  FetchError,
  fetchInto,
  isAt,
  resolveRev,
  sourceDir,
} from "./fetch";

export interface BundleEntry {
  name: string;
  source: BundleSource;
  /** The commit a git source is at. */
  sha: string | null;
  dir: string;
  /** Absent when the directory does not parse; `problem` says why. */
  bundle: Bundle | undefined;
  problem: string | null;
  /** What the files' sizes and times were when this was read. */
  signature: string;
}

export interface RegistryOptions {
  /** `bundles/` of the repository. */
  builtinDir: string;
  /** `~/.eta/bundles`: the user's own, and `git/` under it. */
  root: string;
  rows: BundleRows;
  /** The bundles moved: a file changed, a source was fetched. */
  changed: () => void;
  warn: (message: string) => void;
}

/** Sizes and times of every file under `dir`, as one string. */
function signatureOf(dir: string): string {
  const parts: string[] = [];
  const walk = (path: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(path, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const full = join(path, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        try {
          const info = statSync(full);
          parts.push(`${full}:${info.size}:${info.mtimeMs}`);
        } catch {
          /* gone while we looked */
        }
      }
    }
  };
  walk(dir);
  return parts.join("\n");
}

/** One directory to read, and what kind of place it is in. */
type Place =
  | { dir: string; tier: "builtin" | "local" }
  | { dir: string; tier: "git"; source: SourceRow };

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export class BundleRegistry {
  readonly #options: RegistryOptions;
  #entries: BundleEntry[] = [];
  #signature: string | undefined;
  readonly #snapshots = new Map<
    string,
    { signature: string; hash: string; files: BundleFiles }
  >();
  #watcher: FSWatcher | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: RegistryOptions) {
    this.#options = options;
  }

  /** Every bundle, built in first, then by name. */
  entries(): readonly BundleEntry[] {
    const sources = this.#options.rows.sources();
    const dirs = this.#directories(sources);
    const signature = dirs
      .map((dir) => `${dir.dir}\n${signatureOf(dir.dir)}`)
      .concat(sources.map((source) => `${source.name}@${source.sha}`))
      .join("\n--\n");
    if (signature !== this.#signature) {
      this.#entries = this.#read(dirs);
      this.#signature = signature;
    }
    return this.#entries;
  }

  get(name: string): BundleEntry | undefined {
    return this.entries().find((entry) => entry.name === name);
  }

  #directories(sources: readonly SourceRow[]): Place[] {
    const { builtinDir, root } = this.#options;
    const list = (dir: string, skip: string[] = []) =>
      existsSync(dir)
        ? readdirSync(dir, { withFileTypes: true })
            .filter(
              (entry) =>
                entry.isDirectory() &&
                !entry.name.startsWith(".") &&
                !skip.includes(entry.name),
            )
            .map((entry) => join(dir, entry.name))
        : [];
    return [
      ...list(builtinDir).map((dir) => ({ dir, tier: "builtin" as const })),
      ...sources.map((source) => ({
        dir: sourceDir(root, source.repo, source.path),
        tier: "git" as const,
        source,
      })),
      ...list(root, ["git"]).map((dir) => ({ dir, tier: "local" as const })),
    ];
  }

  #read(dirs: readonly Place[]): BundleEntry[] {
    const byName = new Map<string, BundleEntry>();
    for (const found of dirs) {
      const fallback =
        found.tier === "git"
          ? found.source.name
          : (found.dir.split("/").at(-1) ?? found.dir);
      const sourceOf = (): BundleSource =>
        found.tier === "git"
          ? {
              kind: "git",
              repo: found.source.repo,
              rev: found.source.rev,
              path: found.source.path,
            }
          : { kind: found.tier };
      const sha = found.tier === "git" ? found.source.sha : null;
      const signature = signatureOf(found.dir);
      try {
        if (!existsSync(found.dir))
          throw new BundleError("it has not been fetched yet");
        const bundle = readBundle(found.dir);
        const { name } = bundle.manifest;
        if (found.tier !== "git" && name !== fallback)
          throw new BundleError(
            `plugin.json names it ${name}, but its directory is ${fallback}`,
          );
        if (found.tier === "git" && name !== fallback)
          throw new BundleError(`it is now called ${name}, not ${fallback}`);
        byName.set(name, {
          name,
          source: sourceOf(),
          sha,
          dir: found.dir,
          bundle,
          problem: null,
          signature,
        });
      } catch (error) {
        if (!(error instanceof BundleError)) throw error;
        // A broken directory shadows nothing that works: it only takes the name if none does.
        if (!byName.has(fallback) || byName.get(fallback)!.bundle === undefined)
          byName.set(fallback, {
            name: fallback,
            source: sourceOf(),
            sha,
            dir: found.dir,
            bundle: undefined,
            problem: error.message,
            signature,
          });
      }
    }
    return [...byName.values()].sort((a, b) => {
      const rank = (entry: BundleEntry) =>
        entry.source.kind === "builtin" ? 0 : 1;
      return rank(a) - rank(b) || (a.name < b.name ? -1 : 1);
    });
  }

  /* ------------------------------------------------------- for sessions */

  /** The values a bundle is configured with, of the fields it declares. */
  configOf(entry: BundleEntry): Record<string, string> {
    if (entry.bundle === undefined) return {};
    const saved = this.#options.rows.config(entry.name);
    const config: Record<string, string> = {};
    for (const field of entry.bundle.manifest.config) {
      const value = saved[field.name];
      if (value !== undefined && value !== "") config[field.name] = value;
    }
    return config;
  }

  /** The bundles of these names that exist and parse, as a session loads them. */
  active(
    names: readonly string[],
    serviceUrl: (name: string) => string | undefined = () => undefined,
  ): ActiveBundle[] {
    const active: ActiveBundle[] = [];
    for (const name of names) {
      const entry = this.get(name);
      if (entry?.bundle === undefined) continue;
      const config = this.configOf(entry);
      active.push({
        bundle: entry.bundle,
        config,
        configured: isConfigured(entry.bundle.manifest, config),
        serviceUrl: serviceUrl(name),
      });
    }
    return active;
  }

  /**
   * What a session opened with these bundles was opened with: a different stamp means the
   * session is opened again. Files and values both count; the values only by when they were set.
   */
  stamp(names: readonly string[]): string {
    return JSON.stringify(
      names.map((name) => {
        const entry = this.get(name);
        return [
          name,
          entry === undefined
            ? null
            : Bun.hash(`${entry.signature}\0${entry.sha ?? ""}`).toString(36),
          this.#options.rows.configuredAt(name),
        ];
      }),
    );
  }

  /** The files of a bundle for a machine that does not have them, and their hash. */
  snapshot(name: string): { hash: string; files: BundleFiles } {
    const entry = this.get(name);
    if (entry?.bundle === undefined) throw new BundleError(`no bundle ${name}`);
    const kept = this.#snapshots.get(name);
    if (kept !== undefined && kept.signature === entry.signature) return kept;
    const files = snapshotBundle(entry.dir);
    const made = { signature: entry.signature, hash: hashBundle(files), files };
    this.#snapshots.set(name, made);
    return made;
  }

  /* ---------------------------------------------------------- git sources */

  /** Add a bundle from a repository: resolve `rev`, fetch `path`, read what it is called. */
  async add(input: {
    repo: string;
    rev: string;
    path: string;
  }): Promise<string> {
    const repo = input.repo.trim();
    if (repo === "" || repo.startsWith("-"))
      throw new FetchError("that is not a repository address");
    const path = cleanPath(input.path);
    const rev = input.rev.trim() === "" ? "HEAD" : input.rev.trim();
    const { sha, ref } = await resolveRev(repo, rev);
    const dir = sourceDir(this.#options.root, repo, path);
    await fetchInto({ dir, repo, sha, ref, path });
    let name: string;
    try {
      name = readBundle(dir).manifest.name;
    } catch (error) {
      await this.#discard(dir);
      throw new FetchError(
        `${path === "" ? repo : path} is not a bundle: ${messageOf(error)}`,
      );
    }
    const existing = this.get(name);
    const sources = this.#options.rows.sources();
    const mine = sources.find((source) => source.name === name);
    if (
      (existing !== undefined && existing.source.kind !== "git") ||
      (mine !== undefined && (mine.repo !== repo || mine.path !== path))
    ) {
      await this.#discard(dir);
      throw new FetchError(`there is already a bundle called ${name}`);
    }
    this.#options.rows.setSource({
      name,
      repo,
      rev,
      path,
      sha,
      fetchedAt: Date.now(),
    });
    this.#options.changed();
    return name;
  }

  /** Resolve the `rev` of git sources again and fetch where it moved. Returns what was looked at. */
  async refresh(name?: string): Promise<string[]> {
    const sources = this.#options.rows
      .sources()
      .filter((source) => name === undefined || source.name === name);
    if (name !== undefined && sources.length === 0)
      throw new FetchError(`${name} is not a bundle from git`);
    const done: string[] = [];
    const failures: string[] = [];
    for (const source of sources) {
      try {
        const { sha, ref } = await resolveRev(source.repo, source.rev);
        const dir = sourceDir(this.#options.root, source.repo, source.path);
        if (sha !== source.sha || !isAt(dir, sha))
          await fetchInto({
            dir,
            repo: source.repo,
            sha,
            ref,
            path: source.path,
          });
        this.#options.rows.setSource({ ...source, sha, fetchedAt: Date.now() });
        done.push(source.name);
      } catch (error) {
        failures.push(`${source.name}: ${messageOf(error)}`);
      }
    }
    this.#options.changed();
    if (failures.length > 0) throw new FetchError(failures.join("; "));
    return done;
  }

  /** Forget a source from git, with its files and its values. */
  async removeSource(name: string): Promise<void> {
    const source = this.#options.rows
      .sources()
      .find((row) => row.name === name);
    if (source === undefined)
      throw new FetchError(`${name} is not a bundle from git`);
    this.#options.rows.removeSource(name);
    this.#options.rows.setConfig(name, {});
    await this.#discard(
      sourceDir(this.#options.root, source.repo, source.path),
    );
    this.#options.changed();
  }

  /**
   * Fetch again what is recorded but missing or at another commit, at the recorded commit. A
   * source that cannot be fetched (offline) is reported and left; the bundle shows its problem.
   */
  async restore(): Promise<void> {
    for (const source of this.#options.rows.sources()) {
      const dir = sourceDir(this.#options.root, source.repo, source.path);
      if (isAt(dir, source.sha)) continue;
      try {
        const { ref } = await resolveRev(source.repo, source.rev).catch(() => ({
          ref: null,
        }));
        await fetchInto({
          dir,
          repo: source.repo,
          sha: source.sha,
          ref,
          path: source.path,
        });
      } catch (error) {
        this.#options.warn(
          `[eta] bundle ${source.name} could not be restored: ${messageOf(error)}`,
        );
      }
    }
    this.#options.changed();
  }

  async #discard(dir: string): Promise<void> {
    await rm(dir, { recursive: true, force: true });
    await rm(`${dir}.sha`, { force: true });
  }

  /* ------------------------------------------------------------- watching */

  /** Tell `changed` when the user's directory changes, a moment after it settles. */
  watch(): void {
    const { root } = this.#options;
    if (this.#watcher !== undefined) return;
    try {
      mkdirSync(root, { recursive: true });
      this.#watcher = watch(root, { recursive: true }, () => {
        clearTimeout(this.#timer);
        this.#timer = setTimeout(() => this.#options.changed(), 150);
      });
      this.#watcher.on("error", () => undefined);
    } catch (error) {
      this.#options.warn(`[eta] not watching ${root}: ${messageOf(error)}`);
    }
  }

  close(): void {
    clearTimeout(this.#timer);
    this.#watcher?.close();
    this.#watcher = undefined;
  }
}
