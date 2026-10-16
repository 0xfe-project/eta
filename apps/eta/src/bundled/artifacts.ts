/**
 * Artifacts: publishing, previewing, sharing (REFACTOR.md §9, P3.2).
 *
 *   POST   /artifacts/v1/upload                                 an agent publishes a ZIP
 *   GET    /api/v1/artifacts                                    what has been published
 *   GET    /api/v1/artifacts/{id}                               one, with its versions
 *   DELETE /api/v1/artifacts/{id}                               remove it
 *   PUT/DELETE /api/v1/artifacts/{id}/versions/{n}/share        share publicly, or revoke
 *   GET    /api/v1/artifacts/{id}/versions/{n}/archive          download the package
 *   GET    /preview/artifacts/{capability}/files/{path…}        private preview
 *   GET    /share/artifacts/{token}/[files/{path…}|archive.zip] public share
 *
 * The security is the part worth reading. A published site is *someone else's HTML* served from
 * our origin, so every file response carries `Content-Security-Policy: sandbox` without
 * `allow-same-origin`: the page runs in an opaque origin, cannot read cookies or storage, and
 * cannot call this host as the user. `Referrer-Policy: no-referrer` because the preview path is
 * itself a credential. `Access-Control-Allow-Origin: *` because an opaque origin's fetches are
 * cross-origin even to the same host — without it a page cannot read its own data files.
 *
 * Private previews cannot use a cookie (a sandboxed iframe sends none, and its fetches have a
 * `null` origin), so they use a one-hour HMAC capability in the path instead. Shares are a separate
 * token: a share link opens the public page, and nothing under `/preview/` can be reached from it.
 */
import type { Context } from "cordis";
import type { AgentStore } from "../agents/store";
import type {
  ArtifactDetail,
  ArtifactRecord,
  ArtifactService,
  VersionRecord,
} from "../artifacts/service";
import type { PluginContext } from "../plugin-api";
import type { TaskStore } from "../tasks/store";
import { NotPublisher, StorageFailed } from "../artifacts/service";
import { toArtifact } from "../artifacts/shapes";
import { contentTypeOf, InvalidArtifact } from "../artifacts/zip";
import { errorResponse } from "../routes";

export interface ArtifactsPluginConfig {
  artifacts: ArtifactService;
  agents: AgentStore;
  tasks: TaskStore;
  /** The most an upload body may be; AXP's gateway limit, kept. */
  maxUploadBytes?: number | undefined;
}

/** A sandboxed page: scripts and forms, but no same-origin — so no cookies, no storage. */
const SANDBOX =
  "sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads";

/** What a site's file is served with, private or public. */
const fileHeaders = (cache: string): Record<string, string> => ({
  "content-security-policy": SANDBOX,
  // The path is a credential: it must not leak through a Referer to a CDN the page loads.
  "referrer-policy": "no-referrer",
  // An opaque origin's fetches are cross-origin even to us.
  "access-control-allow-origin": "*",
  "cache-control": cache,
});

/** The shell page a share link opens: no scripts, and it loads nothing of ours. */
function sharePage(input: {
  title: string;
  version: number;
  base: string;
}): string {
  const escape = (text: string): string =>
    text.replace(/[&<>"']/g, (character) => {
      switch (character) {
        case "&":
          return "&amp;";
        case "<":
          return "&lt;";
        case ">":
          return "&gt;";
        case '"':
          return "&quot;";
        default:
          return "&#39;";
      }
    });
  const title = escape(input.title);
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · 第 ${input.version} 版</title>
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
  <h1>${title} <span style="opacity:.6">· 第 ${input.version} 版</span></h1>
  <a href="${input.base}files/index.html" target="_blank" rel="noopener">新窗口打开</a>
  <a href="${input.base}archive.zip" download>下载</a>
</header>
<iframe src="${input.base}files/index.html" sandbox="${SANDBOX}"></iframe>
</body>
</html>
`;
}

const NOT_FOUND_PAGE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>分享不存在</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>body{margin:0;display:grid;place-items:center;height:100dvh;font:14px system-ui,sans-serif}</style>
</head><body><p>这个分享不存在，或已被撤销。</p></body></html>
`;

export const artifactsPlugin = {
  name: "artifacts",
  inject: ["routes"],
  apply(ctx: Context, config: ArtifactsPluginConfig): void {
    const plugin = ctx as unknown as PluginContext;
    const { artifacts, agents, tasks } = config;
    const maxUpload = config.maxUploadBytes ?? 90 << 20;

    /** The product's shape, from the rows and the addresses they need. */
    const shape = (artifact: ArtifactRecord, versions: VersionRecord[]) =>
      toArtifact(artifact, versions, {
        agentName: (agentId) => agents.get(agentId)?.name,
        taskNumber: (taskId) => tasks.get(taskId)?.number,
        capability: (version) => artifacts.capability(version.id),
        shareOf: (version) => artifacts.shareOf(artifact.id, version.number),
      });

    const detailOf = async (
      id: string,
    ): Promise<Record<string, unknown> | undefined> => {
      const detail: ArtifactDetail | undefined = artifacts.detail(id);
      if (detail === undefined) return undefined;
      return (await shape(detail, detail.versions)) as unknown as Record<
        string,
        unknown
      >;
    };

    plugin.effect(() =>
      plugin.routes.register("GET", "/api/v1/artifacts", async (request) => {
        const params = new URL(request.url).searchParams;
        const groupId = params.get("group_id");
        const taskId = params.get("task_id");
        const list = artifacts.list({
          ...(groupId === null || groupId.length === 0 ? {} : { groupId }),
          ...(taskId === null || taskId.length === 0 ? {} : { taskId }),
        });
        return Response.json({
          artifacts: await Promise.all(
            list.map(
              async (artifact) =>
                (await shape(
                  artifact,
                  artifacts.versions(artifact.id),
                )) as unknown,
            ),
          ),
        });
      }),
    );

    plugin.effect(() =>
      plugin.routes.register(
        "GET",
        "/api/v1/artifacts/:artifact_id",
        async (_request, routeParams) => {
          const shaped = await detailOf(routeParams.artifact_id ?? "");
          return shaped === undefined
            ? errorResponse(
                404,
                "NO_SUCH_ARTIFACT",
                "没有这个产物。",
                crypto.randomUUID(),
              )
            : Response.json(shaped);
        },
      ),
    );

    plugin.effect(() =>
      plugin.routes.register(
        "DELETE",
        "/api/v1/artifacts/:artifact_id",
        async (_request, routeParams) => {
          const removed = await artifacts.remove(routeParams.artifact_id ?? "");
          return removed
            ? new Response(null, { status: 204 })
            : errorResponse(
                404,
                "NO_SUCH_ARTIFACT",
                "没有这个产物。",
                crypto.randomUUID(),
              );
        },
      ),
    );

    plugin.effect(() =>
      plugin.routes.register(
        "PUT",
        "/api/v1/artifacts/:artifact_id/versions/:number/share",
        (_request, routeParams) => {
          const id = routeParams.artifact_id ?? "";
          const number = Number(routeParams.number ?? "");
          const share = artifacts.share(id, number);
          return share === undefined
            ? errorResponse(
                404,
                "NO_SUCH_VERSION",
                "没有这个版本。",
                crypto.randomUUID(),
              )
            : Response.json({
                url: `/share/artifacts/${share.token}/`,
                created_at: share.createdAt,
              });
        },
      ),
    );

    plugin.effect(() =>
      plugin.routes.register(
        "DELETE",
        "/api/v1/artifacts/:artifact_id/versions/:number/share",
        (_request, routeParams) => {
          const id = routeParams.artifact_id ?? "";
          const number = Number(routeParams.number ?? "");
          if (!artifacts.revoke(id, number)) {
            return errorResponse(
              404,
              "NO_SHARE",
              "这个版本没有分享。",
              crypto.randomUUID(),
            );
          }
          return new Response(null, { status: 204 });
        },
      ),
    );

    plugin.effect(() =>
      plugin.routes.register(
        "GET",
        "/api/v1/artifacts/:artifact_id/versions/:number/archive",
        async (_request, routeParams) => {
          const id = routeParams.artifact_id ?? "";
          const number = Number(routeParams.number ?? "");
          const archive = await artifacts.archive(id, number);
          if (archive === undefined) {
            return errorResponse(
              404,
              "NO_SUCH_VERSION",
              "没有这个版本。",
              crypto.randomUUID(),
            );
          }
          return new Response(archive, {
            headers: {
              "content-type": "application/zip",
              "content-disposition": `attachment; filename="${id}-${number}.zip"`,
            },
          });
        },
      ),
    );

    /**
     * Publish: the ZIP in the body, `title` (and optionally `task`, `artifact`) in the query.
     *
     * One entry for the agent tool and (P4) the remote computer; who is publishing is a
     * parameter, and only that publisher may add a version.
     */
    plugin.effect(() =>
      plugin.routes.register(
        "POST",
        "/artifacts/v1/upload",
        async (request) => {
          const params = new URL(request.url).searchParams;
          const title = (params.get("title") ?? "").trim();
          if (title.length === 0) {
            return errorResponse(
              422,
              "VALIDATION_ERROR",
              "产物需要标题。",
              crypto.randomUUID(),
            );
          }
          const declared = Number(request.headers.get("content-length") ?? "");
          if (Number.isFinite(declared) && declared > maxUpload) {
            return errorResponse(
              413,
              "TOO_LARGE",
              `产物不能超过 ${maxUpload >> 20} MiB。`,
              crypto.randomUUID(),
            );
          }
          const archive = new Uint8Array(await request.arrayBuffer());
          if (archive.byteLength > maxUpload) {
            return errorResponse(
              413,
              "TOO_LARGE",
              `产物不能超过 ${maxUpload >> 20} MiB。`,
              crypto.randomUUID(),
            );
          }
          const taskId = params.get("task") ?? undefined;
          const groupId = params.get("group") ?? undefined;
          const artifactId = params.get("artifact") ?? undefined;
          try {
            const published = await artifacts.publish({
              title,
              archive,
              ...(artifactId === undefined || artifactId.length === 0
                ? {}
                : { artifactId }),
              ...(taskId === undefined || taskId.length === 0
                ? {}
                : { taskId }),
              ...(groupId === undefined || groupId.length === 0
                ? {}
                : { groupId }),
              ...(params.get("agent") === null
                ? {}
                : { publisherAgent: params.get("agent")! }),
            });
            // A version published for a task is part of that task's story.
            if (published.artifact.taskId !== undefined) {
              tasks.record({
                taskId: published.artifact.taskId,
                kind: "artifact",
                actor:
                  published.artifact.publisherAgent === undefined
                    ? "user"
                    : "agent",
                ...(published.artifact.publisherAgent === undefined
                  ? {}
                  : { actorAgent: published.artifact.publisherAgent }),
                data: {
                  artifact_id: published.artifact.id,
                  title: published.artifact.title,
                  version: published.version.number,
                },
              });
            }
            const shaped = await detailOf(published.artifact.id);
            return Response.json(shaped, { status: 201 });
          } catch (error) {
            if (error instanceof InvalidArtifact) {
              return errorResponse(
                422,
                "INVALID_ARTIFACT",
                error.message,
                crypto.randomUUID(),
              );
            }
            if (error instanceof NotPublisher) {
              return errorResponse(
                403,
                "NOT_PUBLISHER",
                error.message,
                crypto.randomUUID(),
              );
            }
            if (error instanceof StorageFailed) {
              return errorResponse(
                424,
                "STORAGE_FAILED",
                error.message,
                crypto.randomUUID(),
              );
            }
            throw error;
          }
        },
      ),
    );

    /** A private preview: a capability in the path, and the file it names. */
    plugin.effect(() =>
      plugin.routes.register(
        "GET",
        "/preview/artifacts/:capability/files/*path",
        async (_request, routeParams) => {
          const opened = await artifacts.byCapability(
            routeParams.capability ?? "",
          );
          if (opened === undefined) {
            return errorResponse(
              404,
              "NO_SUCH_PREVIEW",
              "预览已失效。",
              crypto.randomUUID(),
            );
          }
          const name = routeParams.path ?? "";
          const bytes = await artifacts.file(
            opened.artifact.id,
            opened.version.number,
            name,
          );
          if (bytes === undefined) {
            return errorResponse(
              404,
              "NO_SUCH_FILE",
              "没有这个文件。",
              crypto.randomUUID(),
            );
          }
          return new Response(bytes, {
            headers: {
              "content-type": contentTypeOf(name),
              // Previews are private and short-lived, but caching them for a while keeps a
              // page's own assets from being refetched on every navigation.
              ...fileHeaders("private, max-age=3600"),
            },
          });
        },
      ),
    );

    plugin.effect(() =>
      plugin.routes.register(
        "GET",
        "/share/artifacts/:token",
        (_request, routeParams) => {
          const opened = artifacts.byShare(routeParams.token ?? "");
          if (opened === undefined) {
            return new Response(NOT_FOUND_PAGE, {
              status: 404,
              headers: {
                "content-type": "text/html; charset=utf-8",
                "content-security-policy": "default-src 'none'",
                "referrer-policy": "no-referrer",
                "cache-control": "no-store",
              },
            });
          }
          return new Response(
            sharePage({
              title: opened.artifact.title,
              version: opened.version.number,
              base: `/share/artifacts/${routeParams.token}/`,
            }),
            {
              headers: {
                "content-type": "text/html; charset=utf-8",
                // The shell page runs nothing and loads nothing of ours.
                "content-security-policy":
                  "default-src 'none'; style-src 'unsafe-inline'",
                "referrer-policy": "no-referrer",
                // Cloudflare and friends cache by extension; a revoked share must stop working.
                "cache-control": "no-store",
              },
            },
          );
        },
      ),
    );

    plugin.effect(() =>
      plugin.routes.register(
        "GET",
        "/share/artifacts/:token/files/*path",
        async (_request, routeParams) => {
          const opened = artifacts.byShare(routeParams.token ?? "");
          if (opened === undefined) {
            return errorResponse(
              404,
              "NO_SUCH_SHARE",
              "这个分享不存在。",
              crypto.randomUUID(),
            );
          }
          const name = routeParams.path ?? "";
          const bytes = await artifacts.file(
            opened.artifact.id,
            opened.version.number,
            name,
          );
          if (bytes === undefined) {
            return errorResponse(
              404,
              "NO_SUCH_FILE",
              "没有这个文件。",
              crypto.randomUUID(),
            );
          }
          return new Response(bytes, {
            headers: {
              "content-type": contentTypeOf(name),
              ...fileHeaders("no-store"),
            },
          });
        },
      ),
    );

    plugin.effect(() =>
      plugin.routes.register(
        "GET",
        "/share/artifacts/:token/archive.zip",
        async (_request, routeParams) => {
          const opened = artifacts.byShare(routeParams.token ?? "");
          if (opened === undefined) {
            return errorResponse(
              404,
              "NO_SUCH_SHARE",
              "这个分享不存在。",
              crypto.randomUUID(),
            );
          }
          const archive = await artifacts.archive(
            opened.artifact.id,
            opened.version.number,
          );
          if (archive === undefined) {
            return errorResponse(
              404,
              "NO_SUCH_FILE",
              "没有这个版本。",
              crypto.randomUUID(),
            );
          }
          // A header value is ASCII: a title with Chinese in it goes in `filename*` (RFC 5987),
          // with a plain fallback for clients that do not read it.
          const encoded = encodeURIComponent(`${opened.artifact.title}.zip`);
          return new Response(archive, {
            headers: {
              "content-type": "application/zip",
              "content-disposition": `attachment; filename="artifact.zip"; filename*=UTF-8''${encoded}`,
              "cache-control": "no-store",
            },
          });
        },
      ),
    );
  },
};
