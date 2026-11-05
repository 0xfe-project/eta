/**
 * Everything on the port that is not the socket: the built web, `/up` and `/version`.
 *
 * The web is one `index.html` and hashed files under `assets/`, in a directory or inside a
 * compiled host, and the routes live in the browser, so a path that is no file falls back to
 * `index.html` (`/workspace/tasks` is a page, not a missing file). The one path that never reaches
 * this file is `/ws`: the transport upgrades it before asking the host for anything.
 */
import type { BunFile } from "bun";
import { stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { embeddedFiles } from "./resources";

/** The immutable names the web build writes under `assets/` are the only ones safe to cache for good. */
const IMMUTABLE = "public, max-age=31536000, immutable";

/** The page's files, each at a path under `root`. */
interface WebFiles {
  root: string;
  file: (path: string) => Promise<BunFile | undefined>;
}

function directory(root: string): WebFiles {
  return {
    root,
    file: async (path) => {
      try {
        return (await stat(path)).isFile() ? Bun.file(path) : undefined;
      } catch {
        return undefined;
      }
    },
  };
}

/**
 * The page inside a compiled host. Its root is a path nothing reads, there for the same checks as
 * a directory's. A file inside an executable has lost its name, so it gets the type of its own.
 */
function embedded(files: Readonly<Record<string, string>>): WebFiles {
  const root = resolve("/web");
  return {
    root,
    file: async (path) => {
      const inside = files[relative(root, path).split(sep).join("/")];
      return inside === undefined
        ? undefined
        : Bun.file(inside, { type: Bun.file(path).type });
    },
  };
}

/**
 * The host's HTTP side: the page in `webDir`, or the one a compiled host carries. With neither the
 * host serves no page: `/up` still answers (a supervisor asks it) and everything else is the
 * transport's 404.
 */
export function createWebRoutes(
  webDir: string | undefined,
): (request: Request) => Promise<Response | undefined> {
  const carried = embeddedFiles("web");
  const web =
    webDir !== undefined
      ? directory(resolve(webDir))
      : carried === undefined
        ? undefined
        : embedded(carried);

  return async (request) => {
    const { pathname } = new URL(request.url);
    if (pathname === "/up") return new Response("ok");
    if (web === undefined) return undefined;
    const { root } = web;

    if (pathname === "/version") {
      // The id of the bundle on disk, read per request: a rebuild under a running host is
      // what a tab's "an update is waiting" check has to see. The web serves the same id from
      // its own dev server, so a tab compares like with like (apps/web/src/lib/update.ts).
      const id = await (await web.file(join(root, "BUILD")))
        ?.text()
        .catch(() => undefined);
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

    const file = await web.file(path);
    if (file !== undefined) {
      const assets = path.startsWith(join(root, "assets") + sep);
      return new Response(file, {
        headers: { "cache-control": assets ? IMMUTABLE : "no-cache" },
      });
    }
    // A missing file under assets/ is a missing file: answering it with the page would hand
    // the browser HTML where it asked for a script.
    if (decoded.startsWith("/assets/")) return undefined;
    const index = await web.file(join(root, "index.html"));
    if (index === undefined) return undefined;
    return new Response(index, {
      headers: { "cache-control": "no-cache" },
    });
  };
}
