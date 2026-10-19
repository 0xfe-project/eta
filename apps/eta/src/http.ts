/**
 * Everything on the port that is not the socket: the built web, `/up` and `/version`.
 *
 * The web is a directory — one `index.html` and hashed files under `assets/` — and the routes
 * live in the browser, so a path that is no file falls back to `index.html` (`/workspace/tasks`
 * is a page, not a missing file). The one path that never reaches this file is `/ws`: the
 * transport upgrades it before asking the host for anything.
 */
import { readFile, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

/** The immutable names the web build writes under `assets/` are the only ones safe to cache for good. */
const IMMUTABLE = "public, max-age=31536000, immutable";

/**
 * The host's HTTP side. With no `webDir` the host serves no page: `/up` still answers (a
 * supervisor asks it) and everything else is the transport's 404.
 */
export function createWebRoutes(
  webDir: string | undefined,
): (request: Request) => Promise<Response | undefined> {
  const root = webDir === undefined ? undefined : resolve(webDir);

  async function isFile(path: string): Promise<boolean> {
    try {
      return (await stat(path)).isFile();
    } catch {
      return false;
    }
  }

  return async (request) => {
    const { pathname } = new URL(request.url);
    if (pathname === "/up") return new Response("ok");
    if (root === undefined) return undefined;

    if (pathname === "/version") {
      // The id of the bundle on disk, read per request: a rebuild under a running host is
      // what a tab's "an update is waiting" check has to see. The web serves the same id from
      // its own dev server, so a tab compares like with like (apps/web/src/lib/update.ts).
      const id = await readFile(join(root, "BUILD"), "utf8").catch(
        () => undefined,
      );
      if (id === undefined || id.trim() === "") return undefined;
      return new Response(id.trim(), {
        headers: { "cache-control": "no-store" },
      });
    }

    if (request.method !== "GET" && request.method !== "HEAD") return undefined;
    let decoded: string;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      return new Response("bad request", { status: 400 });
    }
    // The URL parser has already folded `..` away; a decoded `%2e%2e` or a backslash is the
    // rest of the way out of the directory, so the resolved path has to stay inside it.
    const path = resolve(root, `.${decoded.replaceAll("\\", "/")}`);
    if (path !== root && !path.startsWith(root + sep)) return undefined;

    if (await isFile(path)) {
      const assets = path.startsWith(join(root, "assets") + sep);
      return new Response(Bun.file(path), {
        headers: { "cache-control": assets ? IMMUTABLE : "no-cache" },
      });
    }
    // A missing file under assets/ is a missing file: answering it with the page would hand
    // the browser HTML where it asked for a script.
    if (decoded.startsWith("/assets/")) return undefined;
    const index = join(root, "index.html");
    if (!(await isFile(index))) return undefined;
    return new Response(Bun.file(index), {
      headers: { "cache-control": "no-cache" },
    });
  };
}
