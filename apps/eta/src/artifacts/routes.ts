/**
 * The artifacts over HTTP, next to the socket:
 *
 *   GET /preview/<capability>/files/<path>   the app's own sandboxed iframe
 *   GET /share/<token>/                      a public page around it (title, download)
 *   GET /share/<token>/files/<path>          the version, public
 *   GET /share/<token>/archive.zip           its ZIP, public
 *   GET /artifacts/<id>/<version>/archive.zip   the ZIP for the app, behind the normal access
 *
 * These routes decide who may open a version; its kind (`kinds/`) decides what the answer is. The
 * limits on that answer are here, set after the kind has answered and over whatever it said, so
 * neither a kind nor its manifest can loosen them (`seal`).
 *
 * A published page is someone else's HTML served from our origin, so everything under `files/`
 * carries `Content-Security-Policy: sandbox` without `allow-same-origin`: the page runs in an opaque
 * origin, cannot read cookies or storage and cannot call this host as the user, whether it is in
 * an iframe or opened on its own. `Referrer-Policy: no-referrer` because the address is itself a
 * credential. `Access-Control-Allow-Origin: *` because an opaque origin's requests are cross-origin
 * even to the host that served it, and without it a page cannot read its own data files.
 *
 * Everything under `/preview/` and `/share/` answers here, found or not (a missing share must not
 * fall through to the web's page), and says nothing about *why* a capability or token is no good.
 */
import type { ArtifactViewer } from "@eta/client-contracts";
import type { ArtifactService } from "./service";
import type { VersionRecord } from "./store";

const SANDBOX =
  "sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads";

const escapeHtml = (value: string): string =>
  value.replaceAll(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const notFound = (): Response =>
  new Response("not found", {
    status: 404,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    },
  });

/**
 * What a kind answered, in its sandbox. How long it may be kept is here too: a share can be taken
 * back and a capability runs out, whatever the kind thinks of its content. A cookie would land on
 * the host's own origin, so none gets out.
 */
function seal(response: Response, cache: string): Response {
  const { headers } = response;
  headers.set("content-security-policy", SANDBOX);
  headers.set("referrer-policy", "no-referrer");
  headers.set("access-control-allow-origin", "*");
  headers.set("x-content-type-options", "nosniff");
  headers.set("cache-control", response.ok ? cache : "no-store");
  headers.delete("set-cookie");
  return response;
}

function zipResponse(path: string, title: string, version: number): Response {
  const name = `${title}-v${version}.zip`;
  return new Response(Bun.file(path), {
    headers: {
      "content-type": "application/zip",
      // A header is ASCII: a title with other letters goes in `filename*`, with a plain fallback.
      "content-disposition": `attachment; filename="artifact.zip"; filename*=UTF-8''${encodeURIComponent(name)}`,
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    },
  });
}

/** The shell of a public share: no script, and it loads nothing of ours but the version. */
function shell(
  title: string,
  version: number,
  viewer: ArtifactViewer,
  entry: string,
): string {
  const safe = escapeHtml(title);
  const framed = viewer === "iframe";
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${safe} · v${version}</title>
<style>
  :root { color-scheme: light dark }
  body { margin: 0; font: 14px/1.5 system-ui, sans-serif }
  header { display: flex; align-items: center; gap: 12px; padding: 10px 14px; border-bottom: 1px solid color-mix(in srgb, currentColor 15%, transparent) }
  h1 { font-size: 14px; font-weight: 600; margin: 0; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap }
  a { color: inherit }
  iframe { display: block; width: 100%; height: calc(100dvh - 45px); border: 0 }
</style>
</head>
<body>
<header>
  <h1>${safe} <span style="opacity:.6">· v${version}</span></h1>
  ${framed ? `<a href="${entry}" target="_blank" rel="noopener">Open</a>` : ""}
  <a href="archive.zip" download>Download</a>
</header>
${framed ? `<iframe src="${entry}" sandbox="${SANDBOX}"></iframe>` : ""}
</body>
</html>
`;
}

/** The decoded path after a prefix, or nothing for one that is not a clean path. */
function relativePath(segments: string[]): string | undefined {
  try {
    const parts = segments.map(decodeURIComponent);
    if (parts.some((p) => p === ".." || p === "." || /[\\\0]/.test(p)))
      return undefined;
    return parts.join("/");
  } catch {
    return undefined;
  }
}

/** The routes, as the host's `fetch` takes them: a response, or nothing for a path that is not theirs. */
export function createArtifactRoutes(
  artifacts: ArtifactService,
): (request: Request) => Promise<Response | undefined> {
  /** A request for a page of a version somebody may open: the kind's to answer, inside the seal. */
  const page = async (
    request: Request,
    version: VersionRecord,
    segments: string[],
    cache: string,
  ): Promise<Response> => {
    const path = relativePath(segments);
    const kind = artifacts.kindOf(version);
    if (path === undefined || kind === undefined) return notFound();
    const response = await kind.respond(
      {
        http: request,
        path,
        file: (name) => artifacts.fileOf(version, name),
      },
      version,
      JSON.parse(version.manifest),
    );
    return seal(response, cache);
  };

  return async (request) => {
    const { pathname } = new URL(request.url);
    const parts = pathname.split("/");
    // ["", area, key, ...rest]
    const area = parts[1];
    const isCapabilityArea = area === "preview" || area === "share";
    const isDownload = area === "artifacts" && parts.length === 5;
    if (!isCapabilityArea && !isDownload) return undefined;
    if (request.method !== "GET" && request.method !== "HEAD")
      return new Response("method not allowed", {
        status: 405,
        headers: { allow: "GET, HEAD" },
      });
    const key = parts[2] ?? "";

    if (area === "preview") {
      if (parts[3] !== "files") return notFound();
      const opened = artifacts.byCapability(key);
      if (opened === undefined) return notFound();
      return page(
        request,
        opened.version,
        parts.slice(4),
        "private, max-age=3600",
      );
    }

    if (area === "share") {
      const opened = artifacts.byShare(key);
      if (opened === undefined) return notFound();
      const rest = parts.slice(3);
      if (rest.length === 0 || (rest.length === 1 && rest[0] === "")) {
        return new Response(
          shell(
            opened.artifact.title,
            opened.version.number,
            artifacts.kindOf(opened.version)?.viewer ?? "download",
            artifacts.shareEntry(key, opened.version),
          ),
          {
            headers: {
              "content-type": "text/html; charset=utf-8",
              "content-security-policy":
                "default-src 'none'; style-src 'unsafe-inline'; frame-src 'self'",
              "referrer-policy": "no-referrer",
              // A proxy that caches by extension must not keep a share that was taken back.
              "cache-control": "no-store",
            },
          },
        );
      }
      if (rest.length === 1 && rest[0] === "archive.zip") {
        return zipResponse(
          artifacts.archiveOf(opened.version),
          opened.artifact.title,
          opened.version.number,
        );
      }
      if (rest[0] !== "files") return notFound();
      return page(request, opened.version, rest.slice(1), "no-store");
    }

    // /artifacts/<id>/<version>/archive.zip: the app's own, behind the access check upstream.
    const found =
      parts[4] === "archive.zip"
        ? artifacts.versionOf(key, Number(parts[3]))
        : undefined;
    if (found === undefined) return notFound();
    return zipResponse(
      artifacts.archiveOf(found.version),
      found.artifact.title,
      found.version.number,
    );
  };
}
