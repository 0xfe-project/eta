/**
 * Provider logos, from models.dev.
 *
 * `api.json` names no logo, but models.dev serves one for each of its providers at
 * `/logos/<provider id>.svg`, keyed by the same ids. A source is matched to an entry by its id
 * when the caller knows it (a gateway connector: Codex is `openai`), else by its base URL: first
 * the exact official endpoints the metadata lookup already knows, then the `api` each catalog
 * entry declares (which is how OpenRouter or LM Studio at their usual addresses get theirs).
 *
 * Public data only, like the catalog: no credentials, no redirects. What comes back is kept in
 * memory; a logo that cannot be had is no logo, and the page draws a letter instead.
 */
import type {
  ProviderLogoRequest,
  ProviderLogosResult,
} from "@eta/client-contracts";
import { fetchModelsDev, officialModelsDevId } from "./metadata";

const LOGO_URL = "https://models.dev/logos";
const ID = /^[a-z0-9][\w.-]{0,63}$/;
const MAX_SOURCES = 64;
const MAX_BYTES = 64 * 1024;
/** How long the catalog's `api` addresses are trusted before they are read again. */
const CATALOG_TTL_MS = 60 * 60 * 1000;
/** How long a logo that could not be fetched is not asked for again. */
const MISS_TTL_MS = 10 * 60 * 1000;

function normalize(url: string): string | undefined {
  try {
    return new URL(url.trim()).href.replace(/\/+$/, "");
  } catch {
    return undefined;
  }
}

export class ProviderLogos {
  readonly #send: typeof fetch;
  readonly #now: () => number;
  /** Each catalog entry's endpoint, normalised, to the entry's id. */
  #endpoints: { at: number; map: Promise<Map<string, string>> } | undefined;
  readonly #svgs = new Map<
    string,
    { svg: string | undefined; at: number } | Promise<string | undefined>
  >();

  constructor(send: typeof fetch = fetch, now: () => number = Date.now) {
    this.#send = send;
    this.#now = now;
  }

  async logos(
    sources: readonly ProviderLogoRequest[],
  ): Promise<ProviderLogosResult> {
    const logos: Record<string, string> = {};
    await Promise.all(
      sources.slice(0, MAX_SOURCES).map(async (source) => {
        if (typeof source?.key !== "string") return;
        const id = await this.#idOf(source);
        if (id === undefined) return;
        const svg = await this.#svg(id);
        if (svg !== undefined) logos[source.key] = svg;
      }),
    );
    return { logos };
  }

  async #idOf(source: ProviderLogoRequest): Promise<string | undefined> {
    if (typeof source.id === "string")
      return ID.test(source.id) ? source.id : undefined;
    if (typeof source.baseUrl !== "string") return undefined;
    const official = officialModelsDevId(source.baseUrl);
    if (official !== undefined) return official;
    const endpoint = normalize(source.baseUrl);
    if (endpoint === undefined) return undefined;
    try {
      return (await this.#catalogEndpoints()).get(endpoint);
    } catch {
      return undefined;
    }
  }

  #catalogEndpoints(): Promise<Map<string, string>> {
    const cached = this.#endpoints;
    if (cached !== undefined && this.#now() - cached.at < CATALOG_TTL_MS)
      return cached.map;
    const map = fetchModelsDev(this.#send).then((body) => {
      const endpoints = new Map<string, string>();
      for (const [id, entry] of Object.entries(body)) {
        const api = (entry as { api?: unknown } | null)?.api;
        if (typeof api !== "string" || !ID.test(id)) continue;
        const endpoint = normalize(api);
        // The first entry to claim an address keeps it.
        if (endpoint !== undefined && !endpoints.has(endpoint))
          endpoints.set(endpoint, id);
      }
      return endpoints;
    });
    this.#endpoints = { at: this.#now(), map };
    // A failed read is not kept: the next request tries again.
    map.catch(() => {
      if (this.#endpoints?.map === map) this.#endpoints = undefined;
    });
    return map;
  }

  async #svg(id: string): Promise<string | undefined> {
    const cached = this.#svgs.get(id);
    if (cached instanceof Promise) return await cached;
    if (
      cached !== undefined &&
      (cached.svg !== undefined || this.#now() - cached.at < MISS_TTL_MS)
    )
      return cached.svg;
    const pending = this.#fetchSvg(id);
    this.#svgs.set(id, pending);
    const svg = await pending;
    this.#svgs.set(id, { svg, at: this.#now() });
    return svg;
  }

  async #fetchSvg(id: string): Promise<string | undefined> {
    try {
      const response = await this.#send(`${LOGO_URL}/${id}.svg`, {
        headers: { Accept: "image/svg+xml" },
        credentials: "omit",
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) return undefined;
      if (!(response.headers.get("content-type") ?? "").includes("svg"))
        return undefined;
      const svg = (await response.text()).trim();
      // Drawn as an image mask, never as markup; still, only what looks like an icon is kept.
      if (svg.length > MAX_BYTES || !/^(?:<\?xml[^>]*>\s*)?<svg[\s>]/.test(svg))
        return undefined;
      return svg;
    } catch {
      return undefined;
    }
  }
}
