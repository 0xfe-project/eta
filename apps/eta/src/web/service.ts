/**
 * Reading the web, in this process: a page as Markdown (`@searxng-js/sex-scrape`) and a search
 * through SearXNG (`@searxng-js/sex-search`). No service of ours stands in between: the libraries
 * are called here, on the host, for every session (a daemon's sessions reach them over
 * `tool.call`, like the other product tools).
 *
 * - **Fetching** goes through sex-egress, whose SSRF guard stays on: loopback, private, link-local
 *   and metadata addresses are refused, and the request is pinned to the address it checked. The
 *   one opening is the config's `web.privateNetwork` (`setPrivateNetwork`): the networks and names
 *   it lists, and loopback behind its own switch, are allowed and still checked on every hop and
 *   pinned; link-local and metadata addresses never are. The proxy is the one eta's network
 *   settings put in the environment, read at each call, since those settings are applied after
 *   the product is made.
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
import type { PrivateNetworkConfig } from "@eta/client-contracts";
import type { PrivateNetworkAccess } from "@searxng-js/sex-egress";
import type { Document } from "@searxng-js/sex-scrape";
import type { SearchData, SearchRequest } from "@searxng-js/sex-search";
import { subscribe, unsubscribe } from "node:diagnostics_channel";
import process from "node:process";
import { TARGETS } from "@searxng-js/searxng";
import { classifyAddress } from "@searxng-js/sex-egress";
import { ExtractPool } from "@searxng-js/sex-page";
import { AppError, scrapeUrl } from "@searxng-js/sex-scrape";
import { search } from "@searxng-js/sex-search";
import { SearxngService } from "@searxng-js/sex-searxng";
import pLimit from "p-limit";

export interface WebOptions {
  /** An external SearXNG (its base URL). Without one the host runs the prebuilt one, where it can. */
  searxngUrl?: string | undefined;
  /**
   * Let fetches reach loopback and private addresses with no check at all (and no pinning). Only a
   * test sets it, for its fixture site on 127.0.0.1; a host never does. What a user opens goes
   * through `setPrivateNetwork`, which keeps the checks.
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

/** What is wrong with an entry, for the host's log. */
const ENTRY_PROBLEMS: Record<
  PrivateNetworkConfig["invalid"][number]["reason"],
  string
> = {
  syntax: "not a network, address or host name",
  url: "a URL; write the host or network only",
  port: "not a valid port",
  prefix: "not a valid prefix length",
  never: "link-local and cloud metadata addresses are never allowed",
  loopback: "loopback is opened by the local services switch instead",
};

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
  /**
   * What the config opens in private networks: `false`, or one allowlist object for as long as
   * the config says the same (sex-egress keeps its address cache per object).
   */
  private privateNetwork: PrivateNetworkAccess = false;
  private privateNetworkKey = JSON.stringify(undefined);

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

  /**
   * Apply the config's `web.privateNetwork` to the fetches that start from now on. A change is
   * written to the host's log, with every entry that has no effect; the same config again is not
   * a change. Pages kept for reading on are dropped, so a page the list no longer opens is not
   * read from the copy.
   */
  setPrivateNetwork(config: PrivateNetworkConfig | undefined): void {
    const open =
      config !== undefined && (config.loopback || config.allow.length > 0);
    const key = JSON.stringify(
      open ? { allow: config.allow, loopback: config.loopback } : undefined,
    );
    if (key === this.privateNetworkKey) return;
    const first = this.privateNetworkKey === JSON.stringify(undefined);
    this.privateNetworkKey = key;
    this.privateNetwork = open
      ? { allow: [...config.allow], loopback: config.loopback }
      : false;
    this.pages.clear();
    if (!open) {
      if (!first)
        this.options.warn(
          "[eta] web: private network: closed (web_fetch reaches public addresses only)",
        );
      return;
    }
    const invalid = new Set(config.invalid.map((item) => item.entry));
    const valid = config.allow.filter((entry) => !invalid.has(entry));
    this.options.warn(
      `[eta] web: private network: web_fetch may reach ${valid.length === 0 ? "no listed address" : valid.join(", ")}; ` +
        `local services (loopback) ${config.loopback ? "on" : "off"}`,
    );
    for (const item of config.invalid)
      this.options.warn(
        `[eta] web: private network: ignoring ${JSON.stringify(item.entry)} in web.privateNetwork.allow (${ENTRY_PROBLEMS[item.reason]})`,
      );
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
    try {
      const { document } = await scrapeUrl(
        {
          settings: this.settings(url),
          scrapeLimit: this.scrapeLimit,
          extractPool: this.extractPool,
        },
        url,
        { formats: ["markdown"], onlyMainContent, removeBase64Images: true },
        signal === undefined ? {} : { signal },
      );
      return pageOf(document, url);
    } catch (error) {
      throw blockedHere(error);
    }
  }

  /** The libraries' settings for a fetch that starts at `url` (the proxy depends on it). */
  private settings(url?: string) {
    const proxyUrl = url === undefined ? proxyFromEnvironment() : proxyFor(url);
    return {
      allowPrivateNetwork:
        this.options.allowPrivateNetwork === true ? true : this.privateNetwork,
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

/**
 * The library's refusal of a private address, said the way this host is configured: where the
 * user opens it (the settings page) instead of the library's own command-line flag, which a host
 * does not have. Everything else passes through as it was thrown.
 */
function blockedHere(error: unknown): unknown {
  if (!AppError.isInstance(error) || error.code !== "PRIVATE_NETWORK_BLOCKED")
    return error;
  const details = (error.details ?? {}) as {
    host?: unknown;
    address?: unknown;
    reason?: unknown;
  };
  const host = typeof details.host === "string" ? details.host : undefined;
  const address =
    typeof details.address === "string" && details.address !== host
      ? ` (${details.address})`
      : "";
  const where = host === undefined ? "This address" : `${host}${address}`;
  // Without a list, sex-egress 0.2.0 reports loopback as `private`; it is the switch either way.
  const reason =
    details.reason === "private" &&
    typeof details.address === "string" &&
    classifyAddress(details.address) === "loopback"
      ? "loopback"
      : details.reason;
  const message =
    reason === "never"
      ? `${where} is a link-local or cloud metadata address; those are never fetched.`
      : reason === "loopback"
        ? `${where} is on the host itself; to allow local services, turn on "Allow local services (localhost)" in Settings › Network › Private network.`
        : `${where} is in a private network; to allow it, add it in Settings › Network › Private network.`;
  return new AppError("PRIVATE_NETWORK_BLOCKED", message, error.details);
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
 * The proxy for a fetch that starts at `url`: none when `NO_PROXY` names its host (loopback is
 * always there, `@eta/server`'s `initializeNetwork` puts it in), so local services and intranet
 * hosts the user exempted are reached directly, checked and pinned like any other address. The
 * decision is the first URL's: the redirects of one fetch go the same way.
 *
 * `NO_PROXY` entries match a host name exactly or as a domain suffix (`corp.internal` and
 * `.corp.internal` both cover `docs.corp.internal`), and an address literally; `*` is everything.
 * Networks (CIDR) in `NO_PROXY` are not matched.
 */
function proxyFor(url: string): string | undefined {
  const proxy = proxyFromEnvironment();
  if (proxy === undefined) return undefined;
  let host: string;
  try {
    host = new URL(url).hostname.replace(/^\[|\]$/g, "").toLowerCase();
  } catch {
    return proxy;
  }
  const bypass = (process.env.NO_PROXY ?? process.env.no_proxy ?? "")
    .split(/[\s,]+/)
    .map((entry) =>
      entry
        .trim()
        .toLowerCase()
        .replace(/^\[|\](:\d+)?$/g, "")
        .replace(/^\*?\./, ""),
    )
    .filter((entry) => entry !== "");
  const exempt = bypass.some(
    (entry) =>
      entry === "*" ||
      host === entry ||
      host === entry.replace(/:\d+$/, "") ||
      host.endsWith(`.${entry.replace(/:\d+$/, "")}`),
  );
  return exempt ? undefined : proxy;
}

/**
 * The proxy eta's network settings left in the environment (`@eta/server`'s `initializeNetwork`),
 * as the one URL the libraries take.
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
