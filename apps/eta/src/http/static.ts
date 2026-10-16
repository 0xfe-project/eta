/**
 * The host serving the web (REFACTOR.md §9, P3.11).
 *
 * The SPA's built bundle is a directory of files and one `index.html`; this is the piece of the old
 * gateway's job that has to live somewhere (静态资源、`/up`、`/version` → 进程自己服务). Two rules
 * make it a web server rather than a file server:
 *
 * - A path nobody matches falls back to `index.html`, because the routes live in the browser —
 *   `/workspace/tasks` is a page, not a missing file.
 * - A path under one of the host's own prefixes is *not* the SPA's, and answers 404 as JSON: an API
 *   call that guessed a wrong URL should hear "no such route", not the app's HTML.
 */
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";

/** The prefixes this host answers itself; anything under them is never a page. */
const HOST_PREFIXES = [
  "/api",
  "/events",
  "/artifacts",
  "/preview",
  "/share",
  "/remote",
  "/sessions",
  "/agents",
  "/groups",
  "/usage",
  "/health",
  "/host",
  "/up",
  "/version",
];

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json",
  ".webmanifest": "application/manifest+json",
  ".wasm": "application/wasm",
};

export class StaticWeb {
  readonly root: string | undefined;

  constructor(root: string | undefined) {
    this.root = root === undefined ? undefined : resolve(root);
  }

  /** Whether there is a bundle to serve at all. */
  get serving(): boolean {
    return this.root !== undefined;
  }

  /**
   * One request, answered from the bundle.
   *
   * `undefined` means "this host does not serve the web" (the caller answers 404), so a host run
   * without a bundle behaves exactly as before the SPA existed.
   */
  async serve(pathname: string): Promise<Response | undefined> {
    if (this.root === undefined) return undefined;
    // The host's own prefixes are APIs, never pages — a wrong guess there is a wrong guess.
    if (
      HOST_PREFIXES.some(
        (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
      )
    ) {
      return undefined;
    }
    const index = await this.#file("index.html");
    if (index === undefined) return undefined;

    const name = this.#inside(pathname);
    const file = await this.#file(name);
    if (file !== undefined) {
      return new Response(file.bytes, {
        headers: {
          "content-type": file.type,
          // The bundle is content-addressed (hashed names); a copy in a cache is a copy
          // that is still right. The entry document is the one thing that must be re-read,
          // whichever path asked for it (`/` and `/index.html` are both it).
          "cache-control":
            name === "index.html"
              ? "no-cache"
              : "public, max-age=31536000, immutable",
        },
      });
    }
    // The SPA's route, or a file that is not there: the app decides, which is what a deep link
    // into `/workspace/...` needs.
    return new Response(index.bytes, {
      headers: { "content-type": index.type, "cache-control": "no-cache" },
    });
  }

  /** A file from the bundle, refusing anything that tries to leave it. */
  async #file(
    relative: string,
  ): Promise<{ bytes: Uint8Array; type: string } | undefined> {
    if (this.root === undefined) return undefined;
    const target = this.#inside(relative);
    const full = join(this.root, target);
    try {
      const info = await stat(full);
      if (!info.isFile()) return undefined;
      const bytes = new Uint8Array(await readFile(full));
      return {
        bytes,
        type:
          CONTENT_TYPES[extname(full).toLowerCase()] ??
          "application/octet-stream",
      };
    } catch {
      return undefined;
    }
  }

  /** A clean path inside the bundle: no `..`, no absolute escape, no empty request. */
  #inside(pathname: string): string {
    const cleaned = normalize(decodeURIComponent(pathname)).replaceAll(
      "\\",
      "/",
    );
    const relative = cleaned.startsWith("/") ? cleaned.slice(1) : cleaned;
    const parts = relative
      .split("/")
      .filter((part) => part.length > 0 && part !== ".");
    if (parts.includes("..")) return "index.html";
    const joined = parts.join("/");
    return joined.length === 0 ? "index.html" : joined;
  }
}

