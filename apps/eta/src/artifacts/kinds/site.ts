/**
 * The `site` kind: a static site, served file by file.
 *
 * With `fallback` it is a single-page app: an address with no file behind it is a route of the
 * app, so a navigation there gets `index.html`. Only a navigation does: a missing script or image
 * stays a 404, because an HTML page in its place is a white screen nobody can trace.
 */
import { stat } from "node:fs/promises";
import { ArtifactError } from "../files";
import { kind } from "./kind";

interface SiteManifest {
  fallback?: "index.html";
}

const notFound = (): Response =>
  new Response("not found", {
    status: 404,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/** What an agent may ask of a site, rebuilt: nothing else in the options reaches the manifest. */
function manifestOf(options: unknown): SiteManifest {
  const fallback = (options as { fallback?: unknown } | undefined)?.fallback;
  if (fallback === undefined) return {};
  if (fallback === "index.html") return { fallback };
  throw new ArtifactError(
    `a site can only fall back to index.html, not ${JSON.stringify(fallback)}`,
  );
}

/** The site must have its page at the root, and the common mistake is one directory too high. */
function checkIndex(names: readonly string[]): void {
  if (names.includes("index.html")) return;
  for (const name of names) {
    const parts = name.split("/");
    if (parts.length === 2 && parts[1] === "index.html") {
      throw new ArtifactError(
        `index.html must be at the root of the site, and it is in ${parts[0]}/: publish ${parts[0]} itself`,
      );
    }
  }
  throw new ArtifactError("the root of the site has no index.html");
}

/**
 * The first address in a tag that starts at the root of the host (`/assets/app.js`, and not
 * `//cdn.example/app.js`). The site lives under a path of its own, so that address is outside it.
 */
function rootPath(html: string): string | undefined {
  const page = html.replaceAll(/<!--[\s\S]*?-->/g, "");
  return /<[a-z][^>]*?\s(?:src|href)\s*=\s*["']?(\/(?!\/)[^"'\s>]*)/i.exec(
    page,
  )?.[1];
}

/** Refuse the mistake that shows up only as a white screen once it is published. */
function checkRelative(index: Uint8Array): void {
  const found = rootPath(new TextDecoder().decode(index));
  if (found === undefined) return;
  throw new ArtifactError(
    `index.html loads ${found} from the root path, which is outside the site: use relative paths (in Vite, set base: './') and build again`,
  );
}

const HEAD = /<head(\s[^>]*)?>/i;
const DOCUMENT_START = /^\s*(<!doctype[^>]*>)?/i;

/**
 * `index.html` as the answer for a deep address. Its relative addresses would resolve against that
 * address (`users/assets/app.js`), so a `<base>` points them back at the site's root. It is
 * relative too, which keeps the kind from knowing where the site is served.
 */
async function pageAt(path: string, name: string): Promise<Response> {
  const html = await Bun.file(name).text();
  const up = "../".repeat(path.split("/").length - 1);
  const head = HEAD.test(html) ? HEAD : DOCUMENT_START;
  return new Response(
    up === "" ? html : html.replace(head, `$&<base href="${up}">`),
    { headers: { "content-type": "text/html;charset=utf-8" } },
  );
}

export const site = kind<SiteManifest>({
  id: "site",
  viewer: "iframe",
  prepare(files, options) {
    checkIndex(files.map((file) => file.name));
    const manifest = manifestOf(options);
    if (manifest.fallback !== undefined)
      checkRelative(files.find((file) => file.name === "index.html")!.bytes);
    return manifest;
  },
  // A router reads the address, and `index.html` is not one of its routes.
  entry: (manifest) => (manifest.fallback === undefined ? "index.html" : ""),
  async respond({ http, path, file }, _version, manifest) {
    // A directory (or nothing) is its index.
    const name = path === "" || path.endsWith("/") ? `${path}index.html` : path;
    const found = file(name);
    if (found !== undefined && (await isFile(found))) {
      const body = Bun.file(found);
      return new Response(body, { headers: { "content-type": body.type } });
    }
    const navigates =
      http.headers.get("accept")?.includes("text/html") === true ||
      !/\.[^/]*$/.test(path);
    const index =
      manifest.fallback === undefined ? undefined : file("index.html");
    return index !== undefined && navigates ? pageAt(path, index) : notFound();
  },
});
