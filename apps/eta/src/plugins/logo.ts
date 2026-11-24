import type { LookupAddress } from "node:dns";
import type { IncomingMessage } from "node:http";
import type { IconCache } from "./icon-cache";
/**
 * Plugin logos for the market: the host fetches them, so the client never contacts a catalog's
 * servers and a page cannot make the client's network reach anything. The address is untrusted:
 * only http(s); the host name is resolved here and every address must be public; the connection
 * goes to that very address (so a later DNS answer cannot move it); a redirect is checked again;
 * the answer is capped in size and must be a picture by its first bytes. No third-party icon
 * service is asked. A homepage on github.com or gitlab.com is not asked either: its icon is the
 * site's, not the plugin's. A result, and a miss, is kept in memory for a day.
 */
import { Buffer } from "node:buffer";
import { lookup } from "node:dns/promises";
import { readFile, realpath, stat } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import { extname, isAbsolute, resolve, sep } from "node:path";
import { fitImage } from "../images/fit";
import { viaProxy } from "./git";
import { fitIco } from "./ico";

export interface Logo {
  type: string;
  /** The picture, base64. */
  data: string;
}

const MAX_PAGE = 256 * 1024;
const MAX_PICTURE = 256 * 1024;
const TIMEOUT_MS = 5000;
const MAX_REDIRECTS = 3;
const KEEP_MS = 24 * 60 * 60 * 1000;
/** A lookup that failed is not asked again for this long; it is never kept as "no picture". */
const RETRY_MS = 2 * 60 * 1000;
/** A logo read at a commit cannot change: kept long. A branch or HEAD is kept a day. */
const PINNED_MS = 30 * 24 * 60 * 60 * 1000;
const COMMIT = /^[0-9a-f]{40}$/;
/** The `repo` under which `find` keeps its answers in the database (no repository is named like this). */
const FOUND = "#find";
/** The same for `fromUrl`: the picture's address is its `ref` and `path`. */
const FROM_URL = "#composio";
const SKIPPED = new Set([
  "github.com",
  "www.github.com",
  "gitlab.com",
  "www.gitlab.com",
]);

/** Whether an address is one this host must not call: private, loopback, link-local, reserved. */
export function isPrivateAddress(address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) return isPrivateAddress(mapped[1]!);
  if (isIP(address) === 4) {
    const [a, b] = address.split(".").map(Number) as [number, number];
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0)
      // 198.18.0.0/15 is not listed: fake-IP proxies (Clash and the like) answer every name from it,
      // so refusing it refuses every real site on such a machine. It is not routable, and the proxy
      // resolves the real name itself.
    );
  }
  const low = address.toLowerCase();
  return (
    low === "::" ||
    low === "::1" ||
    low.startsWith("fc") ||
    low.startsWith("fd") ||
    /^fe[89ab]/.test(low) ||
    low.startsWith("ff") ||
    low.startsWith("2001:db8")
  );
}

/** The picture type from its first bytes; SVG is not accepted (it can carry script). */
export function pictureType(bytes: Uint8Array): string | null {
  const is = (...head: number[]) => head.every((byte, i) => bytes[i] === byte);
  if (is(0x89, 0x50, 0x4e, 0x47)) return "image/png";
  if (is(0xff, 0xd8, 0xff)) return "image/jpeg";
  if (is(0x47, 0x49, 0x46, 0x38)) return "image/gif";
  if (is(0x00, 0x00, 0x01, 0x00)) return "image/x-icon";
  if (is(0x52, 0x49, 0x46, 0x46) && bytes[8] === 0x57 && bytes[9] === 0x45)
    return "image/webp";
  return null;
}

const OWN_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
};
const MAX_OWN = 256 * 1024;
/**
 * The types a kept picture may have: what a fresh fetch accepts (`pictureType`) and an SVG. A kept
 * ico or gif must read back like a fresh one, or a restart asks the site for it again.
 */
const KEPT_TYPES = new Set([
  ...Object.values(OWN_TYPES),
  "image/gif",
  "image/x-icon",
]);
/** The types Bun.Image can read and `fitImage` can shrink; svg and ico are not among them. */
const SHRINKABLE = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);
/** What makes an SVG unfit: script, handlers, embedded pages, entities, references that leave the file. */
const SVG_UNSAFE =
  /<script|<foreignObject|<iframe|<embed|<object|<!ENTITY|\son[a-z]+\s*=|javascript:|(?:xlink:)?href\s*=\s*["'](?!#)/i;
const SVG_HEAD =
  /^\s*(?:<\?xml[^>]*\?>\s*)?(?:<!--[\s\S]*?-->\s*)*(?:<!DOCTYPE\s+svg[^>[]*>\s*)?<svg\b/i;

/**
 * A plugin's own picture: `rel` is a path in its manifest, read only if it stays inside `root`
 * after every link is resolved. png, jpg, webp and svg only, by name and by content, capped in
 * size. An SVG with script or outside references is refused; it is shown as an image, which never
 * runs script either. Anything wrong is null: the card falls back to its letter.
 */
export async function readOwnLogo(
  root: string,
  rel: string,
): Promise<Logo | null> {
  try {
    if (!rel || rel.includes("\0") || isAbsolute(rel) || /^[a-z]+:/i.test(rel))
      return null;
    const mime = OWN_TYPES[extname(rel).toLowerCase()];
    if (!mime) return null;
    const base = await realpath(root);
    const file = await realpath(resolve(base, rel));
    if (!file.startsWith(base.endsWith(sep) ? base : base + sep)) return null;
    const info = await stat(file);
    if (!info.isFile() || info.size > MAX_OWN) return null;
    const body = await readFile(file);
    if (body.length > MAX_OWN) return null;
    if (mime === "image/svg+xml") {
      const text = body.toString("utf8");
      if (!SVG_HEAD.test(text) || SVG_UNSAFE.test(text)) return null;
    } else if (pictureType(body) !== mime) return null;
    return { type: mime, data: body.toString("base64") };
  } catch {
    return null;
  }
}

export interface LogoOptions {
  /** Where a note about a picture goes (it could not be shrunk); the console when absent. */
  warn?: (message: string) => void;
  /** Tests only: allow private addresses, so a local fake server can answer. */
  allowPrivate?: boolean;
  /** Tests only: the name resolver. */
  resolve?: (host: string) => Promise<string[]>;
  /** Tests only: a certificate (PEM) trusted for https, so a local fake server with its own can answer. */
  ca?: string;
  /** Tests only: the sites asked for a server's icon, in order (a local fake has no parent host). */
  sites?: (server: string) => string[];
  timeoutMs?: number;
  now?: () => number;
  /** Tests only: where raw files are read from, in place of https://raw.githubusercontent.com. */
  rawBase?: string;
  /** Where answers are kept between runs. */
  store?: IconCache;
}

const RAW = "https://raw.githubusercontent.com";
const MAX_MANIFEST = 64 * 1024;
/** Lookups into a repository that run at once; the rest wait. */
export const MAX_REPO_LOOKUPS = 4;
/** A repository lookup that found nothing is not asked again for this long (a hit stays a day). */
const MISS_MS = 60 * 60 * 1000;
const GITHUB_REPO =
  /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/;
const REF = /^\w[\w./-]{0,127}$/;
const SEGMENT = /^[\w.@+-]+$/;
/** Manifests that can name a logo, in the order the loader reads them. */
const MANIFESTS = [".cursor-plugin/plugin.json", ".claude-plugin/plugin.json"];

/** `path` as clean segments of a path inside a repository; throws for anything that could leave it. */
function segments(path: string): string[] {
  const parts = path.split("/").filter((part) => part !== "" && part !== ".");
  if (path.includes("\\") || path.includes("\0") || path.length > 512)
    throw new Refused("bad path");
  for (const part of parts)
    if (part === ".." || !SEGMENT.test(part)) throw new Refused("bad path");
  return parts;
}

class Refused extends Error {}
/** Whether an error is a failure to ask (network, timeout, 5xx), not an answer (a refusal, a 4xx). */
const failure = (error: unknown): boolean =>
  !(error instanceof Refused) &&
  !/^HTTP 4\d\d$/.test(error instanceof Error ? error.message : "");
/** The answer could not be had (network, timeout, 5xx): not a statement that there is no picture. */
class Failed extends Error {}

/** Two-label public suffixes a site name can end in; a small fixed list, not the full public suffix list. */
const SECOND_LEVEL = new Set([
  "co.uk",
  "org.uk",
  "ac.uk",
  "gov.uk",
  "com.au",
  "net.au",
  "org.au",
  "co.nz",
  "co.jp",
  "ne.jp",
  "or.jp",
  "com.cn",
  "net.cn",
  "org.cn",
  "com.hk",
  "com.tw",
  "com.sg",
  "com.br",
  "com.mx",
  "com.tr",
  "co.in",
  "co.kr",
  "co.za",
  "com.ar",
  "com.my",
  "com.ua",
]);

/**
 * The sites to ask for an MCP server's icon: its parent site first (an API host such as
 * mcp.firecrawl.dev has no icon page, firecrawl.dev does), then the server's own origin. The parent
 * is the registrable name: the last two labels, or the last three when the last two are a known
 * second-level suffix (co.uk). A host with fewer labels than that has no parent; an IP has none.
 */
export function siteOf(server: string): string[] {
  try {
    const url = new URL(server);
    if (url.protocol !== "https:" && url.protocol !== "http:") return [];
    const host = url.hostname.toLowerCase();
    const sites: string[] = [];
    if (isIP(host.replace(/^\[|\]$/g, "")) === 0) {
      const labels = host.split(".");
      const take = SECOND_LEVEL.has(labels.slice(-2).join(".")) ? 3 : 2;
      if (labels.length > take)
        sites.push(`${url.protocol}//${labels.slice(-take).join(".")}`);
    }
    sites.push(url.origin);
    return sites;
  } catch {
    return [];
  }
}

/**
 * The most bytes of one logo the host keeps. A raster picture over it is shrunk to fit before it is
 * kept (an svg, and any picture that cannot be shrunk, is kept as it came), so many of them fit in
 * one `cached` answer. Measured on the test database: 112 of 134 kept pictures were within it.
 */
const MAX_ICON_BYTES = 16 * 1024;

/** Entries `cached` answers per call; the ones after it are answered "unknown" without a look. */
export const MAX_CACHED_LOGOS = 200;
/** The most picture data (base64) one `cached` answer carries; hits past it are answered "unknown". */
export const MAX_CACHED_BYTES = 2 * 1024 * 1024;

export type CachedLogo =
  | { status: "hit"; logo: Logo }
  | { status: "miss" }
  | { status: "unknown" };

export class Logos {
  readonly #options: LogoOptions;
  readonly #kept = new Map<string, { at: number; logo: Logo | null }>();
  readonly #repoKept = new Map<string, { until: number; logo: Logo | null }>();
  readonly #repoBackoff = new Map<string, number>();
  #active = 0;
  readonly #waiting: (() => void)[] = [];
  /** Requests made, for tests. */
  requests = 0;
  /** The most repository lookups that ran at once, for tests. */
  peak = 0;

  constructor(options: LogoOptions = {}) {
    this.#options = options;
  }

  /**
   * The first picture found among the plugin's own logo, its homepage's icon, then the icon of its
   * remote MCP server's site (`origin`); null when none. The server's own headers are never sent.
   */
  async find(
    own: string | null,
    homepage: string | null,
    origin: string | null = null,
  ): Promise<Logo | null> {
    const key = `${own ?? ""}\n${homepage ?? ""}\n${origin ?? ""}`;
    const now = (this.#options.now ?? Date.now)();
    const hit = this.#kept.get(key);
    if (hit && now - hit.at < KEEP_MS) return hit.logo;
    // Then what the database kept, checked again as if it had just come: a restart starts from it,
    // not from nothing. An answer past its time is asked for again.
    const stored = [
      FOUND,
      `${own ?? ""}\n${homepage ?? ""}`,
      origin ?? "",
    ] as const;
    const row = this.#options.store?.get(...stored, now);
    if (row !== undefined) {
      const kept =
        row.status === "miss" ? null : this.#checked(row.mime, row.bytes);
      if (kept === undefined) this.#options.store?.delete(...stored);
      else if (now < row.expiresAt) return kept;
    }
    let logo: Logo | null = null;
    // A site that could not be asked is not a statement that it has no picture.
    const seen = { failed: false };
    const asked = (error: unknown): null => {
      if (failure(error)) seen.failed = true;
      return null;
    };
    try {
      if (own) logo = await this.#picture(own);
      if (!logo && homepage)
        logo = await this.#fromHomepage(homepage, seen).catch(asked);
      if (!logo && origin) {
        for (const site of (this.#options.sites ?? siteOf)(origin)) {
          logo = await this.#fromHomepage(site, seen).catch(asked);
          if (logo) break;
        }
      }
    } catch (error) {
      logo = asked(error);
    }
    this.#kept.set(key, { at: now, logo });
    if (logo || !seen.failed)
      this.#options.store?.put(
        ...stored,
        logo
          ? { mime: logo.type, bytes: Buffer.from(logo.data, "base64") }
          : null,
        now + (logo ? KEEP_MS : MISS_MS),
        now,
      );
    return logo;
  }

  /**
   * A picture at one https address (a Composio toolkit's logo), every redirect https too. Same checks
   * as any other fetch here; no header of the host or the user goes with it. Unlike every other way
   * to a picture here it also takes an SVG (Composio's logos are SVG), kept as it is: it must pass
   * the same test as a plugin's own SVG (`readOwnLogo`), or it is no picture. An answer is kept a
   * day, in memory and in the database (checked again when read back); a confirmed miss (a refusal,
   * a 4xx, not a picture) for an hour. A failure to ask (network, timeout, 5xx) is kept nowhere; null
   * when there is no picture.
   */
  async fromUrl(address: string): Promise<Logo | null> {
    const key = `https\n${address}`;
    const now = (this.#options.now ?? Date.now)();
    const hit = this.#kept.get(key);
    if (hit && now - hit.at < KEEP_MS) return hit.logo;
    const stored = [FROM_URL, address, address] as const;
    const row = this.#options.store?.get(...stored, now);
    if (row !== undefined) {
      const kept =
        row.status === "miss" ? null : this.#checked(row.mime, row.bytes);
      if (kept === undefined) this.#options.store?.delete(...stored);
      else if (now < row.expiresAt) {
        this.#kept.set(key, { at: now, logo: kept });
        return kept;
      }
    }
    let failed = false;
    const logo = await this.#picture(address, true, true).catch((error) => {
      if (failure(error)) failed = true;
      return null;
    });
    if (failed) return null;
    this.#kept.set(key, { at: now, logo });
    this.#options.store?.put(
      ...stored,
      logo
        ? { mime: logo.type, bytes: Buffer.from(logo.data, "base64") }
        : null,
      now + (logo ? KEEP_MS : MISS_MS),
      now,
    );
    return logo;
  }

  /**
   * The own logo of a catalog entry that is a path in a GitHub repository, read from the plugin's
   * manifest (`.cursor-plugin/plugin.json`, else `.claude-plugin/plugin.json`) on
   * raw.githubusercontent.com: nothing is cloned. `logo` is a path inside the plugin; the picture
   * is read from the same place. Any other host, or anything wrong, is null. At most
   * MAX_REPO_LOOKUPS run at once, and an answer (a miss for an hour) is kept.
   */
  async fromRepo(
    repo: string,
    ref: string,
    path: string,
  ): Promise<Logo | null> {
    const key = `${repo}\n${ref}\n${path}`;
    const now = (this.#options.now ?? Date.now)();
    const hit = this.#repoKept.get(key);
    if (hit && now < hit.until) return hit.logo;
    // After a failed lookup, wait before asking again; what was known before (even stale) still shows.
    if ((this.#repoBackoff.get(key) ?? 0) > now) return hit?.logo ?? null;
    // Then what the database kept, checked again as if it had just come.
    const row = this.#options.store?.get(repo, ref, path, now);
    let old: Logo | null | undefined;
    if (row !== undefined) {
      old = row.status === "miss" ? null : this.#checked(row.mime, row.bytes);
      if (old === undefined) this.#options.store?.delete(repo, ref, path);
      else if (now < row.expiresAt) {
        this.#repoKept.set(key, { until: row.expiresAt, logo: old });
        return old;
      }
    }
    let logo: Logo | null = null;
    let failed = false;
    try {
      if (this.#active >= MAX_REPO_LOOKUPS)
        await new Promise<void>((go) => this.#waiting.push(go));
      else this.#active++;
      this.peak = Math.max(this.peak, this.#active);
      try {
        logo = await this.#repoLogo(repo, ref, path);
      } finally {
        const next = this.#waiting.shift();
        if (next) next();
        else this.#active--;
      }
    } catch (error) {
      // A refused address or path is an answer (nothing to show); anything else is a failure to ask.
      if (!(error instanceof Refused)) failed = true;
      logo = null;
    }
    if (failed) {
      // Not "no picture": a short backoff, and an earlier hit is neither dropped nor overwritten.
      this.#repoBackoff.set(key, now + RETRY_MS);
      return hit?.logo ?? old ?? null;
    }
    this.#repoBackoff.delete(key);
    // A commit's content cannot change: "no logo of its own there" is as lasting as a picture there.
    const keep = COMMIT.test(ref) ? PINNED_MS : logo ? KEEP_MS : MISS_MS;
    this.#repoKept.set(key, { until: now + keep, logo });
    this.#options.store?.put(
      repo,
      ref,
      path,
      logo
        ? { mime: logo.type, bytes: Buffer.from(logo.data, "base64") }
        : null,
      now + keep,
      now,
    );
    return logo;
  }

  /**
   * A catalog entry's picture: its own logo in the repository, else its homepage's icon. The second
   * answer is kept in the database too (under the entry's key), so a restart asks no site again.
   */
  async forEntry(
    repo: string,
    ref: string,
    path: string,
    homepage: string | null,
  ): Promise<Logo | null> {
    const own = await this.fromRepo(repo, ref, path);
    if (own || !homepage) return own;
    const site = `#site:${homepage}`;
    const now = (this.#options.now ?? Date.now)();
    const row = this.#options.store?.get(repo, ref, site, now);
    if (row !== undefined && now < row.expiresAt) {
      const kept =
        row.status === "miss" ? null : this.#checked(row.mime, row.bytes);
      if (kept !== undefined) return kept;
      this.#options.store?.delete(repo, ref, site);
    }
    // A short wait after a failed ask; a failure is never kept as "no picture".
    const waitKey = `${site}\n${repo}\n${ref}`;
    if ((this.#repoBackoff.get(waitKey) ?? 0) > now) return null;
    const seen = { failed: false };
    const logo = await this.#fromHomepage(homepage, seen).catch((error) => {
      if (failure(error)) seen.failed = true;
      return null;
    });
    if (!logo && seen.failed) {
      this.#repoBackoff.set(waitKey, now + RETRY_MS);
      return null;
    }
    this.#repoBackoff.delete(waitKey);
    const keep = logo ? (COMMIT.test(ref) ? PINNED_MS : KEEP_MS) : MISS_MS;
    this.#options.store?.put(
      repo,
      ref,
      site,
      logo
        ? { mime: logo.type, bytes: Buffer.from(logo.data, "base64") }
        : null,
      now + keep,
      now,
    );
    return logo;
  }

  /**
   * What is kept for entries, and nothing else: memory and the database only, no network, and not
   * in the queue of lookups. An entry is a plugin in a repository, or `{ url }`: the logo address of
   * a Composio toolkit (what `fromUrl` keeps; an empty one is not known). `hit` is a picture
   * (checked again as if it had just come, a stale one too: better than a letter), `miss` a recent
   * answer that there is none, `unknown` anything not known (including entries past
   * MAX_CACHED_LOGOS and hits past MAX_CACHED_BYTES).
   */
  cached(
    entries: (
      | {
          repo: string;
          ref: string;
          path: string;
          homepage: string | null;
        }
      | { url: string }
    )[],
  ): CachedLogo[] {
    const now = (this.#options.now ?? Date.now)();
    let total = 0;
    return entries.map((one, index): CachedLogo => {
      if (index >= MAX_CACHED_LOGOS) return { status: "unknown" };
      let got =
        "url" in one
          ? this.#peekUrl(one.url, now)
          : this.#peek(one.repo, one.ref, one.path, now);
      // No own logo, or not known (a short "none" that has expired reads as not known): the
      // homepage's icon, kept under the entry's key for longer, is next. An own picture wins; a
      // homepage that is not known either does not turn an own logo not known into "none".
      if (
        !("url" in one) &&
        (got === null || got === undefined) &&
        one.homepage
      ) {
        const site = this.#peek(
          one.repo,
          one.ref,
          `#site:${one.homepage}`,
          now,
        );
        if (got === null || (site !== undefined && site !== null)) got = site;
      }
      if (got === undefined) return { status: "unknown" };
      if (got === null) return { status: "miss" };
      if (total + got.data.length > MAX_CACHED_BYTES)
        return { status: "unknown" };
      total += got.data.length;
      return { status: "hit", logo: got };
    });
  }

  /** What `fromUrl` kept for an address, read the same way as `fromUrl` does but never asked for. */
  #peekUrl(address: string, now: number): Logo | null | undefined {
    if (address === "") return undefined;
    const hit = this.#kept.get(`https\n${address}`);
    if (hit && now - hit.at < KEEP_MS) return hit.logo;
    const row = this.#options.store?.peek(FROM_URL, address, address);
    if (row === undefined) return undefined;
    if (row.status === "miss") return now < row.expiresAt ? null : undefined;
    return this.#checked(row.mime, row.bytes);
  }

  /** A picture, null (known: none), or undefined (not known). Reads only. */
  #peek(
    repo: string,
    ref: string,
    path: string,
    now: number,
  ): Logo | null | undefined {
    const hit = this.#repoKept.get(`${repo}\n${ref}\n${path}`);
    if (hit && now < hit.until) return hit.logo;
    const row = this.#options.store?.peek(repo, ref, path);
    if (row === undefined) return undefined;
    if (row.status === "miss") return now < row.expiresAt ? null : undefined;
    return this.#checked(row.mime, row.bytes);
  }

  /** Forget everything kept, in memory and in the database. */
  clear(): number {
    this.#kept.clear();
    this.#repoKept.clear();
    this.#repoBackoff.clear();
    return this.#options.store?.clear() ?? 0;
  }

  /** A kept picture checked again: its type, its size and, for an SVG, the same rules as a fresh one. */
  #checked(mime: string | null, bytes: Uint8Array | null): Logo | undefined {
    if (
      mime === null ||
      bytes === null ||
      bytes.byteLength === 0 ||
      bytes.byteLength > MAX_OWN
    )
      return undefined;
    if (!KEPT_TYPES.has(mime)) return undefined;
    if (mime === "image/svg+xml") {
      const text = Buffer.from(bytes).toString("utf8");
      if (!SVG_HEAD.test(text) || SVG_UNSAFE.test(text)) return undefined;
    } else if (pictureType(bytes) !== mime) return undefined;
    return { type: mime, data: Buffer.from(bytes).toString("base64") };
  }

  async #repoLogo(
    repo: string,
    ref: string,
    path: string,
  ): Promise<Logo | null> {
    const match = GITHUB_REPO.exec(repo.trim());
    if (!match || !REF.test(ref) || ref.includes("..")) return null;
    const dir = segments(path);
    const base = `${this.#options.rawBase ?? RAW}/${match[1]}/${match[2]}/${ref}`;
    const raw = (parts: string[]) =>
      this.#address(viaProxy([base, ...parts].join("/")));
    for (const manifest of MANIFESTS) {
      const got = await this.#getRepo(raw([...dir, manifest]), MAX_MANIFEST);
      if (!got) continue;
      let rel: unknown;
      try {
        rel = (
          JSON.parse(new TextDecoder().decode(got.body)) as { logo?: unknown }
        ).logo;
      } catch {
        continue;
      }
      if (
        typeof rel !== "string" ||
        rel.length > 256 ||
        /^[a-z][a-z0-9+.-]*:/i.test(rel)
      )
        continue;
      let file: string[];
      try {
        file = segments(rel);
      } catch {
        continue;
      }
      const mime = OWN_TYPES[extname(rel).toLowerCase()];
      if (!mime || !file.length) continue;
      const picture = await this.#getRepo(raw([...dir, ...file]), MAX_OWN);
      if (!picture) continue;
      if (mime === "image/svg+xml") {
        const text = Buffer.from(picture.body).toString("utf8");
        if (!SVG_HEAD.test(text) || SVG_UNSAFE.test(text)) continue;
      } else if (pictureType(picture.body) !== mime) continue;
      return await this.#shrunk(
        { type: mime, data: Buffer.from(picture.body).toString("base64") },
        `${repo} ${dir.join("/")}`,
      );
    }
    return null;
  }

  /**
   * A raster picture over MAX_ICON_BYTES, shrunk to fit. One that cannot be (it does not decode, or
   * is still too big at the smallest step) is kept as it came and the reason is said: a picture that
   * showed before must not be lost to a failed shrink, and it is within the size caps already.
   */
  async #shrunk(logo: Logo, label: string): Promise<Logo> {
    const warn = (message: string) =>
      (this.#options.warn ?? ((text) => console.warn(text)))(message);
    if (logo.type === "image/x-icon") {
      // Bun.Image cannot decode an ico: the pictures that fit are kept as they are.
      const bytes = Buffer.from(logo.data, "base64");
      if (bytes.byteLength <= MAX_ICON_BYTES) return logo;
      const cut = fitIco(bytes, MAX_ICON_BYTES);
      if (cut) return { type: logo.type, data: cut.toString("base64") };
      warn(
        `[eta] logo ${label} (${bytes.byteLength} bytes) kept as it was: no picture in the ico fits in ${MAX_ICON_BYTES} bytes`,
      );
      return logo;
    }
    if (!SHRINKABLE.has(logo.type)) return logo;
    const bytes = Buffer.from(logo.data, "base64");
    if (bytes.byteLength <= MAX_ICON_BYTES) return logo;
    try {
      const fitted = await fitImage(label, logo.type, bytes, MAX_ICON_BYTES);
      return { type: fitted.mime, data: fitted.bytes.toString("base64") };
    } catch (error) {
      (this.#options.warn ?? ((message) => console.warn(message)))(
        `[eta] logo ${label} (${bytes.byteLength} bytes) kept as it was: ${error instanceof Error ? error.message : String(error)}`,
      );
      return logo;
    }
  }

  /**
   * One read for a repository lookup. A refusal, or a clear "not there" (a 4xx other than a timeout
   * or a rate limit), is null: there is nothing to show. A network error, a timeout and a 5xx throw
   * `Failed`, so the caller does not take them for an absent picture.
   */
  async #getRepo(
    url: URL,
    cap: number,
  ): Promise<{ url: string; body: Uint8Array } | null> {
    try {
      return await this.#get(url, cap);
    } catch (error) {
      if (error instanceof Refused) return null;
      const status = /^HTTP (\d+)$/.exec(
        error instanceof Error ? error.message : "",
      );
      if (status) {
        const code = Number(status[1]);
        if (code >= 400 && code < 500 && code !== 408 && code !== 429)
          return null;
      }
      throw new Failed(
        error instanceof Error ? error.message : "request failed",
      );
    }
  }

  async #fromHomepage(
    homepage: string,
    seen?: { failed: boolean },
  ): Promise<Logo | null> {
    const page = this.#address(homepage);
    if (SKIPPED.has(page.hostname.toLowerCase())) return null;
    const html = await this.#get(page, MAX_PAGE).catch((error) => {
      if (seen && failure(error)) seen.failed = true;
      return null;
    });
    const candidates: string[] = [];
    if (html) {
      const text = new TextDecoder().decode(html.body);
      for (const tag of text.match(/<link\b[^>]*>/gi) ?? []) {
        const rel =
          /\brel\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1]?.toLowerCase() ?? "";
        const href = /\bhref\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1];
        if (
          href &&
          /(?:^|\s)(?:icon|shortcut icon|apple-touch-icon)(?:\s|$)/.test(rel)
        ) {
          try {
            candidates.push(new URL(href, html.url).href);
          } catch {
            // Not an address.
          }
        }
      }
    }
    candidates.push(new URL("/favicon.ico", page).href);
    for (const candidate of candidates.slice(0, 4)) {
      const logo = await this.#picture(candidate).catch((error) => {
        if (seen && failure(error)) seen.failed = true;
        return null;
      });
      if (logo) return logo;
    }
    return null;
  }

  async #picture(
    address: string,
    httpsOnly = false,
    svg = false,
  ): Promise<Logo | null> {
    const got = await this.#get(
      this.#address(address, httpsOnly),
      MAX_PICTURE,
      httpsOnly,
    );
    const type = pictureType(got.body);
    if (!type && svg) {
      const text = Buffer.from(got.body).toString("utf8");
      return SVG_HEAD.test(text) && !SVG_UNSAFE.test(text)
        ? {
            type: "image/svg+xml",
            data: Buffer.from(got.body).toString("base64"),
          }
        : null;
    }
    return type
      ? await this.#shrunk(
          { type, data: Buffer.from(got.body).toString("base64") },
          new URL(address).host,
        )
      : null;
  }

  #address(value: string, httpsOnly = false): URL {
    const url = new URL(value);
    if (url.protocol !== "https:" && (httpsOnly || url.protocol !== "http:"))
      throw new Refused(
        httpsOnly ? "not an https address" : "not an http(s) address",
      );
    if (url.username || url.password)
      throw new Refused("an address with credentials");
    return url;
  }

  /** One GET with the redirects followed by hand, each hop checked; the body is capped. */
  async #get(
    start: URL,
    cap: number,
    httpsOnly = false,
  ): Promise<{ url: string; body: Uint8Array }> {
    let url = start;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const response = await this.#once(url, cap);
      const status = response.status;
      if (status >= 300 && status < 400 && response.location) {
        // The GitHub proxy is for GitHub hosts only; viaProxy leaves any other address alone.
        url = this.#address(
          viaProxy(new URL(response.location, url).href),
          httpsOnly,
        );
        continue;
      }
      if (status !== 200) throw new Error(`HTTP ${status}`);
      return { url: url.href, body: response.body };
    }
    throw new Refused("too many redirects");
  }

  async #once(
    url: URL,
    cap: number,
  ): Promise<{ status: number; location: string | null; body: Uint8Array }> {
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const found: string[] =
      isIP(host) !== 0
        ? [host]
        : this.#options.resolve
          ? await this.#options.resolve(host)
          : (await lookup(host, { all: true })).map(
              (one: LookupAddress) => one.address,
            );
    const usable = this.#options.allowPrivate
      ? found
      : found.filter((one) => !isPrivateAddress(one));
    // One private answer is enough to refuse: a name must not be half inside the network.
    if (!usable.length || usable.length !== found.length)
      throw new Refused("the address is not a public one");
    const pinned = usable[0]!;
    const secure = url.protocol === "https:";
    const timeoutMs = this.#options.timeoutMs ?? TIMEOUT_MS;
    this.requests++;
    return await new Promise((resolve, reject) => {
      const request = (secure ? https : http).request(
        {
          host: pinned,
          port: url.port || (secure ? 443 : 80),
          path: url.pathname + url.search,
          method: "GET",
          servername: secure && isIP(host) === 0 ? host : undefined,
          ca: this.#options.ca,
          headers: {
            host: url.host,
            accept: "image/*,text/html;q=0.8",
            "user-agent": "eta-logo",
          },
          timeout: timeoutMs,
        },
        (response: IncomingMessage) => {
          const chunks: Buffer[] = [];
          let size = 0;
          const location = response.headers.location ?? null;
          response.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > cap) {
              reject(new Refused("too large"));
              response.destroy();
              request.destroy();
              return;
            }
            chunks.push(chunk);
          });
          // An answer cut short is a failure, never a short body taken for the whole one.
          response.on("end", () => {
            if (!response.complete)
              reject(new Error("the connection closed early"));
            else
              resolve({
                status: response.statusCode ?? 0,
                location,
                body: Buffer.concat(chunks),
              });
          });
          response.on("close", () => {
            if (!response.complete)
              reject(new Error("the connection closed early"));
          });
          response.on("error", () => undefined);
        },
      );
      const stop = setTimeout(
        () => request.destroy(new Error("no answer")),
        timeoutMs,
      );
      request.on("timeout", () => request.destroy(new Error("no answer")));
      request.on("error", (error) => reject(error));
      request.on("close", () => clearTimeout(stop));
      request.end();
    });
  }
}
