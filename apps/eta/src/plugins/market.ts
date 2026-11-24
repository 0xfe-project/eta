import type {
  MarketCatalog,
  MarketEntry,
  MarketPreview,
  MarketRejected,
  MarketSettings,
  MarketSource,
  MarketSourceCatalog,
} from "@eta/client-contracts";
import type { SettingStore } from "../settings/store";
import type { Composio } from "./composio";
import type { CachedCatalog, CatalogCache } from "./market-cache";
import type { Plugins } from "./service";
/**
 * The plugin market: an online catalog of git sources, and the install of one of them.
 *
 * The catalog is somebody else's `marketplace.json`, in the Claude Code or the Cursor shape, at URLs
 * the user keeps as a list (`plugins.sources` in the settings), each read on its own. Nothing in it is trusted: it is fetched
 * with a time and a size limit, every entry is checked on its own, and one that does not fit is
 * thrown away with the reason. An entry is turned into a git source `{repo, rev, path}`; a source
 * eta does not read is listed and marked unsupported. A `rev` is always a commit: the catalog's
 * `sha`, or, when it has none, the one the host resolves when the entry is previewed. What the user
 * was shown is that commit, and that commit is installed. Installing is adding that source (`PluginRegistry.add`), after a preview that reads the
 * plugin at the pinned commit and says what it would run. Nothing in the catalog is executed.
 *
 * A catalog that cannot be read is an answer, not a failure: the installed plugins do not depend on it.
 */
import { Buffer } from "node:buffer";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { loadPlugin, PluginError } from "@eta/daemon";
import { COMPOSIO_URL } from "./composio";
import {
  cleanPath,
  fetchInto,
  githubProxy,
  normalizeProxy,
  resolveRev,
  viaProxy,
} from "./git";
import { serverViews } from "./server-view";

const CURSOR_URL =
  "https://raw.githubusercontent.com/cursor/plugins/HEAD/.cursor-plugin/marketplace.json";
/** The two public lists the market starts with: both are on. */
export const DEFAULT_SOURCES: readonly MarketSource[] = [
  {
    name: "Anthropic",
    url: "https://raw.githubusercontent.com/anthropics/claude-plugins-official/main/.claude-plugin/marketplace.json",
    enabled: true,
  },
  { name: "Cursor", url: CURSOR_URL, enabled: true },
];
export const SOURCES_KEY = "plugins.sources";
export const PROXY_KEY = "plugins.githubProxy";
/** The single address an earlier version kept; read once and moved into the list. */
export const LEGACY_URL_KEY = "plugins.catalogUrl";

const MAX_BYTES = 1024 * 1024;
const TIMEOUT_MS = 10_000;
const MAX_ENTRIES = 500;
const SHA = /^[0-9a-f]{40}$/;
const NAME = /^[a-z0-9](?:[a-z0-9.-]{0,62}[a-z0-9])?$/;

export interface MarketOptions {
  settings: SettingStore;
  plugins: Plugins;
  dataDir: string;
  maxBytes?: number;
  timeoutMs?: number;
  /** The URL schemes a repository may have. A catalog cannot make eta read a local path. */
  schemes?: readonly string[];
  /** The repository the catalog is in, when its address does not say (a test's local one). */
  catalogRepo?: string;
  /** Where catalogs are kept between runs; without it every read goes to the network. */
  cache?: CatalogCache;
  /** The Composio source; without it the market has git catalogs only. */
  composio?: Composio;
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const isPlain = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function text(
  entry: Record<string, unknown>,
  key: string,
  max: number,
): string {
  const value = entry[key];
  if (typeof value !== "string" || value.trim() === "")
    throw new Error(`${key} is missing`);
  if (value.length > max) throw new Error(`${key} is longer than ${max}`);
  return value;
}

function httpUrl(value: string, key: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${key} is not a URL`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:")
    throw new Error(`${key} is not an http(s) URL`);
  return value;
}

interface Origin {
  /** The repository the catalog itself is in, when its address says which. */
  repo: string | null;
  ref: string;
  /** `metadata.pluginRoot`: where a relative `source` starts. */
  root: string;
}

function originOf(url: string, metadata: unknown): Origin {
  let repo: string | null = null;
  let ref = "HEAD";
  try {
    const address = new URL(url);
    if (address.hostname === "raw.githubusercontent.com") {
      const [owner, name, at] = address.pathname.split("/").filter(Boolean);
      if (owner !== undefined && name !== undefined && at !== undefined) {
        repo = `https://github.com/${owner}/${name}.git`;
        ref = at;
      }
    }
  } catch {
    // The address was checked when it was set.
  }
  const root =
    isPlain(metadata) && typeof metadata.pluginRoot === "string"
      ? metadata.pluginRoot
      : "";
  return { repo, ref, root };
}

export class Market {
  readonly #settings: SettingStore;
  readonly #plugins: Plugins;
  readonly #dataDir: string;
  readonly #maxBytes: number;
  readonly #timeoutMs: number;
  readonly #schemes: readonly string[];
  readonly #catalogRepo: string | undefined;
  readonly #cache: CatalogCache | undefined;
  readonly #composio: Composio | undefined;

  constructor(options: MarketOptions) {
    this.#settings = options.settings;
    this.#plugins = options.plugins;
    this.#dataDir = options.dataDir;
    this.#maxBytes = options.maxBytes ?? MAX_BYTES;
    this.#timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
    this.#schemes = options.schemes ?? ["https:", "ssh:", "git:"];
    this.#catalogRepo = options.catalogRepo;
    this.#cache = options.cache;
    this.#composio = options.composio;
    this.#proxy();
  }

  /** The proxy prefix now; also what every `git` call of the host goes through. */
  #proxy(): string {
    const saved = this.#settings.get(PROXY_KEY);
    githubProxy.prefix = typeof saved === "string" ? saved : "";
    return githubProxy.prefix;
  }

  /** The git catalogs, then Composio when there is one: it is always listed, on unless switched off. */
  sources(): MarketSource[] {
    const git = this.#gitSources();
    return this.#composio === undefined
      ? git
      : [...git, this.#composio.source()];
  }

  /** The git catalogs, read when asked: the stored list, else the defaults (or the old single address). */
  #gitSources(): MarketSource[] {
    const saved = this.#settings.get(SOURCES_KEY);
    if (Array.isArray(saved))
      return saved.flatMap((item: unknown) =>
        isPlain(item) && typeof item.url === "string"
          ? [
              {
                url: item.url,
                name: typeof item.name === "string" ? item.name : "",
                // Stored without the flag (an earlier version): on.
                enabled: item.enabled !== false,
              },
            ]
          : [],
      );
    const list = DEFAULT_SOURCES.map((item) => ({ ...item }));
    const old = this.#settings.get(LEGACY_URL_KEY);
    if (old === undefined) return list;
    // An address from before there was a list: kept, after the defaults; `""` was "no catalog".
    if (old === "") list.length = 0;
    else if (typeof old === "string") {
      // An address the user chose is on, and is not listed twice.
      const same = list.find((item) => item.url === old);
      if (same === undefined) list.push({ name: "", url: old, enabled: true });
      else same.enabled = true;
    }
    this.#settings.set(SOURCES_KEY, list);
    this.#settings.delete(LEGACY_URL_KEY);
    return list;
  }

  settings(): MarketSettings {
    return { sources: this.sources(), proxy: this.#proxy() };
  }

  addSource(url: string, name: string): MarketSettings {
    const clean = url.trim();
    try {
      httpUrl(clean, "the address");
    } catch (error) {
      throw new PluginError(messageOf(error));
    }
    const list = this.#gitSources();
    if (list.some((item) => item.url === clean))
      throw new PluginError("that address is in the list already");
    const label = name.trim().slice(0, 60);
    this.#settings.set(SOURCES_KEY, [
      ...list,
      { url: clean, name: label, enabled: true },
    ]);
    return this.settings();
  }

  removeSource(url: string): MarketSettings {
    if (url === COMPOSIO_URL)
      throw new PluginError("Composio is built in: switch it off instead");
    const list = this.#gitSources();
    if (!list.some((item) => item.url === url))
      throw new PluginError("that address is not in the list");
    this.#settings.set(
      SOURCES_KEY,
      list.filter((item) => item.url !== url),
    );
    return this.settings();
  }

  /** Switch a source on or off; it stays in the list either way. */
  setSourceEnabled(url: string, enabled: boolean): MarketSettings {
    if (url === COMPOSIO_URL && this.#composio !== undefined) {
      this.#composio.setEnabled(enabled);
      return this.settings();
    }
    const list = this.#gitSources();
    if (!list.some((item) => item.url === url))
      throw new PluginError("that address is not in the list");
    this.#settings.set(
      SOURCES_KEY,
      list.map((item) => (item.url === url ? { ...item, enabled } : item)),
    );
    return this.settings();
  }

  /** The GitHub proxy prefix; `""` turns it off. */
  setProxy(prefix: string): MarketSettings {
    const clean = normalizeProxy(prefix);
    if (clean === "") this.#settings.delete(PROXY_KEY);
    else this.#settings.set(PROXY_KEY, clean);
    return this.settings();
  }

  /** Every source's catalog, each read on its own: one that fails does not hide the others. */
  async catalog(
    mode: "refresh" | "cached" = "refresh",
    only?: string,
  ): Promise<MarketCatalog> {
    const proxy = this.#proxy();
    const sources = await Promise.all(
      this.sources()
        // `only`: one source's address, so a slow source does not hold the others back.
        .filter(
          (source) =>
            source.enabled && (only === undefined || source.url === only),
        )
        .map(async (source) =>
          source.kind === "composio" && this.#composio !== undefined
            ? await this.#composio.read(source, mode)
            : await this.#read(source, proxy, new Map(), mode),
        ),
    );
    return { sources, proxy };
  }

  /** Forget every kept catalog; the next read goes to the network. */
  clearCache(): number {
    return this.#cache?.clear() ?? 0;
  }

  /** The document must be a marketplace: throws the reason it is not. */
  #shape(raw: unknown): Record<string, unknown> & { plugins: unknown[] } {
    if (!isPlain(raw) || !Array.isArray(raw.plugins))
      throw new Error(
        'the catalog must be an object with a "plugins" list (a Claude Code or Cursor marketplace.json)',
      );
    if (raw.plugins.length > MAX_ENTRIES)
      throw new Error(`the catalog lists more than ${MAX_ENTRIES} plugins`);
    return raw as Record<string, unknown> & { plugins: unknown[] };
  }

  /** A kept catalog, checked again as if it had just come: undefined when it no longer passes. */
  #fromCache(cached: CachedCatalog | undefined): unknown {
    if (cached === undefined) return undefined;
    try {
      const raw: unknown = JSON.parse(cached.text);
      this.#shape(raw);
      return raw;
    } catch {
      return undefined;
    }
  }

  /** One source: its entries, or why there are none. */
  async #read(
    source: MarketSource,
    proxy: string,
    refs: Map<string, string>,
    mode: "refresh" | "cached" = "refresh",
  ): Promise<MarketSourceCatalog> {
    const { url } = source;
    // The key is the address as written: another address, or the same one after the user changed it
    // back, is another row; the proxy is a way to reach it, not a part of what it is.
    const cached = this.#cache?.get(url, Date.now());
    let raw: unknown;
    let updatedAt: number | null = null;
    let stale: string | null = null;
    if (mode === "cached") {
      raw = this.#fromCache(cached);
      if (raw === undefined) {
        if (cached !== undefined) this.#cache?.delete(url);
        // Nothing kept: no answer yet, and not a failure.
        return {
          source,
          entries: null,
          rejected: [],
          error: null,
          updatedAt: null,
          stale: null,
        };
      }
      updatedAt = cached!.fetchedAt;
    } else {
      try {
        const got = await this.#download(viaProxy(url, proxy), cached);
        const now = Date.now();
        if (got === "same") {
          raw = this.#fromCache(cached);
          if (raw === undefined)
            throw new Error("the kept catalog can no longer be used");
          this.#cache?.confirm(url, now);
        } else {
          try {
            raw = JSON.parse(got.text);
          } catch {
            throw new Error("the catalog is not valid JSON");
          }
          this.#shape(raw);
          this.#cache?.put(url, got.text, got.etag, got.lastModified, now);
        }
        updatedAt = now;
      } catch (error) {
        // The network failed or the answer was bad: a kept catalog stays, with its age and the reason.
        const kept = this.#fromCache(cached);
        if (kept === undefined)
          return {
            source,
            entries: null,
            rejected: [],
            error: messageOf(error),
            updatedAt: null,
            stale: null,
          };
        raw = kept;
        updatedAt = cached!.fetchedAt;
        stale = messageOf(error);
      }
    }
    if (!isPlain(raw) || !Array.isArray(raw.plugins))
      return {
        source,
        entries: null,
        rejected: [],
        error:
          'the catalog must be an object with a "plugins" list (a Claude Code or Cursor marketplace.json)',
      };
    if (raw.plugins.length > MAX_ENTRIES)
      return {
        source,
        entries: null,
        rejected: [],
        error: `the catalog lists more than ${MAX_ENTRIES} plugins`,
      };
    const entries: MarketEntry[] = [];
    const rejected: MarketRejected[] = [];
    const seen = new Set<string>();
    // The repository is read from the address as written, before any proxy is put in front of it.
    const origin = originOf(url, raw.metadata);
    if (this.#catalogRepo !== undefined) origin.repo = this.#catalogRepo;
    raw.plugins.forEach((item: unknown, index: number) => {
      const name =
        isPlain(item) && typeof item.name === "string"
          ? item.name.slice(0, 64)
          : null;
      try {
        const { entry, ref } = this.#entry(item, origin, source);
        if (seen.has(entry.name))
          throw new Error(`${entry.name} is listed twice`);
        seen.add(entry.name);
        refs.set(`${url}\n${entry.name}`, ref);
        entries.push(entry);
      } catch (error) {
        rejected.push({ index: index + 1, name, reason: messageOf(error) });
      }
    });
    return { source, entries, rejected, error: null, updatedAt, stale };
  }

  /** Read the document with a time limit and a size limit; `"same"` when the server says it is as kept. */
  async #download(
    url: string,
    cached: CachedCatalog | undefined,
  ): Promise<
    { text: string; etag: string | null; lastModified: string | null } | "same"
  > {
    let response: Response;
    try {
      response = await fetch(url, {
        signal: AbortSignal.timeout(this.#timeoutMs),
        redirect: "follow",
        headers: {
          accept: "application/json",
          ...(cached?.etag ? { "if-none-match": cached.etag } : {}),
          ...(cached?.lastModified
            ? { "if-modified-since": cached.lastModified }
            : {}),
        },
      });
    } catch (error) {
      throw new Error(`cannot read the catalog: ${this.#reason(error)}`);
    }
    if (response.status === 304 && cached !== undefined) return "same";
    if (!response.ok)
      throw new Error(`cannot read the catalog: HTTP ${response.status}`);
    const length = Number(response.headers.get("content-length") ?? 0);
    if (length > this.#maxBytes) throw this.#tooBig();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      const reader = response.body?.getReader();
      for (;;) {
        const part = await reader?.read();
        if (part === undefined || part.done) break;
        size += part.value.byteLength;
        if (size > this.#maxBytes) {
          await reader?.cancel();
          throw this.#tooBig();
        }
        chunks.push(part.value);
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes("larger than"))
        throw error;
      throw new Error(`cannot read the catalog: ${this.#reason(error)}`);
    }
    return {
      text: new TextDecoder().decode(Buffer.concat(chunks)),
      etag: response.headers.get("etag"),
      lastModified: response.headers.get("last-modified"),
    };
  }

  #tooBig(): Error {
    return new Error(`the catalog is larger than ${this.#maxBytes} bytes`);
  }

  #reason(error: unknown): string {
    return error instanceof Error &&
      (error.name === "TimeoutError" || error.name === "AbortError")
      ? `no answer in ${this.#timeoutMs} ms`
      : messageOf(error);
  }

  /** One entry as it must be; throws the reason it is not. */
  #entry(
    item: unknown,
    origin: Origin,
    from: MarketSource,
  ): { entry: MarketEntry; ref: string } {
    if (!isPlain(item)) throw new Error("an entry must be an object");
    const name = text(item, "name", 64);
    if (!NAME.test(name) || name.includes("--") || name.includes(".."))
      throw new Error(`invalid name ${JSON.stringify(name)}`);
    const source = this.#source(item.source, origin);
    let homepage: string | null = null;
    if (typeof item.homepage === "string" && item.homepage.length <= 512) {
      try {
        homepage = httpUrl(item.homepage, "homepage");
      } catch {
        homepage = null;
      }
    }
    const author = isPlain(item.author) ? item.author.name : item.author;
    const description =
      typeof item.description === "string" ? item.description : "";
    return {
      ref: source.ref,
      entry: {
        name,
        description:
          description.length > 500
            ? `${description.slice(0, 499)}…`
            : description,
        author: typeof author === "string" ? author.slice(0, 100) : "",
        version:
          typeof item.version === "string" ? item.version.slice(0, 64) : "",
        repo: source.repo,
        path: source.path,
        rev: source.rev,
        homepage,
        requires: [],
        installed:
          source.unsupported === null
            ? this.#installed(name, source.repo, source.path)
            : "no",
        unsupported: source.unsupported,
        source: from.url,
        sourceName: from.name === "" ? from.url : from.name,
      },
    };
  }

  /**
   * The git source a catalog `source` stands for: a path in the catalog's own repository, a
   * repository (`url`), or a directory of one (`git-subdir`). Anything else is kept and says why
   * it cannot be installed.
   */
  #source(
    source: unknown,
    origin: Origin,
  ): {
    repo: string;
    path: string;
    rev: string | null;
    ref: string;
    unsupported: string | null;
  } {
    const unsupported = (why: string) => ({
      repo: "",
      path: "",
      rev: null,
      ref: "HEAD",
      unsupported: `format not supported: ${why}`,
    });
    if (typeof source === "string") {
      if (origin.repo === null)
        return unsupported(
          "a path in the catalog's repository, and the catalog is not on raw.githubusercontent.com",
        );
      const path = cleanPath(
        [origin.root, source].filter((part) => part !== "").join("/"),
      );
      this.#checkRepo(origin.repo);
      return {
        repo: origin.repo,
        path,
        rev: null,
        ref: origin.ref,
        unsupported: null,
      };
    }
    if (
      !isPlain(source) ||
      (source.source !== "url" && source.source !== "git-subdir")
    )
      return unsupported(
        `source ${isPlain(source) ? JSON.stringify(source.source) : typeof source}`,
      );
    const repo = text(source, "url", 512).trim();
    this.#checkRepo(repo);
    const path =
      source.source === "git-subdir"
        ? cleanPath(text(source, "path", 256))
        : "";
    let rev: string | null = null;
    if (source.sha !== undefined) {
      if (typeof source.sha !== "string" || !SHA.test(source.sha))
        throw new Error(
          "sha must be a full commit hash (40 lowercase hex digits)",
        );
      rev = source.sha;
    }
    const ref =
      typeof source.ref === "string" && source.ref !== "" ? source.ref : "HEAD";
    return { repo, path, rev, ref, unsupported: null };
  }

  #checkRepo(repo: string): void {
    const scp = /^[\w.-]+@[\w.-]+:\S+$/.test(repo);
    let ok = scp && this.#schemes.includes("ssh:");
    if (!scp) {
      try {
        ok = this.#schemes.includes(new URL(repo).protocol);
      } catch {
        ok = false;
      }
    }
    if (!ok || repo.startsWith("-"))
      throw new Error(`repo is not a repository address eta takes: ${repo}`);
  }

  /** "this": a git source of this repository and path is installed already. */
  #installed(
    name: string,
    repo: string,
    path: string,
  ): MarketEntry["installed"] {
    const same = this.#plugins.registry
      .entries()
      .some(
        ({ source }) =>
          source.kind === "git" && source.repo === repo && source.path === path,
      );
    if (same) return "this";
    return this.#plugins.registry.get(name) === undefined ? "no" : "other";
  }

  async #listed(
    name: string,
    url: string,
  ): Promise<{ entry: MarketEntry; ref: string }> {
    const proxy = this.#proxy();
    const source = this.#gitSources().find(
      (item) => item.url === url && item.enabled,
    );
    if (source === undefined)
      throw new PluginError(`${url} is not one of the plugin sources`);
    const refs = new Map<string, string>();
    const read = await this.#read(source, proxy, refs);
    if (read.entries === null)
      throw new PluginError(read.error ?? "no catalog");
    const entry = read.entries.find((item) => item.name === name);
    if (entry === undefined)
      throw new PluginError(`${name} is not in the catalog`);
    if (entry.unsupported !== null)
      throw new PluginError(`${name}: ${entry.unsupported}`);
    return { entry, ref: refs.get(`${url}\n${name}`) ?? "HEAD" };
  }

  /** Read the plugin at the pinned commit and say what it would run. Nothing is installed. */
  async preview(name: string, source: string): Promise<MarketPreview> {
    const { entry, ref } = await this.#listed(name, source);
    // The commit the user is shown: the catalog's, or the repository's right now, once.
    const sha = entry.rev ?? (await resolveRev(entry.repo, ref)).sha;
    const scratch = await mkdtemp(join(this.#dataDir, ".market-"));
    try {
      const dir = join(scratch, "plugin");
      await fetchInto({
        dir,
        repo: entry.repo,
        sha,
        ref: null,
        path: entry.path,
      });
      const plugin = await loadPlugin(dir);
      return {
        name: entry.name,
        version: plugin.manifest.version ?? null,
        description: plugin.manifest.description ?? "",
        repo: entry.repo,
        path: entry.path,
        sha,
        proxy: viaProxy(entry.repo) === entry.repo ? null : githubProxy.prefix,
        requires: plugin.requires,
        servers: serverViews(plugin).map((view, index) => {
          const { config } = plugin.servers[index]!;
          return {
            ...view,
            fixedEnv: config.type === "stdio" ? config.env : {},
            cwd: config.type === "stdio" ? (config.cwd ?? null) : null,
          };
        }),
        skills: plugin.skills.map(({ name: skill, description }) => ({
          name: skill,
          description,
        })),
        reports: plugin.reports,
        layout: plugin.layout ?? null,
        fields: plugin.fields.map((field) => ({
          name: field.name,
          secret: field.secret === true,
          required: field.required === true,
        })),
      };
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }

  /**
   * Add the entry as a git source at `sha`, the commit the user confirmed. A catalog that pins a
   * commit must still pin that one; if it now says another, nothing is installed, and the user is
   * shown the new one first. The plugin keeps the name its own manifest gives it.
   */
  async install(name: string, source: string, sha: string): Promise<string> {
    const { entry } = await this.#listed(name, source);
    if (!SHA.test(sha)) throw new PluginError("sha must be a full commit hash");
    if (entry.rev !== null && entry.rev !== sha)
      throw new PluginError(
        `the catalog now lists ${name} at ${entry.rev.slice(0, 12)}, not ${sha.slice(0, 12)}; look at it again`,
      );
    if (entry.installed === "this")
      throw new PluginError(`${name} is installed; use Update`);
    return await this.#plugins.registry.add(entry.repo, sha, entry.path);
  }
}
