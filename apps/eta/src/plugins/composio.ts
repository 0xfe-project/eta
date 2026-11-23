/**
 * The market's Composio source: the list of Composio toolkits, and the link that starts connecting one.
 *
 * Composio is a hosted service: the host talks to it with the user's API key, which is kept sealed
 * (`composio_key`) and goes only to https://backend.composio.dev, in the `x-api-key` header, with
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
  ComposioStatus,
  ComposioToolkit,
  MarketSource,
  MarketSourceCatalog,
} from "@eta/client-contracts";
import type { Database } from "bun:sqlite";
import type { SettingStore } from "../settings/store";
import type { CatalogCache } from "./market-cache";
import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { PluginError } from "@eta/daemon";
import { seal, unseal } from "../secret";

/** The address the source has in `MarketSource.url`: not a web address, only a name. */
export const COMPOSIO_URL = "composio:toolkits";
const COMPOSIO_NAME = "Composio";
/** Whether the source is on; absent means on, like any source that was added. */
const COMPOSIO_ENABLED_KEY = "plugins.composioEnabled";
const USER_ID_KEY = "plugins.composioUserId";

const BASE = "https://backend.composio.dev";
const PAGE = 100;
const MAX_PAGES = 30;
const MAX_TOOLKITS = 3000;
const MAX_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 10_000;
const KEY_SHAPE = /^[\x21-\x7E]{1,512}$/;
const SLUG = /^[\w-]{1,100}$/;

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
}

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

export class Composio {
  readonly #db: Database;
  readonly #key: Buffer;
  readonly #settings: SettingStore;
  readonly #cache: CatalogCache | undefined;
  readonly #base: string;
  readonly #timeoutMs: number;
  readonly #maxBytes: number;
  /** The managed auth config found or made for a toolkit; asked once per run. */
  readonly #configs = new Map<string, string>();
  /** Logo addresses of the list last read, by slug: the client names a slug, never an address. */
  #logos: Map<string, string> | undefined;

  constructor(options: ComposioOptions) {
    this.#db = options.db;
    this.#key = options.key;
    this.#settings = options.settings;
    this.#cache = options.cache;
    this.#base = options.baseUrl ?? BASE;
    this.#timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
    this.#maxBytes = options.maxBytes ?? MAX_BYTES;
  }

  /** The source as the market lists it: always there, on unless the user switched it off. */
  source(): MarketSource {
    return {
      url: COMPOSIO_URL,
      name: COMPOSIO_NAME,
      enabled: this.#settings.get(COMPOSIO_ENABLED_KEY) !== false,
      kind: "composio",
    };
  }

  setEnabled(enabled: boolean): void {
    if (enabled) this.#settings.delete(COMPOSIO_ENABLED_KEY);
    else this.#settings.set(COMPOSIO_ENABLED_KEY, false);
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
    this.#db
      .query(
        `INSERT INTO composio_key (id, sealed, updated_at) VALUES (1, ?, ?)
         ON CONFLICT (id) DO UPDATE SET sealed = excluded.sealed, updated_at = excluded.updated_at`,
      )
      .run(seal(this.#key, clean), Date.now());
    // Another key may be another project: what was found for the old one is not known for this.
    this.#configs.clear();
  }

  clearKey(): void {
    this.#db.query("DELETE FROM composio_key WHERE id = 1").run();
    this.#configs.clear();
  }

  /** The key, only for the header of a call to Composio. A blob that does not open reads as no key. */
  #apiKey(): string | undefined {
    const row = this.#db
      .query<{ sealed: Uint8Array }, []>(
        "SELECT sealed FROM composio_key WHERE id = 1",
      )
      .get();
    return row === null ? undefined : unseal(this.#key, row.sealed);
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
        toolkits: raw.flatMap((item) => toolkit(item, source) ?? []),
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

  /** The logo address of a toolkit in the list last read (or kept); null when there is none. */
  logoOf(slug: string): string | null {
    if (this.#logos === undefined && this.#apiKey() !== undefined) {
      const kept = this.#fromCache(this.source());
      if (kept !== undefined) this.#remember(kept.toolkits);
    }
    return this.#logos?.get(slug) ?? null;
  }

  /* ------------------------------------------------------------------- link */

  /**
   * An address on Composio's side where the user signs in to one toolkit. Composio keeps a
   * connected account for a `user_id`; the one used is a random id made here the first time and kept
   * in the settings, so the same host always means the same user and nothing about the person (a
   * name, an address, an account) is sent. The auth config is Composio's own managed one for the
   * toolkit: found when the project has it, made when it has not.
   */
  async link(slug: string): Promise<string> {
    if (!SLUG.test(slug)) throw new PluginError("that is not a toolkit name");
    const key = this.#apiKey();
    if (key === undefined)
      throw new PluginError("set the Composio API key first");
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
    const slugs = new Set<string>();
    let cursor: string | null = null;
    try {
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
          if (typeof slug === "string" && SLUG.test(slug)) slugs.add(slug);
        }
        const next: unknown = body.next_cursor;
        if (typeof next !== "string" || next === "" || body.items.length === 0)
          return { status: "ready", slugs: [...slugs] };
        if (next === cursor) throw new Error("the account pages do not end");
        cursor = next;
      }
    } catch (error) {
      return {
        status:
          error instanceof Refused && error.status === 401
            ? "key_rejected"
            : "error",
        slugs: [],
      };
    }
  }

  #userId(): string {
    const saved = this.#settings.get(USER_ID_KEY);
    if (typeof saved === "string" && SLUG.test(saved)) return saved;
    const made = `eta-${randomUUID()}`;
    this.#settings.set(USER_ID_KEY, made);
    return made;
  }

  async #authConfig(slug: string, key: string): Promise<string> {
    const known = this.#configs.get(slug);
    if (known !== undefined) return known;
    const query = new URLSearchParams({
      toolkit_slug: slug,
      is_composio_managed: "true",
      limit: "10",
    });
    const found = await this.#call("GET", `/api/v3/auth_configs?${query}`, key);
    let id: unknown;
    if (isPlain(found) && Array.isArray(found.items))
      id = found.items.find(
        (item) =>
          isPlain(item) &&
          item.is_composio_managed === true &&
          item.status !== "DISABLED",
      )?.id;
    if (id === undefined) {
      const made = await this.#call("POST", "/api/v3/auth_configs", key, {
        toolkit: { slug },
        auth_config: { type: "use_composio_managed_auth" },
      });
      id =
        isPlain(made) && isPlain(made.auth_config)
          ? made.auth_config.id
          : undefined;
    }
    if (typeof id !== "string" || !SLUG.test(id))
      throw new Error("Composio gave no auth config for this toolkit");
    this.#configs.set(slug, id);
    return id;
  }

  /* ------------------------------------------------------------------- wire */

  /** One call to Composio, JSON both ways, with a time limit and a size limit. */
  async #call(
    method: "GET" | "POST",
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
        `Composio answered HTTP ${response.status}`,
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
