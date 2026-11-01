/**
 * Reading the web, in this process: a page as Markdown (`@searxng-js/sex-scrape`) and a search
 * through SearXNG (`@searxng-js/sex-search`). No service of ours stands in between: the libraries
 * are called here, on the host, for every session (a daemon's sessions reach them over
 * `tool.call`, like the other product tools).
 *
 * - **Fetching** goes through sex-egress, whose SSRF guard stays on: loopback, private, link-local
 *   and metadata addresses are refused, and the request is pinned to the address it checked. The
 *   proxy is the one eta's network settings put in the environment, read at each call, since
 *   those settings are applied after the product is made.
 * - **Searching** asks an external SearXNG when the host was given one (`--searxng-url`), and
 *   otherwise the prebuilt SearXNG the library runs as a child of this process, started on the
 *   first search and gone with the host. Where no prebuilt binary exists there is no search.
 * - **Errors** are the libraries' `AppError`, the host's own refusals included, so a tool has one
 *   kind of failure to describe.
 * - **Logs**: the libraries write nothing themselves; their warnings and errors arrive on
 *   `node:diagnostics_channel` and go to the host's `warn`.
 *
 * Both run on Bun, as the whole host does. On Bun the libraries' optional Node peers (`undici` for
 * requests, `marked` for Markdown to HTML, `yaml` for SearXNG's proxy settings) are not used.
 */
import type { Document } from "@searxng-js/sex-scrape";
import type { SearchData, SearchRequest } from "@searxng-js/sex-search";
import { subscribe, unsubscribe } from "node:diagnostics_channel";
import process from "node:process";
import { TARGETS } from "@searxng-js/searxng";
import { ExtractPool } from "@searxng-js/sex-page";
import { AppError, scrapeUrl } from "@searxng-js/sex-scrape";
import { search } from "@searxng-js/sex-search";
import { SearxngService } from "@searxng-js/sex-searxng";
import pLimit from "p-limit";

export interface WebOptions {
  /** An external SearXNG (its base URL). Without one the host runs the prebuilt one, where it can. */
  searxngUrl?: string | undefined;
  /**
   * Let fetches reach loopback and private addresses. Only a test sets it, for its fixture site on
   * 127.0.0.1; a host never does, and nothing a user configures turns it on.
   */
  allowPrivateNetwork?: boolean | undefined;
  /** How long one page may take, in ms. */
  timeoutMs?: number | undefined;
  /** The most of a page's Markdown one call returns, in UTF-8 bytes. */
  pageBytes?: number | undefined;
  /** The platform, for a test that asks about one without a prebuilt SearXNG. */
  platform?: { os: string; cpu: string } | undefined;
  warn: (message: string) => void;
}

/** A page as one call returns it: a part of its Markdown, and where the rest starts. */
export interface PageSlice {
  title: string | undefined;
  /** Where the page was in the end, after redirects. */
  url: string;
  /** What the library could not honour, or noticed about the page. */
  warning: string | undefined;
  /** The part of the Markdown this call returns. */
  markdown: string;
  /** Where it starts and ends, in characters of the whole Markdown. */
  start: number;
  end: number;
  total: number;
}

export interface SearchOutcome {
  data: SearchData;
  warning: string | undefined;
}

/** The channels the libraries publish their log lines on. */
const CHANNELS = ["scrape", "search", "searxng", "page"].map(
  (name) => `searxng-js:sex:${name}`,
);

const DEFAULT_TIMEOUT_MS = 30_000;
/** The same budget a file read has (`@eta/execution`'s `DEFAULT_MAX_BYTES`). */
const DEFAULT_PAGE_BYTES = 50 * 1024;
/** A page larger than this is refused by the fetch, before any of it is read into Markdown. */
const MAX_BODY_BYTES = 10 * 1024 * 1024;
/** Pages kept so that reading on (`offset`) does not fetch the page again. */
const CACHE_ENTRIES = 16;
const CACHE_TTL_MS = 10 * 60 * 1000;

interface CachedPage {
  title: string | undefined;
  url: string;
  warning: string | undefined;
  markdown: string;
  at: number;
}

export class Web {
  private readonly options: WebOptions;
  private readonly extractPool: ExtractPool;
  private readonly scrapeLimit = pLimit(4);
  private readonly searchDomainLimit = pLimit(4);
  private readonly timeoutMs: number;
  private readonly pageBytes: number;
  private readonly pages = new Map<string, CachedPage>();
  private searxng: SearxngService | undefined;
  private readonly listener = (message: unknown, name: string | symbol) =>
    this.log(message, String(name));
  /** Whether `search` can run: given a SearXNG, or on a platform with a prebuilt one. */
  readonly searchable: boolean;
  private closed = false;

  constructor(options: WebOptions) {
    this.options = options;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.pageBytes = options.pageBytes ?? DEFAULT_PAGE_BYTES;
    // Workers start on the first page and stay until `close`; extraction is CPU work, and a big
    // page must not stall every session's event loop.
    this.extractPool = new ExtractPool({
      size: 2,
      taskTimeoutMs: Math.max(10_000, this.timeoutMs),
    });
    const external =
      options.searxngUrl !== undefined && options.searxngUrl !== "";
    const os = options.platform?.os ?? process.platform;
    const cpu = options.platform?.cpu ?? process.arch;
    this.searchable =
      external ||
      TARGETS.some((target) => target.os === os && target.cpu === cpu);
    if (!this.searchable)
      options.warn(
        `[eta] web: no prebuilt SearXNG for ${os}-${cpu}, so agents have no web_search; ` +
          "give the host one with --searxng-url (or ETA_SEARXNG_URL)",
      );
    for (const name of CHANNELS) subscribe(name, this.listener);
  }

  /**
   * A part of a page's Markdown, from character `offset` on and at most `pageBytes` long, ending
   * at a line break where one is near. Reading on from an offset uses the copy the first call
   * fetched, when it is recent; the start of a page is always fetched again.
   */
  async fetchPage(
    url: string,
    options: { onlyMainContent?: boolean | undefined; offset?: number },
    signal?: AbortSignal,
  ): Promise<PageSlice> {
    const onlyMainContent = options.onlyMainContent ?? true;
    const offset = options.offset ?? 0;
    const key = `${onlyMainContent ? "main" : "all"} ${url}`;
    let page = offset > 0 ? this.cached(key) : undefined;
    if (page === undefined) {
      page = await this.scrape(url, onlyMainContent, signal);
      this.remember(key, page);
      // The model may well go on with the address the page ended up at.
      if (page.url !== url)
        this.remember(`${onlyMainContent ? "main" : "all"} ${page.url}`, page);
    }
    const total = page.markdown.length;
    if (offset > 0 && offset >= total)
      throw new AppError(
        "BAD_REQUEST",
        `offset ${offset} is past the end of the page (${total} characters)`,
      );
    const { text, end } = sliceText(page.markdown, offset, this.pageBytes);
    return {
      title: page.title,
      url: page.url,
      warning: page.warning,
      markdown: text,
      start: offset,
      end,
      total,
    };
  }

  /** Search through SearXNG; `searchable` says whether there is one to ask. */
  async search(
    request: SearchRequest,
    signal?: AbortSignal,
  ): Promise<SearchOutcome> {
    const searxng = this.searxngService();
    const { data, warning } = await search(
      {
        settings: this.settings(),
        scrapeLimit: this.scrapeLimit,
        extractPool: this.extractPool,
        searchDomainLimit: this.searchDomainLimit,
        // The search waits for a SearXNG that is still starting within its signal and timeout.
        searxng,
      },
      request,
      signal,
    );
    return { data, warning };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const name of CHANNELS) unsubscribe(name, this.listener);
    this.pages.clear();
    await this.extractPool.close();
    await this.searxng?.close();
  }

  private async scrape(
    url: string,
    onlyMainContent: boolean,
    signal: AbortSignal | undefined,
  ): Promise<CachedPage> {
    const { document } = await scrapeUrl(
      {
        settings: this.settings(),
        scrapeLimit: this.scrapeLimit,
        extractPool: this.extractPool,
      },
      url,
      { formats: ["markdown"], onlyMainContent, removeBase64Images: true },
      signal === undefined ? {} : { signal },
    );
    return pageOf(document, url);
  }

  private settings() {
    const proxyUrl = proxyFromEnvironment();
    return {
      allowPrivateNetwork: this.options.allowPrivateNetwork === true,
      userAgent: "eta (+https://github.com/0xfe-project/eta)",
      timeout: this.timeoutMs,
      maxBodyBytes: MAX_BODY_BYTES,
      ...(proxyUrl === undefined ? {} : { proxyUrl }),
    };
  }

  /** Made on the first search, so the managed SearXNG gets the proxy eta's settings applied. */
  private searxngService(): SearxngService {
    if (this.closed)
      throw new AppError("INTERNAL_ERROR", "the host is stopping");
    if (!this.searchable)
      throw new AppError(
        "SEARCH_BACKEND_UNAVAILABLE",
        "this host has no SearXNG to search with",
      );
    if (this.searxng === undefined) {
      const external = this.options.searxngUrl ?? "";
      const proxyUrl = proxyFromEnvironment();
      this.searxng = new SearxngService(
        external !== ""
          ? { url: external.replace(/\/+$/, "") }
          : proxyUrl === undefined
            ? {}
            : { proxyUrl },
      );
    }
    return this.searxng;
  }

  private cached(key: string): CachedPage | undefined {
    const page = this.pages.get(key);
    if (page === undefined) return undefined;
    if (Date.now() - page.at > CACHE_TTL_MS) {
      this.pages.delete(key);
      return undefined;
    }
    return page;
  }

  private remember(key: string, page: CachedPage): void {
    this.pages.delete(key);
    this.pages.set(key, page);
    while (this.pages.size > CACHE_ENTRIES) {
      const oldest = this.pages.keys().next().value;
      if (oldest === undefined) break;
      this.pages.delete(oldest);
    }
  }

  private log(message: unknown, channel: string): void {
    if (typeof message !== "object" || message === null) return;
    const { level, msg, fields } = message as {
      level?: unknown;
      msg?: unknown;
      fields?: unknown;
    };
    // The host has one level for what it says to the operator; the libraries' debug and info
    // lines (every page fetched, SearXNG's own output) are not for it.
    if (level !== "warn" && level !== "error") return;
    const extra =
      typeof fields === "object" && fields !== null
        ? Object.entries(fields)
            .map(
              ([k, v]) =>
                ` ${k}=${typeof v === "string" ? v : JSON.stringify(v)}`,
            )
            .join("")
        : "";
    this.options.warn(
      `[eta] web: ${channel.slice("searxng-js:sex:".length)}: ${String(msg)}${extra}`,
    );
  }
}

function pageOf(document: Document, url: string): CachedPage {
  const metadata = document.metadata ?? {};
  return {
    title: metadata.title === "" ? undefined : metadata.title,
    url: metadata.url ?? metadata.sourceURL ?? url,
    warning: document.warning,
    markdown: document.markdown ?? "",
    at: Date.now(),
  };
}

/**
 * The proxy eta's network settings left in the environment (`@eta/server`'s `initializeNetwork`),
 * as the one URL the libraries take. Loopback is in `NO_PROXY` there, and a fetch never goes to
 * loopback, so `NO_PROXY` has nothing to add.
 */
function proxyFromEnvironment(): string | undefined {
  for (const key of [
    "HTTPS_PROXY",
    "https_proxy",
    "HTTP_PROXY",
    "http_proxy",
  ]) {
    const value = process.env[key];
    if (value !== undefined && value.trim() !== "") return value.trim();
  }
  return undefined;
}

/**
 * `text` from character `start`, at most `maxBytes` of UTF-8. A cut in the middle of the text goes
 * back to the last line break in the second half of the part, so a line is not split when it can
 * be helped, and never between the two halves of a surrogate pair.
 */
export function sliceText(
  text: string,
  start: number,
  maxBytes: number,
): { text: string; end: number } {
  let bytes = 0;
  let end = start;
  while (end < text.length) {
    const code = text.codePointAt(end) ?? 0;
    const width = code > 0xffff ? 2 : 1;
    const size = code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
    if (bytes + size > maxBytes) break;
    bytes += size;
    end += width;
  }
  if (end < text.length) {
    const lineBreak = text.lastIndexOf("\n", end - 1);
    if (lineBreak >= start + (end - start) / 2) end = lineBreak + 1;
  }
  // A budget smaller than the first character still moves on.
  if (end === start && start < text.length)
    end = start + ((text.codePointAt(start) ?? 0) > 0xffff ? 2 : 1);
  return { text: text.slice(start, end), end };
}
