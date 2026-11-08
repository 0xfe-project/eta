/**
 * GitHub's release API, as far as the install scripts use it, served from the test process.
 *
 * `<api>/releases/latest` and `<api>/releases/tags/<tag>` answer with a release, and
 * `<api>/releases?per_page=100` with the list of every release in the order given; the list asked
 * for with any other query is a 400. An asset's address on the API redirects to a signed address,
 * which refuses a request that carries `Authorization` with a 400, as GitHub's does. Every request
 * is recorded with the headers the scripts are bound to send, with all of its headers in
 * `headers`, and with its path and query in `urls`.
 */

const API_PATH = "/repos/o/r";

interface FakeRelease {
  tag: string;
  draft?: boolean;
  /** What the release says it is; a tag with a `-` in it when not given. */
  prerelease?: boolean;
  /** The release notes (`body`); text shaped like a parser's fields when not given. */
  notes?: string;
  /** Asset name to its bytes. */
  assets: Record<string, Uint8Array | string>;
}

export interface FakeGitHubOptions {
  releases: FakeRelease[];
  /** The tag `releases/latest` answers with; none means 404. */
  latest?: string;
  /** Answers before the release API does, for a path it wants to break. */
  override?: (path: string, request: Request) => Response | undefined;
  /** Write the release JSON over many lines, with indentation. */
  pretty?: boolean;
  /** Where the release JSON says the assets are; this server's own origin when not given. */
  assetOrigin?: string;
  /** Redirect `releases/latest`, `releases/tags/*` and the list to the same path under `/moved`. */
  redirectRelease?: boolean;
}

export interface RecordedRequest {
  path: string;
  authorization: string | null;
  accept: string | null;
  userAgent: string | null;
}

export interface FakeGitHub {
  /** The repository on the API: what `--repo` is given. */
  api: string;
  origin: string;
  requests: RecordedRequest[];
  /** Every header of each request, in the order of `requests`. */
  headers: Headers[];
  /** The path and query of each request, in the order of `requests`. */
  urls: string[];
  stop: () => Promise<void>;
}

/**
 * The body is the part of a release anyone may write, so it carries text shaped like the fields
 * a parser looks for, a release with a high host tag among them. Each asset also has an uploader
 * whose own `url` is not the asset's.
 */
function releaseObject(
  origin: string,
  release: FakeRelease,
  assetOrigin: string,
): object {
  const decoy = Object.keys(release.assets)
    .map((name) => `"name":"${name}","url":"${origin}/decoy/${name}"`)
    .join(", ");
  const body = {
    url: `${origin}${API_PATH}/releases/1`,
    assets_url: `${origin}${API_PATH}/releases/1/assets`,
    tag_name: release.tag,
    name: `eta ${release.tag}`,
    draft: release.draft ?? false,
    prerelease: release.prerelease ?? release.tag.includes("-"),
    author: { login: "someone", url: `${origin}/users/someone` },
    body:
      release.notes ??
      `Notes {"assets":[{${decoy}}]} \\ "quoted" ] } [ {\n\ttabs, 注记 and\r\nlines },{"tag_name":"v9.9.9","draft":false,"prerelease":false}`,
    assets: Object.keys(release.assets).map((name, index) => ({
      url: `${assetOrigin}${API_PATH}/releases/assets/${release.tag}/${name}`,
      id: index + 1,
      name,
      label: "",
      uploader: { login: "someone", url: `${origin}/users/uploader/${name}` },
      content_type: "application/octet-stream",
      size: 1,
      browser_download_url: `${origin}/browser/${name}`,
    })),
  };
  return body;
}

const jsonText = (value: unknown, pretty: boolean): string =>
  pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value);

export function startFakeGitHub(options: FakeGitHubOptions): FakeGitHub {
  const requests: RecordedRequest[] = [];
  const headers: Headers[] = [];
  const urls: string[] = [];
  const byTag = new Map(
    options.releases.map((release) => [release.tag, release]),
  );
  const jsonResponse = (value: unknown): Response =>
    new Response(jsonText(value, options.pretty ?? false), {
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  const json = (origin: string, release: FakeRelease): Response =>
    jsonResponse(releaseObject(origin, release, options.assetOrigin ?? origin));

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout: 0,
    async fetch(request) {
      const { origin, pathname: requested, search } = new URL(request.url);
      headers.push(request.headers);
      urls.push(`${requested}${search}`);
      requests.push({
        path: requested,
        authorization: request.headers.get("authorization"),
        accept: request.headers.get("accept"),
        userAgent: request.headers.get("user-agent"),
      });
      const overridden = options.override?.(requested, request);
      if (overridden !== undefined) return overridden;

      const isRelease =
        requested.startsWith(`${API_PATH}/releases/latest`) ||
        requested.startsWith(`${API_PATH}/releases/tags/`) ||
        requested === `${API_PATH}/releases`;
      if (options.redirectRelease === true && isRelease)
        return new Response(null, {
          status: 302,
          headers: { location: `${origin}/moved${requested}${search}` },
        });
      const pathname = requested.startsWith("/moved/")
        ? requested.slice("/moved".length)
        : requested;

      if (pathname.startsWith("/signed/")) {
        if (request.headers.has("authorization"))
          return new Response("a signed address refuses a credential", {
            status: 400,
          });
        const [tag, name] = decodeURIComponent(pathname.slice(8)).split("/");
        const bytes = byTag.get(tag ?? "")?.assets[name ?? ""];
        return bytes === undefined
          ? new Response("Not Found", { status: 404 })
          : new Response(bytes);
      }
      if (pathname === `${API_PATH}/releases`) {
        return search === "?per_page=100"
          ? jsonResponse(
              options.releases.map((release) =>
                releaseObject(origin, release, options.assetOrigin ?? origin),
              ),
            )
          : new Response(`unexpected query: ${search}`, { status: 400 });
      }
      if (pathname === `${API_PATH}/releases/latest`) {
        const release = byTag.get(options.latest ?? "");
        return release === undefined
          ? new Response("Not Found", { status: 404 })
          : json(origin, release);
      }
      const tag = new RegExp(`^${API_PATH}/releases/tags/(.+)$`).exec(
        pathname,
      )?.[1];
      if (tag !== undefined) {
        const release = byTag.get(decodeURIComponent(tag));
        return release === undefined
          ? new Response("Not Found", { status: 404 })
          : json(origin, release);
      }
      const asset = new RegExp(`^${API_PATH}/releases/assets/(.+)$`).exec(
        pathname,
      )?.[1];
      if (asset !== undefined)
        return new Response(null, {
          status: 302,
          headers: { location: `${origin}/signed/${asset}` },
        });
      return new Response("Not Found", { status: 404 });
    },
  });
  const origin = `http://127.0.0.1:${server.port}`;
  return {
    api: `${origin}${API_PATH}`,
    origin,
    requests,
    headers,
    urls,
    stop: async () => {
      await server.stop(true);
    },
  };
}
