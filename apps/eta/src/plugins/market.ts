/**
 * The plugin market: an online catalog of git sources, and the install of one of them.
 *
 * The catalog is one JSON document at a URL the user can change (`plugins.catalogUrl` in the
 * settings), and nothing in it is trusted: it is fetched with a time and a size limit, every entry is
 * checked on its own, and one that does not fit is thrown away with the reason. An entry is a git
 * source whose `rev` is a commit, never a branch or a tag, so what the user was shown is what is
 * installed. Installing is adding that source (`PluginRegistry.add`), after a preview that reads the
 * plugin at the pinned commit and says what it would run. Nothing in the catalog is executed.
 *
 * A catalog that cannot be read is an answer, not a failure: the installed plugins do not depend on it.
 */
import type {
  MarketCatalog,
  MarketEntry,
  MarketPreview,
  MarketRejected,
} from "@eta/client-contracts";
import type { SettingStore } from "../settings/store";
import type { Plugins } from "./service";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { loadPlugin, PluginError } from "@eta/daemon";
import { cleanPath, fetchInto } from "./git";
import { serverViews } from "./server-view";

/** No official catalog is known: the address is the user's to set. */
export const DEFAULT_CATALOG_URL = "";
export const CATALOG_URL_KEY = "plugins.catalogUrl";

const MAX_BYTES = 1024 * 1024;
const TIMEOUT_MS = 10_000;
const MAX_ENTRIES = 500;
const SHA = /^[0-9a-f]{40}$/;
const NAME = /^[a-z0-9](?:[a-z0-9.-]{0,62}[a-z0-9])?$/;
const COMMAND = /^[\w.+-]{1,64}$/;

export interface MarketOptions {
  settings: SettingStore;
  plugins: Plugins;
  dataDir: string;
  maxBytes?: number;
  timeoutMs?: number;
  /** The URL schemes a repository may have. A catalog cannot make eta read a local path. */
  schemes?: readonly string[];
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const isPlain = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function text(entry: Record<string, unknown>, key: string, max: number): string {
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

export class Market {
  readonly #settings: SettingStore;
  readonly #plugins: Plugins;
  readonly #dataDir: string;
  readonly #maxBytes: number;
  readonly #timeoutMs: number;
  readonly #schemes: readonly string[];

  constructor(options: MarketOptions) {
    this.#settings = options.settings;
    this.#plugins = options.plugins;
    this.#dataDir = options.dataDir;
    this.#maxBytes = options.maxBytes ?? MAX_BYTES;
    this.#timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
    this.#schemes = options.schemes ?? ["https:", "ssh:", "git:"];
  }

  #url(): string {
    const saved = this.#settings.get(CATALOG_URL_KEY);
    return typeof saved === "string" ? saved : DEFAULT_CATALOG_URL;
  }

  /** Point the market at another catalog; `""` goes back to the default. */
  async setUrl(url: string): Promise<MarketCatalog> {
    const clean = url.trim();
    if (clean === "") this.#settings.delete(CATALOG_URL_KEY);
    else {
      httpUrl(clean, "the catalog address");
      this.#settings.set(CATALOG_URL_KEY, clean);
    }
    return await this.catalog();
  }

  /** The catalog now, or why there is none. */
  async catalog(): Promise<MarketCatalog> {
    const url = this.#url();
    const base = { url, isDefault: url === DEFAULT_CATALOG_URL };
    if (url === "")
      return {
        ...base,
        entries: null,
        rejected: [],
        error: "no catalog address is set",
      };
    let raw: unknown;
    try {
      raw = await this.#fetch(url);
    } catch (error) {
      return { ...base, entries: null, rejected: [], error: messageOf(error) };
    }
    if (!isPlain(raw) || !Array.isArray(raw.plugins))
      return {
        ...base,
        entries: null,
        rejected: [],
        error: 'the catalog must be an object with a "plugins" list',
      };
    if (raw.plugins.length > MAX_ENTRIES)
      return {
        ...base,
        entries: null,
        rejected: [],
        error: `the catalog lists more than ${MAX_ENTRIES} plugins`,
      };
    const entries: MarketEntry[] = [];
    const rejected: MarketRejected[] = [];
    const seen = new Set<string>();
    raw.plugins.forEach((item: unknown, index: number) => {
      const name =
        isPlain(item) && typeof item.name === "string"
          ? item.name.slice(0, 64)
          : null;
      try {
        const entry = this.#entry(item);
        if (seen.has(entry.name))
          throw new Error(`${entry.name} is listed twice`);
        seen.add(entry.name);
        entries.push(entry);
      } catch (error) {
        rejected.push({ index: index + 1, name, reason: messageOf(error) });
      }
    });
    return { ...base, entries, rejected, error: null };
  }

  /** Read the document with a time limit and a size limit, and parse it. */
  async #fetch(url: string): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(url, {
        signal: AbortSignal.timeout(this.#timeoutMs),
        redirect: "follow",
        headers: { accept: "application/json" },
      });
    } catch (error) {
      throw new Error(`cannot read the catalog: ${this.#reason(error)}`);
    }
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
    try {
      return JSON.parse(new TextDecoder().decode(Buffer.concat(chunks)));
    } catch {
      throw new Error("the catalog is not valid JSON");
    }
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
  #entry(item: unknown): MarketEntry {
    if (!isPlain(item)) throw new Error("an entry must be an object");
    const name = text(item, "name", 64);
    if (!NAME.test(name) || name.includes("--") || name.includes(".."))
      throw new Error(`invalid name ${JSON.stringify(name)}`);
    const repo = text(item, "repo", 512).trim();
    this.#checkRepo(repo);
    const rev = text(item, "rev", 64);
    if (!SHA.test(rev))
      throw new Error(
        "rev must be a full commit hash (40 lowercase hex digits), not a branch, a tag or a short hash",
      );
    let path = "";
    if (item.path !== undefined) {
      if (typeof item.path !== "string") throw new Error("path must be text");
      try {
        path = cleanPath(item.path);
      } catch (error) {
        throw new Error(messageOf(error));
      }
    }
    let homepage: string | null = null;
    if (item.homepage !== undefined) {
      if (typeof item.homepage !== "string" || item.homepage.length > 512)
        throw new Error("homepage must be a URL");
      homepage = httpUrl(item.homepage, "homepage");
    }
    let requires: string[] = [];
    if (item.requires !== undefined) {
      if (
        !Array.isArray(item.requires) ||
        item.requires.length > 20 ||
        !item.requires.every(
          (command) => typeof command === "string" && COMMAND.test(command),
        )
      )
        throw new Error("requires must be a short list of command names");
      requires = item.requires as string[];
    }
    return {
      name,
      description: text(item, "description", 500),
      author: text(item, "author", 100),
      version: text(item, "version", 64),
      repo,
      path,
      rev,
      homepage,
      requires,
      installed: this.#installed(name, repo, path),
    };
  }

  #checkRepo(repo: string): void {
    const scp = /^[\w.-]+@[\w.-]+:[^\s]+$/.test(repo);
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

  #installed(name: string, repo: string, path: string): MarketEntry["installed"] {
    const entry = this.#plugins.registry.get(name);
    if (entry === undefined) return "no";
    return entry.source.kind === "git" &&
      entry.source.repo === repo &&
      entry.source.path === path
      ? "this"
      : "other";
  }

  async #listed(name: string): Promise<MarketEntry> {
    const catalog = await this.catalog();
    if (catalog.entries === null)
      throw new PluginError(catalog.error ?? "no catalog");
    const entry = catalog.entries.find((item) => item.name === name);
    if (entry === undefined)
      throw new PluginError(`${name} is not in the catalog`);
    return entry;
  }

  /** Read the plugin at the pinned commit and say what it would run. Nothing is installed. */
  async preview(name: string): Promise<MarketPreview> {
    const entry = await this.#listed(name);
    const scratch = await mkdtemp(join(this.#dataDir, ".market-"));
    try {
      const dir = join(scratch, "plugin");
      await fetchInto({
        dir,
        repo: entry.repo,
        sha: entry.rev,
        ref: null,
        path: entry.path,
      });
      const plugin = await loadPlugin(dir);
      if (plugin.manifest.name !== entry.name)
        throw new PluginError(
          `the catalog says ${entry.name}, the plugin says ${plugin.manifest.name}`,
        );
      return {
        name: entry.name,
        version: plugin.manifest.version ?? null,
        description: plugin.manifest.description ?? "",
        repo: entry.repo,
        path: entry.path,
        sha: entry.rev,
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
   * Add the entry as a git source at its commit. `sha` is the commit the user confirmed: if the
   * catalog now says another, nothing is installed, and the user is shown the new one first.
   */
  async install(name: string, sha: string): Promise<string> {
    const entry = await this.#listed(name);
    if (entry.rev !== sha)
      throw new PluginError(
        `the catalog now lists ${name} at ${entry.rev.slice(0, 12)}, not ${sha.slice(0, 12)}; look at it again`,
      );
    if (entry.installed === "this")
      throw new PluginError(`${name} is installed; use Update`);
    const added = await this.#plugins.registry.add(
      entry.repo,
      entry.rev,
      entry.path,
    );
    if (added !== entry.name) {
      await this.#plugins.registry.remove(added);
      throw new PluginError(
        `the catalog says ${entry.name}, the plugin says ${added}`,
      );
    }
    return added;
  }
}
