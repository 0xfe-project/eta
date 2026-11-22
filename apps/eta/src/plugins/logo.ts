/**
 * Plugin logos for the market: the host fetches them, so the client never contacts a catalog's
 * servers and a page cannot make the client's network reach anything. The address is untrusted:
 * only http(s); the host name is resolved here and every address must be public; the connection
 * goes to that very address (so a later DNS answer cannot move it); a redirect is checked again;
 * the answer is capped in size and must be a picture by its first bytes. No third-party icon
 * service is asked. A homepage on github.com or gitlab.com is not asked either: its icon is the
 * site's, not the plugin's. A result, and a miss, is kept in memory for a day.
 */
import type { LookupAddress } from "node:dns";
import type { IncomingMessage } from "node:http";
import { lookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { readFile, realpath, stat } from "node:fs/promises";
import { isIP } from "node:net";
import { extname, isAbsolute, resolve, sep } from "node:path";
import { viaProxy } from "./git";

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
const SKIPPED = new Set(["github.com", "www.github.com", "gitlab.com", "www.gitlab.com"]);

/** Whether an address is one this host must not call: private, loopback, link-local, reserved. */
export function isPrivateAddress(address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) return isPrivateAddress(mapped[1]!);
  if (isIP(address) === 4) {
    const [a, b] = address.split(".").map(Number) as [number, number];
    return (
      a === 0 || a === 10 || a === 127 || a >= 224 ||
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
    low === "::" || low === "::1" ||
    low.startsWith("fc") || low.startsWith("fd") ||
    /^fe[89ab]/.test(low) || low.startsWith("ff") || low.startsWith("2001:db8")
  );
}

/** The picture type from its first bytes; SVG is not accepted (it can carry script). */
export function pictureType(bytes: Uint8Array): string | null {
  const is = (...head: number[]) => head.every((byte, i) => bytes[i] === byte);
  if (is(0x89, 0x50, 0x4e, 0x47)) return "image/png";
  if (is(0xff, 0xd8, 0xff)) return "image/jpeg";
  if (is(0x47, 0x49, 0x46, 0x38)) return "image/gif";
  if (is(0x00, 0x00, 0x01, 0x00)) return "image/x-icon";
  if (is(0x52, 0x49, 0x46, 0x46) && bytes[8] === 0x57 && bytes[9] === 0x45) return "image/webp";
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
/** What makes an SVG unfit: script, handlers, embedded pages, entities, references that leave the file. */
const SVG_UNSAFE =
  /<script|<foreignObject|<iframe|<embed|<object|<!ENTITY|\son[a-z]+\s*=|javascript:|(?:xlink:)?href\s*=\s*["'](?!#)/i;
const SVG_HEAD = /^\s*(<\?xml[^>]*\?>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE\s+svg[^>[]*>\s*)?<svg\b/i;

/**
 * A plugin's own picture: `rel` is a path in its manifest, read only if it stays inside `root`
 * after every link is resolved. png, jpg, webp and svg only, by name and by content, capped in
 * size. An SVG with script or outside references is refused; it is shown as an image, which never
 * runs script either. Anything wrong is null: the card falls back to its letter.
 */
export async function readOwnLogo(root: string, rel: string): Promise<Logo | null> {
  try {
    if (!rel || rel.includes("\0") || isAbsolute(rel) || /^[a-z]+:/i.test(rel)) return null;
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
  /** Tests only: allow private addresses, so a local fake server can answer. */
  allowPrivate?: boolean;
  /** Tests only: the name resolver. */
  resolve?: (host: string) => Promise<string[]>;
  /** Tests only: the sites asked for a server's icon, in order (a local fake has no parent host). */
  sites?: (server: string) => string[];
  timeoutMs?: number;
  now?: () => number;
  /** Tests only: where raw files are read from, in place of https://raw.githubusercontent.com. */
  rawBase?: string;
}

const RAW = "https://raw.githubusercontent.com";
const MAX_MANIFEST = 64 * 1024;
/** Lookups into a repository that run at once; the rest wait. */
export const MAX_REPO_LOOKUPS = 4;
/** A repository lookup that found nothing is not asked again for this long (a hit stays a day). */
const MISS_MS = 60 * 60 * 1000;
const GITHUB_REPO = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/;
const REF = /^[\w][\w./-]{0,127}$/;
const SEGMENT = /^[\w.@+-]+$/;
/** Manifests that can name a logo, in the order the loader reads them. */
const MANIFESTS = [".cursor-plugin/plugin.json", ".claude-plugin/plugin.json"];

/** `path` as clean segments of a path inside a repository; throws for anything that could leave it. */
function segments(path: string): string[] {
  const parts = path.split("/").filter((part) => part !== "" && part !== ".");
  if (path.includes("\\") || path.includes("\0") || path.length > 512) throw new Refused("bad path");
  for (const part of parts) if (part === ".." || !SEGMENT.test(part)) throw new Refused("bad path");
  return parts;
}

class Refused extends Error {}

/** Two-label public suffixes a site name can end in; a small fixed list, not the full public suffix list. */
const SECOND_LEVEL = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk", "com.au", "net.au", "org.au", "co.nz", "co.jp", "ne.jp", "or.jp",
  "com.cn", "net.cn", "org.cn", "com.hk", "com.tw", "com.sg", "com.br", "com.mx", "com.tr", "co.in",
  "co.kr", "co.za", "com.ar", "com.my", "com.ua",
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
      if (labels.length > take) sites.push(`${url.protocol}//${labels.slice(-take).join(".")}`);
    }
    sites.push(url.origin);
    return sites;
  } catch {
    return [];
  }
}

export class Logos {
  readonly #options: LogoOptions;
  readonly #kept = new Map<string, { at: number; logo: Logo | null }>();
  readonly #repoKept = new Map<string, { until: number; logo: Logo | null }>();
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
  async find(own: string | null, homepage: string | null, origin: string | null = null): Promise<Logo | null> {
    const key = (own ?? "") + "\n" + (homepage ?? "") + "\n" + (origin ?? "");
    const now = (this.#options.now ?? Date.now)();
    const hit = this.#kept.get(key);
    if (hit && now - hit.at < KEEP_MS) return hit.logo;
    let logo: Logo | null = null;
    try {
      if (own) logo = await this.#picture(own);
      if (!logo && homepage) logo = await this.#fromHomepage(homepage).catch(() => null);
      if (!logo && origin) {
        for (const site of (this.#options.sites ?? siteOf)(origin)) {
          logo = await this.#fromHomepage(site).catch(() => null);
          if (logo) break;
        }
      }
    } catch {
      logo = null;
    }
    this.#kept.set(key, { at: now, logo });
    return logo;
  }

  /**
   * The own logo of a catalog entry that is a path in a GitHub repository, read from the plugin's
   * manifest (`.cursor-plugin/plugin.json`, else `.claude-plugin/plugin.json`) on
   * raw.githubusercontent.com: nothing is cloned. `logo` is a path inside the plugin; the picture
   * is read from the same place. Any other host, or anything wrong, is null. At most
   * MAX_REPO_LOOKUPS run at once, and an answer (a miss for an hour) is kept.
   */
  async fromRepo(repo: string, ref: string, path: string): Promise<Logo | null> {
    const key = repo + "\n" + ref + "\n" + path;
    const now = (this.#options.now ?? Date.now)();
    const hit = this.#repoKept.get(key);
    if (hit && now < hit.until) return hit.logo;
    let logo: Logo | null = null;
    try {
      if (this.#active >= MAX_REPO_LOOKUPS) await new Promise<void>((go) => this.#waiting.push(go));
      else this.#active++;
      this.peak = Math.max(this.peak, this.#active);
      try {
        logo = await this.#repoLogo(repo, ref, path);
      } finally {
        const next = this.#waiting.shift();
        if (next) next();
        else this.#active--;
      }
    } catch {
      logo = null;
    }
    this.#repoKept.set(key, { until: now + (logo ? KEEP_MS : MISS_MS), logo });
    return logo;
  }

  async #repoLogo(repo: string, ref: string, path: string): Promise<Logo | null> {
    const match = GITHUB_REPO.exec(repo.trim());
    if (!match || !REF.test(ref) || ref.includes("..")) return null;
    const dir = segments(path);
    const base = `${this.#options.rawBase ?? RAW}/${match[1]}/${match[2]}/${ref}`;
    const raw = (parts: string[]) => this.#address(viaProxy([base, ...parts].join("/")));
    for (const manifest of MANIFESTS) {
      const got = await this.#get(raw([...dir, manifest]), MAX_MANIFEST).catch(() => null);
      if (!got) continue;
      let rel: unknown;
      try {
        rel = (JSON.parse(new TextDecoder().decode(got.body)) as { logo?: unknown }).logo;
      } catch {
        continue;
      }
      if (typeof rel !== "string" || rel.length > 256 || /^[a-z][a-z0-9+.-]*:/i.test(rel)) continue;
      let file: string[];
      try {
        file = segments(rel);
      } catch {
        continue;
      }
      const mime = OWN_TYPES[extname(rel).toLowerCase()];
      if (!mime || !file.length) continue;
      const picture = await this.#get(raw([...dir, ...file]), MAX_OWN).catch(() => null);
      if (!picture) continue;
      if (mime === "image/svg+xml") {
        const text = Buffer.from(picture.body).toString("utf8");
        if (!SVG_HEAD.test(text) || SVG_UNSAFE.test(text)) continue;
      } else if (pictureType(picture.body) !== mime) continue;
      return { type: mime, data: Buffer.from(picture.body).toString("base64") };
    }
    return null;
  }

  async #fromHomepage(homepage: string): Promise<Logo | null> {
    const page = this.#address(homepage);
    if (SKIPPED.has(page.hostname.toLowerCase())) return null;
    const html = await this.#get(page, MAX_PAGE).catch(() => null);
    const candidates: string[] = [];
    if (html) {
      const text = new TextDecoder().decode(html.body);
      for (const tag of text.match(/<link\b[^>]*>/gi) ?? []) {
        const rel = /\brel\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1]?.toLowerCase() ?? "";
        const href = /\bhref\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1];
        if (href && /(^|\s)(icon|shortcut icon|apple-touch-icon)(\s|$)/.test(rel)) {
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
      const logo = await this.#picture(candidate).catch(() => null);
      if (logo) return logo;
    }
    return null;
  }

  async #picture(address: string): Promise<Logo | null> {
    const got = await this.#get(this.#address(address), MAX_PICTURE);
    const type = pictureType(got.body);
    return type ? { type, data: Buffer.from(got.body).toString("base64") } : null;
  }

  #address(value: string): URL {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:")
      throw new Refused("not an http(s) address");
    if (url.username || url.password) throw new Refused("an address with credentials");
    return url;
  }

  /** One GET with the redirects followed by hand, each hop checked; the body is capped. */
  async #get(start: URL, cap: number): Promise<{ url: string; body: Uint8Array }> {
    let url = start;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const response = await this.#once(url, cap);
      const status = response.status;
      if (status >= 300 && status < 400 && response.location) {
        // The GitHub proxy is for GitHub hosts only; viaProxy leaves any other address alone.
        url = this.#address(viaProxy(new URL(response.location, url).href));
        continue;
      }
      if (status !== 200) throw new Error("HTTP " + status);
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
          : (await lookup(host, { all: true })).map((one: LookupAddress) => one.address);
    const usable = this.#options.allowPrivate ? found : found.filter((one) => !isPrivateAddress(one));
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
          headers: { host: url.host, accept: "image/*,text/html;q=0.8", "user-agent": "eta-logo" },
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
          response.on("end", () =>
            resolve({ status: response.statusCode ?? 0, location, body: Buffer.concat(chunks) }),
          );
          response.on("error", () => undefined);
        },
      );
      const stop = setTimeout(() => request.destroy(new Error("no answer")), timeoutMs);
      request.on("timeout", () => request.destroy(new Error("no answer")));
      request.on("error", (error) => reject(error));
      request.on("close", () => clearTimeout(stop));
      request.end();
    });
  }
}
