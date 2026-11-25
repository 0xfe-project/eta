/**
 * The market's Composio source: the list of Composio toolkits, and the link that starts connecting one.
 *
 * Composio is a hosted service: the host talks to it with the user's API key, which is kept sealed
 * (one row of the `credential` table: integration "market", key "composio") and goes only to https://backend.composio.dev, in the `x-api-key` header, with
 * redirects refused so it cannot follow one elsewhere. The key is no part of a cache key, a log
 * line, an error text or any answer to a client; a message that was built from a remote answer is
 * cleaned of it again. Nothing here installs anything: connecting a toolkit is Composio's own
 * sign-in page, which the user opens from the link this returns.
 *
 * The list is Composio's and is not trusted: it is read with a time limit, a page limit and a size
 * limit, every entry is checked on its own, and one that does not fit is left out. What is kept
 * between runs is the checked list, not the answer as it came. No key: the source says so; it is not
 * a failure and does not touch the other sources. A 401 says the key was refused, and only here.
 */
import type {
  ComposioAuth,
  ComposioPluginView,
  ComposioStatus,
  ComposioToolkit,
  MarketSource,
  MarketSourceCatalog,
  Redaction,
} from "@eta/client-contracts";
import type { McpConfigSource } from "@eta/mcp";
import type { Database } from "bun:sqlite";
import type { SettingStore } from "../settings/store";
import type { CatalogCache } from "./market-cache";
import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import {
  COMPOSIO_NO_MANAGED_LOGIN,
  composioOwnScheme,
} from "@eta/client-contracts";
import { PluginError } from "@eta/daemon";
import { EncryptedCredentialTable } from "../credentials/table";

/** The address the source has in `MarketSource.url`: not a web address, only a name. */
export const COMPOSIO_URL = "composio:toolkits";
const COMPOSIO_NAME = "Composio";
/** Whether the source is on; absent means on, like any source that was added. */
const COMPOSIO_ENABLED_KEY = "plugins.composioEnabled";
const USER_ID_KEY = "plugins.composioUserId";
/** Where the key is kept: the same row shape as another market source's credential (see PluginStore). */
const CREDENTIAL = { integration: "market", key: "composio", kind: "secret" };
/** The kept id of a session is a row of its own beside the key's: `composio-session:<set>` (see `#setKey`). */
const SESSION_PREFIX = "composio-session:";

/** The toolkits that need no sign-in and were added, as slugs: plugins like the connected ones. */
const ADDED_KEY = "plugins.composioAdded";

/** The plugin name of a connected (or added) toolkit: `@composio/<slug>`. */
const VIRTUAL_PREFIX = "@composio/";
/** The sessions kept, as their keys only (the ids are sealed rows of their own): to erase them all. */
const SESSIONS_KEY = "plugins.composioSessions";
const SESSION_PATH = "/api/v3.1/tool_router/session";
const SESSION_ID = /^[\w.-]{1,200}$/;
/** How many sessions are made at once, and how long a failed one waits before one more try. */
const MAKE_AT_ONCE = 3;
const RETRY_MS = 5 * 60_000;

const BASE = "https://backend.composio.dev";
const PAGE = 100;
const MAX_PAGES = 30;
const MAX_TOOLKITS = 3000;
const MAX_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 10_000;
const KEY_SHAPE = /^[\x21-\x7E]{1,512}$/;
const SLUG = /^[\w-]{1,100}$/;
/** The key of a session: the slugs of its toolkits, sorted and joined by commas. One slug is its own key. */
const SET = /^[\w-]{1,100}(?:,[\w-]{1,100})*$/;
/** The one server an agent gets, whatever toolkits stand behind it, so its tools keep their names. */
const SERVER = "composio";

export interface ComposioOptions {
  db: Database;
  /** The host's secret key (`loadSecretKey`). */
  key: Buffer;
  settings: SettingStore;
  cache?: CatalogCache;
  /** Tests only: a local fake in place of https://backend.composio.dev. */
  baseUrl?: string;
  timeoutMs?: number;
  maxBytes?: number;
  /** Tests only: the clock the retry pause is read from. */
  now?: () => number;
}

/** What Composio said was not what was asked for, or not where it must be: no retry in this run. */
class Unchecked extends Error {}

/** One session, for a set of toolkits: usable, or why not yet (`retryAt`: when one more try may be made). */
type Session =
  | { state: "ready"; id: string; url: string }
  | { state: "error"; retryAt: number };

/** The server answered, and said no (`status`), or did not answer (`null`). */
class Refused extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null) {
    super(message);
    this.status = status;
  }
}

const isPlain = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const OAUTH = new Set([
  "OAUTH2",
  "OAUTH1",
  "DCR_OAUTH",
  "CIMD_OAUTH",
  "S2S_OAUTH2",
]);
const API_KEY = new Set([
  "API_KEY",
  "BEARER_TOKEN",
  "BASIC",
  "BASIC_WITH_JWT",
  "BILLCOM_AUTH",
  "CALCOM_AUTH",
]);

/**
 * The sign-in a user meets. Composio's own (managed) schemes come first, since that is what the link
 * uses; within a list OAuth comes before a key. A scheme eta does not know is `unknown`, and so is
 * a toolkit that lists none.
 */
export function authOf(
  schemes: readonly string[],
  managed: readonly string[],
  none: boolean,
): ComposioAuth {
  if (none || (schemes.length === 1 && schemes[0] === "NO_AUTH")) return "none";
  for (const list of [managed, schemes]) {
    if (list.some((scheme) => OAUTH.has(scheme))) return "oauth";
    if (list.some((scheme) => API_KEY.has(scheme))) return "api_key";
  }
  return "unknown";
}

const strings = (value: unknown, max: number): string[] =>
  Array.isArray(value)
    ? value
        .flatMap((item) =>
          typeof item === "string" && item.length <= max ? [item] : [],
        )
        .slice(0, 50)
    : [];

function https(value: unknown, max = 512): string | null {
  if (typeof value !== "string" || value.length > max) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      url.username === "" &&
      url.password === ""
      ? value
      : null;
  } catch {
    return null;
  }
}

/** One toolkit as it must be; null for one that does not fit. */
function toolkit(item: unknown, from: MarketSource): ComposioToolkit | null {
  if (!isPlain(item) || typeof item.slug !== "string" || !SLUG.test(item.slug))
    return null;
  const meta = isPlain(item.meta) ? item.meta : {};
  const name =
    typeof item.name === "string" && item.name.trim() !== ""
      ? item.name.slice(0, 100)
      : item.slug;
  const description =
    typeof meta.description === "string" ? meta.description : "";
  const schemes = strings(item.auth_schemes, 40);
  const managed = strings(item.composio_managed_auth_schemes, 40);
  const categories = Array.isArray(meta.categories)
    ? meta.categories.flatMap((one: unknown) => {
        const label = isPlain(one) ? one.name : one;
        return typeof label === "string" && label.length <= 60 ? [label] : [];
      })
    : [];
  return {
    kind: "composio",
    slug: item.slug,
    name,
    description:
      description.length > 500 ? `${description.slice(0, 499)}…` : description,
    auth: authOf(schemes, managed, item.no_auth === true),
    authSchemes: schemes,
    managed: managed.length > 0,
    categories: categories.slice(0, 10),
    logo: https(meta.logo),
    appUrl: https(meta.app_url),
    toolsCount:
      typeof meta.tools_count === "number" && Number.isFinite(meta.tools_count)
        ? meta.tools_count
        : null,
    source: from.url,
    sourceName: from.name === "" ? from.url : from.name,
  };
}

const AUTHS = new Set<string>(["api_key", "oauth", "none", "unknown"]);

/**
 * One toolkit as it was kept (the shape of `ComposioToolkit` without its source), checked again
 * field by field: what is kept is the checked list, not Composio's answer, so it is not read back
 * through `toolkit`. Null for one that does not fit.
 */
function kept(item: unknown, from: MarketSource): ComposioToolkit | null {
  if (!isPlain(item) || typeof item.slug !== "string" || !SLUG.test(item.slug))
    return null;
  const name =
    typeof item.name === "string" && item.name.trim() !== ""
      ? item.name.slice(0, 100)
      : item.slug;
  const description =
    typeof item.description === "string" ? item.description : "";
  return {
    kind: "composio",
    slug: item.slug,
    name,
    description:
      description.length > 500 ? `${description.slice(0, 499)}…` : description,
    auth:
      typeof item.auth === "string" && AUTHS.has(item.auth)
        ? (item.auth as ComposioAuth)
        : "unknown",
    authSchemes: strings(item.authSchemes, 40),
    managed: item.managed === true,
    categories: strings(item.categories, 60).slice(0, 10),
    logo: https(item.logo),
    appUrl: https(item.appUrl),
    toolsCount:
      typeof item.toolsCount === "number" && Number.isFinite(item.toolsCount)
        ? item.toolsCount
        : null,
    source: from.url,
    sourceName: from.name === "" ? from.url : from.name,
  };
}

export class Composio {
  readonly #credentials: EncryptedCredentialTable;
  readonly #settings: SettingStore;
  readonly #cache: CatalogCache | undefined;
  readonly #base: string;
  readonly #timeoutMs: number;
  readonly #maxBytes: number;
  readonly #now: () => number;
  /** The sessions made, by key (`#setKey`). */
  readonly #sessions = new Map<string, Session>();
  readonly #making = new Map<string, Promise<void>>();
  readonly #listeners: (() => void)[] = [];
  /** Moves when the key goes, so a session still being made for the old one is thrown away. */
  #epoch = 0;
  /** The toolkits that are connected or added, as the last `sync` said; unknown until then. */
  #wanted: Set<string> | undefined;
  /** What the agents have enabled, as toolkit names, one list for each agent (`demand`). */
  #demand: (() => string[][]) | undefined;
  /** The managed auth config found or made for a toolkit; asked once per run. */
  readonly #configs = new Map<string, string>();
  /** The toolkits whose managed auth configs were looked at for the tool router's switch in this run. */
  readonly #routed = new Set<string>();
  /** Logo addresses of the list last read, by slug: the client names a slug, never an address. */
  #logos: Map<string, string> | undefined;

  constructor(options: ComposioOptions) {
    this.#credentials = new EncryptedCredentialTable(options.db, options.key);
    this.#settings = options.settings;
    this.#cache = options.cache;
    this.#base = options.baseUrl ?? BASE;
    this.#timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
    this.#maxBytes = options.maxBytes ?? MAX_BYTES;
    this.#now = options.now ?? Date.now;
  }

  /**
   * The source as the market lists it: always there. It is on when there is a key and the user did
   * not switch it off; with no key it is off, and nothing is written to the setting for that, so a
   * key saved later turns it on again unless the user had switched it off.
   */
  source(): MarketSource {
    return {
      url: COMPOSIO_URL,
      name: COMPOSIO_NAME,
      enabled:
        this.#settings.get(COMPOSIO_ENABLED_KEY) !== false && this.hasKey(),
      kind: "composio",
    };
  }

  setEnabled(enabled: boolean): void {
    if (enabled) this.#settings.delete(COMPOSIO_ENABLED_KEY);
    else this.#settings.set(COMPOSIO_ENABLED_KEY, false);
    this.#notify();
  }

  /* -------------------------------------------------------------------- key */

  hasKey(): boolean {
    return this.#apiKey() !== undefined;
  }

  setKey(key: string): void {
    const clean = key.trim();
    if (!KEY_SHAPE.test(clean))
      throw new PluginError(
        "the API key must be one line of visible characters, up to 512",
      );
    this.#credentials.write(
      CREDENTIAL.integration,
      CREDENTIAL.key,
      CREDENTIAL.kind,
      clean,
    );
    // Another key may be another project: what was found for the old one is not known for this.
    this.#configs.clear();
    this.#routed.clear();
    this.#dropAll();
  }

  clearKey(): void {
    this.#credentials.erase(
      CREDENTIAL.integration,
      CREDENTIAL.key,
      CREDENTIAL.kind,
    );
    this.#configs.clear();
    this.#routed.clear();
    this.#dropAll();
  }

  /** The key, only for the header of a call to Composio. A row that does not open, or is no string, reads as no key. */
  #apiKey(): string | undefined {
    const value = this.#credentials.read(
      CREDENTIAL.integration,
      CREDENTIAL.key,
      CREDENTIAL.kind,
    );
    return typeof value === "string" ? value : undefined;
  }

  /* ------------------------------------------------------------------- list */

  /** The toolkits, or why there are none. `cached`: only what is kept, at once. */
  async read(
    source: MarketSource,
    mode: "refresh" | "cached",
  ): Promise<MarketSourceCatalog> {
    const answer = (
      status: ComposioStatus,
      rest: Partial<MarketSourceCatalog> & {
        toolkits?: ComposioToolkit[] | null;
      } = {},
    ): MarketSourceCatalog => ({
      source,
      entries:
        rest.toolkits === undefined || rest.toolkits === null ? null : [],
      rejected: [],
      error: null,
      updatedAt: null,
      stale: null,
      status,
      toolkits: null,
      ...rest,
    });
    const key = this.#apiKey();
    if (key === undefined) {
      this.#logos = undefined;
      return answer("needs_key");
    }
    const cached = this.#fromCache(source);
    if (mode === "cached")
      return cached === undefined
        ? answer("ready")
        : this.#ready(answer, cached.toolkits, cached.at);
    try {
      const toolkits = await this.#download(key, source);
      const now = Date.now();
      this.#cache?.put(
        COMPOSIO_URL,
        JSON.stringify(
          toolkits.map(({ source: _a, sourceName: _b, ...rest }) => rest),
        ),
        null,
        null,
        now,
      );
      return this.#ready(answer, toolkits, now);
    } catch (error) {
      if (error instanceof Refused && error.status === 401) {
        this.#logos = undefined;
        return answer("key_rejected");
      }
      const why = this.#clean(error, key);
      if (cached === undefined) return answer("error", { error: why });
      return this.#ready(answer, cached.toolkits, cached.at, why);
    }
  }

  #ready(
    answer: (
      status: ComposioStatus,
      rest?: Partial<MarketSourceCatalog>,
    ) => MarketSourceCatalog,
    toolkits: ComposioToolkit[],
    at: number,
    stale: string | null = null,
  ): MarketSourceCatalog {
    this.#remember(toolkits);
    return answer("ready", { toolkits, updatedAt: at, stale });
  }

  #remember(toolkits: readonly ComposioToolkit[]): void {
    this.#logos = new Map(
      toolkits.flatMap((one) =>
        one.logo === null ? [] : [[one.slug, one.logo] as const],
      ),
    );
  }

  /** The kept list, checked again as if it had just come; a row that no longer passes is dropped. */
  #fromCache(
    source: MarketSource,
  ): { toolkits: ComposioToolkit[]; at: number } | undefined {
    const row = this.#cache?.get(COMPOSIO_URL, Date.now());
    if (row === undefined) return undefined;
    try {
      const raw: unknown = JSON.parse(row.text);
      if (!Array.isArray(raw) || raw.length > MAX_TOOLKITS)
        throw new Error("not a list");
      return {
        toolkits: raw.flatMap((item) => kept(item, source) ?? []),
        at: row.fetchedAt,
      };
    } catch {
      this.#cache?.delete(COMPOSIO_URL);
      return undefined;
    }
  }

  async #download(
    key: string,
    source: MarketSource,
  ): Promise<ComposioToolkit[]> {
    const toolkits: ComposioToolkit[] = [];
    const seen = new Set<string>();
    let cursor: string | null = null;
    for (let page = 1; ; page++) {
      if (page > MAX_PAGES)
        throw new Error(`the list is longer than ${MAX_PAGES} pages`);
      const query = new URLSearchParams({ limit: String(PAGE) });
      if (cursor !== null) query.set("cursor", cursor);
      const body = await this.#call("GET", `/api/v3/toolkits?${query}`, key);
      if (!isPlain(body) || !Array.isArray(body.items))
        throw new Error("the answer is not a list of toolkits");
      for (const item of body.items) {
        const one = toolkit(item, source);
        if (one === null || seen.has(one.slug)) continue;
        seen.add(one.slug);
        toolkits.push(one);
      }
      if (toolkits.length > MAX_TOOLKITS)
        throw new Error(`the list has more than ${MAX_TOOLKITS} toolkits`);
      const next: unknown = body.next_cursor;
      if (typeof next !== "string" || next === "" || body.items.length === 0)
        return toolkits;
      if (next === cursor) throw new Error("the list pages do not end");
      cursor = next;
    }
  }

  /**
   * The name and description of the toolkits asked for, from the kept list only (no request is
   * made); a slug the list does not have is left out. With no key there is nothing to say.
   */
  toolkitsOf(
    slugs: readonly string[],
  ): { slug: string; name: string; description: string }[] {
    if (this.#apiKey() === undefined) return [];
    const wanted = new Set(slugs);
    return (this.#fromCache(this.source())?.toolkits ?? [])
      .filter((one) => wanted.has(one.slug))
      .map(({ slug, name, description }) => ({ slug, name, description }));
  }

  /**
   * The toolkits among these plugin names as an agent is told of them: the slug, the display name
   * (the slug when the kept list has none), and whether a session that has it is ready (null when
   * none was tried). Only what eta already holds: no request, nothing of the key or of a session.
   * Nothing while the source is off.
   */
  toolkitsFor(
    names: readonly string[],
  ): { slug: string; name: string; ready: boolean | null }[] {
    if (!this.source().enabled) return [];
    const slugs = names.flatMap((name) => this.#slugOf(name) ?? []);
    const named = new Map(
      this.toolkitsOf(slugs).map((one) => [one.slug, one.name]),
    );
    const states = this.#states();
    return slugs.map((slug) => ({
      slug,
      name: named.get(slug) ?? slug,
      ready: states.has(slug) ? states.get(slug) === "ready" : null,
    }));
  }

  /** The logo address of a toolkit in the list last read (or kept); null when there is none. */
  logoOf(slug: string): string | null {
    if (this.#logos === undefined && this.#apiKey() !== undefined) {
      const kept = this.#fromCache(this.source());
      if (kept !== undefined) this.#remember(kept.toolkits);
    }
    return this.#logos?.get(slug) ?? null;
  }

  /* ------------------------------------------------------ virtual plugins */

  /**
   * A connected toolkit is a plugin of its own, `@composio/<slug>`, and what stands behind the
   * plugins an agent has enabled is ONE tool_router session of Composio's whose `toolkits.enable`
   * lists all of them, so the agent sees Composio's meta tools once. A session is kept by its set of
   * slugs (sorted, joined by commas): agents with the same set share one, another set is another
   * session. A toolkit that no agent has enabled has a session of its own, so it is listed and ready
   * before anyone uses it. The one exception to "only a connected (ACTIVE) toolkit": a toolkit that
   * needs no sign-in has no account to be connected, so it is a plugin once it was added (`add`).
   * There is no file of it on disk: this source says what exists, `Plugins`
   * asks it (see `VirtualPlugins`), and the agents' own choice and the user's switch work as they do
   * for any plugin. A session is kept as its id only (sealed, one row each, and the keys in a setting
   * so they can all be erased), and what Composio says it made is checked before it is used: exactly
   * the toolkits asked for, no removal of connections, no workbench.
   */
  owns(name: string): boolean {
    return (
      name.startsWith(VIRTUAL_PREFIX) &&
      SLUG.test(name.slice(VIRTUAL_PREFIX.length))
    );
  }

  /** Called when what the plugins are changed (a session made, dropped, or the source switched). */
  onChange(listener: () => void): void {
    this.#listeners.push(listener);
  }

  #notify(): void {
    for (const listener of this.#listeners) listener();
  }

  #slugOf(name: string): string | undefined {
    return this.owns(name) ? name.slice(VIRTUAL_PREFIX.length) : undefined;
  }

  /** The key of a session: the slugs, sorted and without repeats. */
  #setKey(slugs: Iterable<string>): string {
    return [...new Set(slugs)].sort().join(",");
  }

  /**
   * What the agents have enabled, as toolkit names, one list for each agent: the sessions are
   * brought in line with it, and with what is connected, whenever either moves.
   */
  demand(sets: () => string[][]): void {
    this.#demand = sets;
  }

  /** Bring the sessions in line with what the agents have enabled now; nothing when that is already so. */
  refresh(): void {
    const key = this.#apiKey();
    if (
      key === undefined ||
      this.#wanted === undefined ||
      !this.source().enabled
    )
      return;
    void this.#reconcile(key, true).catch(() => undefined);
  }

  /** Nothing while the source is off or has no key. Never anything of the key or of Composio's words. */
  virtuals(): Pick<ComposioPluginView, "name" | "slug" | "state">[] {
    if (!this.source().enabled) return [];
    return [...this.#states()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([slug, state]) => ({ name: VIRTUAL_PREFIX + slug, slug, state }));
  }

  /** A toolkit is ready when a session that has it is, else error; nothing for one no session was tried for. */
  #states(): Map<string, Session["state"]> {
    const states = new Map<string, Session["state"]>();
    for (const [set, one] of this.#sessions)
      for (const slug of set.split(","))
        if (states.get(slug) !== "ready") states.set(slug, one.state);
    return states;
  }

  /** Whether this plugin has a session that checked out, and the source is on. */
  has(name: string): boolean {
    const slug = this.#slugOf(name);
    return (
      slug !== undefined &&
      this.source().enabled &&
      this.#states().get(slug) === "ready"
    );
  }

  /** The session of exactly these plugins, if it checked out and the source is on. */
  #readyFor(
    names: readonly string[],
  ): (Session & { state: "ready" }) | undefined {
    const slugs = names.flatMap((name) => this.#slugOf(name) ?? []);
    if (slugs.length === 0 || !this.source().enabled) return undefined;
    const one = this.#sessions.get(this.#setKey(slugs));
    return one?.state === "ready" ? one : undefined;
  }

  /** What an agent's session is given for its plugins: one server, with the key as its header. */
  mcpSource(names: readonly string[]): McpConfigSource | undefined {
    const one = this.#readyFor(names);
    const key = this.#apiKey();
    if (one === undefined || key === undefined) return undefined;
    return {
      name: SERVER,
      servers: {
        [SERVER]: {
          type: "http",
          url: one.url,
          headers: { "x-api-key": key },
        },
      },
    };
  }

  /** The id of the session behind an agent's plugins: another one reopens the sessions of its agents. */
  identity(names: readonly string[]): string | undefined {
    return this.#readyFor(names)?.id;
  }

  /** What no session may pass on. */
  secrets(): Redaction[] {
    const key = this.#apiKey();
    return key === undefined
      ? []
      : [{ value: key, label: "[secret composio api key]" }];
  }

  /**
   * Bring the sessions in line with the connected toolkits and with what the agents enabled: one
   * for each set of toolkits an agent has, one for each toolkit no agent has, none for the others.
   * Calls overlap safely (a session is made once), at most three are made at a time, and a failure
   * is a session's own: it is tried again only after a pause, or never in this run when Composio's
   * answer was not what was asked for.
   */
  async sync(slugs: readonly string[]): Promise<void> {
    const key = this.#apiKey();
    if (key === undefined) {
      this.#dropAll();
      return;
    }
    if (!this.source().enabled) return;
    this.#wanted = new Set(slugs.filter((slug) => SLUG.test(slug)));
    await this.#reconcile(key, true);
  }

  /**
   * The keys of the sessions that are needed: the set of each agent's toolkits (the ones that are
   * connected or added), and each other connected toolkit alone. None while that is not known.
   */
  #needed(): string[] {
    const wanted = this.#wanted;
    if (wanted === undefined) return [];
    const keys = new Set<string>();
    const used = new Set<string>();
    for (const names of this.#demand?.() ?? []) {
      const slugs = names.flatMap((name) => {
        const slug = this.#slugOf(name);
        return slug !== undefined && wanted.has(slug) ? [slug] : [];
      });
      if (slugs.length === 0) continue;
      keys.add(this.#setKey(slugs));
      for (const slug of slugs) used.add(slug);
    }
    for (const slug of wanted) if (!used.has(slug)) keys.add(slug);
    return [...keys].sort();
  }

  /** Make the sessions that are needed and are not there; with `prune`, drop the ones that are not needed. */
  async #reconcile(key: string, prune: boolean): Promise<void> {
    const needed = this.#needed();
    const before = this.#snapshot();
    if (prune)
      for (const set of new Set([
        ...this.#sessions.keys(),
        ...this.#keptSets(),
      ]))
        if (!needed.includes(set)) this.#drop(set);
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < needed.length) {
        const set = needed[next++]!;
        await this.#ensure(set, key).catch(() => undefined);
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(MAKE_AT_ONCE, needed.length) }, worker),
    );
    if (this.#snapshot() !== before) this.#notify();
  }

  #snapshot(): string {
    return JSON.stringify(
      [...this.#sessions].map(([set, one]) => [
        set,
        one.state,
        one.state === "ready" ? one.id : "",
      ]),
    );
  }

  #ensure(set: string, key: string): Promise<void> {
    const known = this.#sessions.get(set);
    if (known?.state === "ready") return Promise.resolve();
    if (known !== undefined && this.#now() < known.retryAt)
      return Promise.resolve();
    const running = this.#making.get(set);
    if (running !== undefined) return running;
    const made = this.#make(set, key, this.#epoch).finally(() =>
      this.#making.delete(set),
    );
    this.#making.set(set, made);
    return made;
  }

  async #make(set: string, key: string, epoch: number): Promise<void> {
    const slugs = set.split(",");
    let opened: { id: string; url: string } | undefined;
    try {
      // A session uses the accounts under a config that is on for the tool router; see #authConfig.
      // A toolkit that needs no sign-in has no account and no config to switch.
      for (const slug of slugs)
        if (this.#known(slug)?.auth !== "none")
          await this.#enableRouter(slug, key);
      const kept = this.#keptId(set);
      if (kept !== undefined) {
        try {
          opened = await this.#read(slugs, key, kept);
        } catch (error) {
          // Composio does not know it any more, or says something else of it: one new session.
          if (
            error instanceof Unchecked ||
            (error instanceof Refused &&
              (error.status === 401 || error.status === 404))
          )
            this.#forget(set);
          else throw error;
        }
      }
      opened ??= await this.#create(slugs, key);
      // The key was replaced or cleared while this was made: it belongs to the old one.
      if (epoch !== this.#epoch) return;
      this.#credentials.write(
        CREDENTIAL.integration,
        SESSION_PREFIX + set,
        CREDENTIAL.kind,
        opened.id,
      );
      this.#settings.set(SESSIONS_KEY, [
        ...new Set([...this.#keptSets(), set]),
      ]);
      this.#sessions.set(set, { state: "ready", ...opened });
    } catch (error) {
      if (epoch !== this.#epoch) return;
      this.#sessions.set(set, {
        state: "error",
        retryAt:
          error instanceof Unchecked
            ? Number.POSITIVE_INFINITY
            : this.#now() + RETRY_MS,
      });
    }
  }

  async #create(
    slugs: readonly string[],
    key: string,
  ): Promise<{ id: string; url: string }> {
    const body = await this.#call("POST", SESSION_PATH, key, {
      user_id: this.#userId(),
      toolkits: { enable: slugs },
      manage_connections: { enable_connection_removal: false },
      workbench: { enable: false },
    });
    return this.#checked(slugs, body, undefined);
  }

  async #read(
    slugs: readonly string[],
    key: string,
    id: string,
  ): Promise<{ id: string; url: string }> {
    const body = await this.#call(
      "GET",
      `${SESSION_PATH}/${encodeURIComponent(id)}`,
      key,
    );
    return this.#checked(slugs, body, id);
  }

  /** The id and address of an answer, if the address is Composio's and the config says what was asked. */
  #checked(
    slugs: readonly string[],
    body: unknown,
    id: string | undefined,
  ): { id: string; url: string } {
    if (!isPlain(body)) throw new Unchecked();
    const got = body.session_id;
    if (
      typeof got !== "string" ||
      !SESSION_ID.test(got) ||
      (id !== undefined && got !== id)
    )
      throw new Unchecked();
    const url = isPlain(body.mcp) ? body.mcp.url : undefined;
    let there = false;
    try {
      const address = new URL(String(url));
      there =
        address.origin === new URL(this.#base).origin &&
        address.username === "" &&
        address.password === "";
    } catch {
      there = false;
    }
    if (!there || typeof url !== "string") throw new Unchecked();
    const config = isPlain(body.config) ? body.config : {};
    const toolkits = isPlain(config.toolkits) ? config.toolkits.enabled : [];
    const removal = isPlain(config.manage_connections)
      ? config.manage_connections.enable_connection_removal
      : undefined;
    const bench = isPlain(config.workbench)
      ? config.workbench.enable
      : undefined;
    // Exactly the toolkits asked for, in any order.
    if (
      !Array.isArray(toolkits) ||
      toolkits.length !== slugs.length ||
      !slugs.every((slug) => toolkits.includes(slug)) ||
      removal !== false ||
      bench !== false
    )
      throw new Unchecked();
    return { id: got, url };
  }

  #keptId(set: string): string | undefined {
    const value = this.#credentials.read(
      CREDENTIAL.integration,
      SESSION_PREFIX + set,
      CREDENTIAL.kind,
    );
    return typeof value === "string" && SESSION_ID.test(value)
      ? value
      : undefined;
  }

  #keptSets(): string[] {
    const saved = this.#settings.get(SESSIONS_KEY);
    return Array.isArray(saved)
      ? saved.filter(
          (one): one is string => typeof one === "string" && SET.test(one),
        )
      : [];
  }

  /** Erase the kept id of one session, and its place in the list. */
  #forget(set: string): void {
    this.#credentials.erase(
      CREDENTIAL.integration,
      SESSION_PREFIX + set,
      CREDENTIAL.kind,
    );
    const rest = this.#keptSets().filter((one) => one !== set);
    if (rest.length === 0) this.#settings.delete(SESSIONS_KEY);
    else this.#settings.set(SESSIONS_KEY, rest);
  }

  #drop(set: string): void {
    const had = this.#sessions.delete(set);
    this.#forget(set);
    if (had) this.#notify();
  }

  /** A toolkit is no more: it is not wanted, every session that has it goes, and the sessions of what is left are brought in line. */
  #dropToolkit(slug: string): void {
    this.#wanted?.delete(slug);
    for (const set of new Set([...this.#sessions.keys(), ...this.#keptSets()]))
      if (set.split(",").includes(slug)) this.#drop(set);
    this.refresh();
  }

  /** Every session and every kept id goes: the key they were made with is no more. */
  #dropAll(): void {
    this.#epoch++;
    const had = this.#sessions.size > 0;
    for (const set of new Set([...this.#sessions.keys(), ...this.#keptSets()]))
      this.#credentials.erase(
        CREDENTIAL.integration,
        SESSION_PREFIX + set,
        CREDENTIAL.kind,
      );
    this.#sessions.clear();
    this.#making.clear();
    this.#wanted = undefined;
    this.#settings.delete(SESSIONS_KEY);
    if (had) this.#notify();
  }

  /* ------------------------------------------------------------------- link */

  /**
   * An address on Composio's side where the user signs in to one toolkit. Composio keeps a
   * connected account for a `user_id`; the one used is a random id made here the first time and kept
   * in the settings, so the same host always means the same user and nothing about the person (a
   * name, an address, an account) is sent. The auth config is Composio's own managed one for the
   * toolkit: found when the project has it, made when it has not.
   * A toolkit with no managed sign-in has none: its own config is found or made with no credentials
   * (a key the user types on Composio's page, which eta never asks for or keeps, or dynamic client
   * registration). One that needs an OAuth app of the user's own is not made here: a config the
   * user made on Composio is taken, and without one the link fails, asking for nothing from Composio.
   */
  async link(slug: string): Promise<string> {
    if (!SLUG.test(slug)) throw new PluginError("that is not a toolkit name");
    const key = this.#apiKey();
    if (key === undefined)
      throw new PluginError("set the Composio API key first");
    // A toolkit that needs no sign-in has no page to sign in on: it is added, not linked.
    if (this.#known(slug)?.auth === "none")
      throw new PluginError("that toolkit needs no sign-in: add it instead");
    try {
      const config = await this.#authConfig(slug, key);
      const made = await this.#call(
        "POST",
        "/api/v3/connected_accounts/link",
        key,
        {
          auth_config_id: config,
          user_id: this.#userId(),
        },
      );
      const address = isPlain(made) ? https(made.redirect_url, 2048) : null;
      if (address === null)
        throw new Error("Composio gave no https sign-in address");
      return address;
    } catch (error) {
      this.#configs.delete(slug);
      if (error instanceof Refused && error.status === 401)
        throw new PluginError("Composio refused the API key");
      throw new PluginError(this.#clean(error, key));
    }
  }

  /**
   * The toolkits the user has connected with Composio: the ACTIVE accounts of the same user `link`
   * uses, read page by page. Only a status comes back for a failure, never its text: the answer
   * is only a mark in the market, and a key refused or Composio silent just leaves it out.
   */
  async connected(): Promise<{ status: ComposioStatus; slugs: string[] }> {
    const key = this.#apiKey();
    if (key === undefined) return { status: "needs_key", slugs: [] };
    try {
      const slugs = new Set((await this.#active(key)).map((one) => one.slug));
      return { status: "ready", slugs: [...slugs] };
    } catch (error) {
      return { status: this.#failure(error), slugs: [] };
    }
  }

  /**
   * `connected`, and then the sessions of what is connected, which the answer does not wait for: a
   * toolkit is a plugin of the agents once its session checked out. A failed reading leaves the
   * sessions as they are, since it says nothing of what is connected.
   */
  async follow(): Promise<{ status: ComposioStatus; slugs: string[] }> {
    const read = await this.connected();
    // What was added needs no account, so it is wanted as well as what is connected.
    if (read.status === "ready")
      void this.sync([...read.slugs, ...this.added()]).catch(() => undefined);
    return read;
  }

  /** The toolkits that were added (they need no sign-in); none while there is no key. */
  added(): string[] {
    return this.#apiKey() === undefined ? [] : this.#addedSlugs();
  }

  #addedSlugs(): string[] {
    const saved = this.#settings.get(ADDED_KEY);
    return Array.isArray(saved)
      ? saved.filter(
          (one): one is string => typeof one === "string" && SLUG.test(one),
        )
      : [];
  }

  /**
   * Adds a toolkit that needs no sign-in (its `auth` in the kept list is `none`): it is written to
   * the added list and its session is made, with no auth config and no link asked of Composio. Any
   * other toolkit, one the kept list does not know, and a name that is no slug are refused before
   * a request. Whether Composio accepts a tool_router session for such a toolkit is not verified.
   */
  async add(slug: string): Promise<{ status: ComposioStatus }> {
    if (!SLUG.test(slug)) throw new PluginError("that is not a toolkit name");
    const key = this.#apiKey();
    if (key === undefined) return { status: "needs_key" };
    if (this.#known(slug)?.auth !== "none")
      throw new PluginError("only a toolkit that needs no sign-in is added");
    this.#settings.set(ADDED_KEY, [...new Set([...this.#addedSlugs(), slug])]);
    if (this.source().enabled) {
      // Before the first `sync` what is wanted is not known: what is kept is then left as it is.
      const known = this.#wanted !== undefined;
      this.#wanted = new Set([...(this.#wanted ?? []), slug]);
      await this.#reconcile(key, known);
    }
    return { status: "ready" };
  }

  /**
   * Takes an added toolkit off the list and drops the sessions that have it and their kept ids. Nothing is asked of
   * Composio, and the agents' choices of it stay. A slug that was not added is left alone.
   */
  remove(slug: string): { removed: boolean } {
    const added = this.#addedSlugs();
    if (!added.includes(slug)) return { removed: false };
    const rest = added.filter((one) => one !== slug);
    if (rest.length === 0) this.#settings.delete(ADDED_KEY);
    else this.#settings.set(ADDED_KEY, rest);
    this.#dropToolkit(slug);
    return { removed: true };
  }

  /** One toolkit of the kept list, if there is a list and it has it. */
  #known(slug: string): ComposioToolkit | undefined {
    return this.#fromCache(this.source())?.toolkits.find(
      (one) => one.slug === slug,
    );
  }

  /**
   * Disconnects one toolkit: deletes, on Composio, the ACTIVE accounts of that toolkit under this
   * host's own `user_id` and no others (an account that names another user is left alone even if
   * Composio ignored the filter). It cannot be undone there. Only a status and a count come back
   * for a failure, never Composio's text. Whatever was deleted before a failure stays deleted and is
   * counted.
   */
  async disconnect(
    slug: string,
  ): Promise<{ status: ComposioStatus; removed: number }> {
    if (!SLUG.test(slug)) throw new PluginError("that is not a toolkit name");
    const key = this.#apiKey();
    if (key === undefined) return { status: "needs_key", removed: 0 };
    const user = this.#userId();
    let removed = 0;
    try {
      const mine = (await this.#active(key)).filter(
        (one) =>
          one.slug === slug &&
          one.id !== undefined &&
          (one.user === undefined || one.user === user),
      );
      for (const one of mine) {
        const done = await this.#call(
          "DELETE",
          `/api/v3/connected_accounts/${encodeURIComponent(one.id!)}`,
          key,
        );
        if (!isPlain(done) || done.success !== true)
          throw new Error("Composio did not confirm the delete");
        removed++;
      }
      this.#dropToolkit(slug);
      return { status: "ready", removed };
    } catch (error) {
      return { status: this.#failure(error), removed };
    }
  }

  /** The ACTIVE accounts of this host's user, page by page; a failure is thrown. */
  async #active(
    key: string,
  ): Promise<{ slug: string; id: string | undefined; user: unknown }[]> {
    const found: { slug: string; id: string | undefined; user: unknown }[] = [];
    let cursor: string | null = null;
    for (let page = 1; ; page++) {
      if (page > MAX_PAGES)
        throw new Error(`the accounts are more than ${MAX_PAGES} pages`);
      const query = new URLSearchParams({
        user_ids: this.#userId(),
        statuses: "ACTIVE",
        limit: String(PAGE),
      });
      if (cursor !== null) query.set("cursor", cursor);
      const body = await this.#call(
        "GET",
        `/api/v3/connected_accounts?${query}`,
        key,
      );
      if (!isPlain(body) || !Array.isArray(body.items))
        throw new Error("the answer is not a list of accounts");
      for (const item of body.items) {
        if (!isPlain(item) || item.status !== "ACTIVE") continue;
        const slug = isPlain(item.toolkit) ? item.toolkit.slug : undefined;
        if (typeof slug === "string" && SLUG.test(slug))
          found.push({
            slug,
            id:
              typeof item.id === "string" && SLUG.test(item.id)
                ? item.id
                : undefined,
            user: item.user_id,
          });
      }
      const next: unknown = body.next_cursor;
      if (typeof next !== "string" || next === "" || body.items.length === 0)
        return found;
      if (next === cursor) throw new Error("the account pages do not end");
      cursor = next;
    }
  }

  #failure(error: unknown): ComposioStatus {
    return error instanceof Refused && error.status === 401
      ? "key_rejected"
      : "error";
  }

  #userId(): string {
    const saved = this.#settings.get(USER_ID_KEY);
    if (typeof saved === "string" && SLUG.test(saved)) return saved;
    const made = `eta-${randomUUID()}`;
    this.#settings.set(USER_ID_KEY, made);
    return made;
  }

  /**
   * The auth config a link is made under. The tool_router sessions use only the accounts of a
   * config that is switched on for the tool router (`is_enabled_for_tool_router`), and one made
   * through the API is not (observed on a real project's configs; that a session ignores the
   * others is not verified). So one that is on is taken when there is one, and the first managed
   * one is switched on when it is off. The create call lists no such field, so a config just made
   * is switched on with a PATCH, and when that fails the link fails: an account under it would
   * not be seen. Failing to switch on one that was already there only goes to the log.
   */
  async #authConfig(slug: string, key: string): Promise<string> {
    const known = this.#configs.get(slug);
    if (known !== undefined) return known;
    // Composio has no managed config for a toolkit that lists no managed scheme: asking for one
    // answers 404. A toolkit eta has no list entry for keeps the managed config.
    const toolkit = this.#known(slug);
    const own = toolkit !== undefined && !toolkit.managed;
    const scheme = own ? composioOwnScheme(toolkit) : undefined;
    const found = own
      ? await this.#ownConfigs(slug, key, scheme !== undefined)
      : await this.#managedConfigs(slug, key);
    const chosen =
      found.find((item) => item.is_enabled_for_tool_router === true) ??
      found[0];
    let id: unknown = chosen?.id;
    if (chosen === undefined) {
      if (own && scheme === undefined)
        throw new PluginError(
          `${COMPOSIO_NO_MANAGED_LOGIN}: Composio has no managed sign-in for ${slug}; make an auth config of your own for it on the Composio dashboard, then connect again`,
        );
      const made = await this.#call("POST", "/api/v3/auth_configs", key, {
        toolkit: { slug },
        auth_config:
          scheme === undefined
            ? { type: "use_composio_managed_auth" }
            : // The user types the key on Composio's page, or none is asked for; eta holds none.
              {
                type: "use_custom_auth",
                authScheme: scheme,
                name: `eta ${slug}`,
                credentials: {},
              },
      });
      id =
        isPlain(made) && isPlain(made.auth_config)
          ? made.auth_config.id
          : undefined;
    }
    if (typeof id !== "string" || !SLUG.test(id))
      throw new Error("Composio gave no auth config for this toolkit");
    if (chosen === undefined) {
      try {
        await this.#routerOn(id, key);
      } catch {
        throw new Error(
          "Composio made the auth config but would not switch it on for its tool router",
        );
      }
    } else if (chosen.is_enabled_for_tool_router === false) {
      await this.#routerOn(id, key).catch((error: unknown) =>
        this.#warn(
          `could not switch the auth config ${id} on for the tool router: ${this.#clean(error, key)}`,
        ),
      );
    }
    this.#configs.set(slug, id);
    return id;
  }

  /**
   * The project's own (not managed), enabled auth configs for one toolkit: of the schemes that need
   * no credentials from eta when `capable`, else of any scheme (the user made them on Composio).
   */
  async #ownConfigs(
    slug: string,
    key: string,
    capable: boolean,
  ): Promise<Record<string, unknown>[]> {
    const query = new URLSearchParams({ toolkit_slug: slug, limit: "25" });
    const found = await this.#call("GET", `/api/v3/auth_configs?${query}`, key);
    return isPlain(found) && Array.isArray(found.items)
      ? found.items.filter(
          (item): item is Record<string, unknown> =>
            isPlain(item) &&
            item.is_composio_managed !== true &&
            item.status !== "DISABLED" &&
            (!capable ||
              item.auth_scheme === "API_KEY" ||
              item.auth_scheme === "BEARER_TOKEN" ||
              item.auth_scheme === "DCR_OAUTH"),
        )
      : [];
  }

  /** The managed, enabled auth configs of the project for one toolkit, as Composio lists them. */
  async #managedConfigs(
    slug: string,
    key: string,
  ): Promise<Record<string, unknown>[]> {
    const query = new URLSearchParams({
      toolkit_slug: slug,
      is_composio_managed: "true",
      limit: "10",
    });
    const found = await this.#call("GET", `/api/v3/auth_configs?${query}`, key);
    return isPlain(found) && Array.isArray(found.items)
      ? found.items.filter(
          (item): item is Record<string, unknown> =>
            isPlain(item) &&
            item.is_composio_managed === true &&
            item.status !== "DISABLED",
        )
      : [];
  }

  /** Switch one auth config on for the tool router. Nothing is deleted or otherwise changed. */
  async #routerOn(id: string, key: string): Promise<void> {
    const done = await this.#call(
      "PATCH",
      `/api/v3/auth_configs/${encodeURIComponent(id)}`,
      key,
      { type: "default", is_enabled_for_tool_router: true },
    );
    if (isPlain(done) && done.success === false)
      throw new Error("Composio did not apply the change");
  }

  /**
   * Before a toolkit's session is made, once per run: the managed configs that are off for the tool
   * router are switched on, so that accounts connected under them before this was done are seen by
   * the session and need no new connection. It never holds the session back; a failure is logged.
   */
  async #enableRouter(slug: string, key: string): Promise<void> {
    if (this.#routed.has(slug)) return;
    this.#routed.add(slug);
    let found: Record<string, unknown>[];
    try {
      found = await this.#managedConfigs(slug, key);
    } catch (error) {
      this.#routed.delete(slug);
      this.#warn(
        `could not read the auth configs of ${slug}: ${this.#clean(error, key)}`,
      );
      return;
    }
    for (const item of found) {
      const id = item.id;
      if (
        item.is_enabled_for_tool_router !== false ||
        typeof id !== "string" ||
        !SLUG.test(id)
      )
        continue;
      await this.#routerOn(id, key).catch((error: unknown) =>
        this.#warn(
          `could not switch the auth config ${id} on for the tool router: ${this.#clean(error, key)}`,
        ),
      );
    }
  }

  #warn(text: string): void {
    console.warn(`composio: ${text}`);
  }

  /* ------------------------------------------------------------------- wire */

  /** One call to Composio, JSON both ways, with a time limit and a size limit. */
  async #call(
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string,
    key: string,
    body?: unknown,
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(this.#base + path, {
        method,
        signal: AbortSignal.timeout(this.#timeoutMs),
        // The key is in this request; where a redirect would take it is not Composio's to decide.
        redirect: "error",
        headers: {
          accept: "application/json",
          "x-api-key": key,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (error) {
      const timedOut =
        error instanceof Error &&
        (error.name === "TimeoutError" || error.name === "AbortError");
      throw new Refused(
        timedOut
          ? `Composio did not answer in ${this.#timeoutMs} ms`
          : "cannot reach Composio",
        null,
      );
    }
    if (!response.ok)
      throw new Refused(
        // Which call, so a failure can be told from the next one; the query is left out.
        `Composio answered HTTP ${response.status} (${method} ${path.split("?")[0]})`,
        response.status,
      );
    if (Number(response.headers.get("content-length") ?? 0) > this.#maxBytes)
      throw this.#tooBig();
    const chunks: Uint8Array[] = [];
    let size = 0;
    const reader = response.body?.getReader();
    try {
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
      if (error instanceof Refused) throw error;
      throw new Refused("cannot read Composio's answer", null);
    }
    try {
      return JSON.parse(
        new TextDecoder().decode(Buffer.concat(chunks)),
      ) as unknown;
    } catch {
      throw new Refused("Composio's answer is not JSON", null);
    }
  }

  #tooBig(): Refused {
    return new Refused(
      `Composio's answer is larger than ${this.#maxBytes} bytes`,
      null,
    );
  }

  /** The reason as text, without the key even if a remote text carried it. */
  #clean(error: unknown, key: string): string {
    const text = error instanceof Error ? error.message : String(error);
    return text.split(key).join("…");
  }
}
