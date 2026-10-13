package api

import (
	"context"
	"encoding/json"
	"html/template"
	"io"
	"mime"
	"net/http"
	"strconv"
	"strings"

	"github.com/akarachen/axp/apps/control-plane/internal/artifacts"
	"github.com/akarachen/axp/apps/control-plane/internal/objects"
	"github.com/akarachen/axp/packages/service-go/apierr"
	"github.com/akarachen/axp/packages/service-go/httpapi"
	"github.com/akarachen/axp/packages/service-go/pg"
	"github.com/danielgtaylor/huma/v2"
	"github.com/go-chi/chi/v5"
)

// Artifacts (docs/architecture/artifacts.md). One upload, two callers: AXP
// agents through the runtime gateway (/artifacts/v1/upload on the internal
// API, the artifacts plugin) and remote computers' agents with their token
// (/remote/v1/artifacts). The browser manages them under /api/v1/artifacts
// and shows their files from /preview/artifacts (a capability per version,
// for an hour) and, once shared, /share/artifacts (a token per share).

// sandbox is every artifact file's policy: scripts run, but in an opaque
// origin even when opened on its own, so a page never acts as AXP.
const sandbox = "sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads"

func contentHeaders(h http.Header, cache string) {
	h.Set("Content-Security-Policy", sandbox)
	// The path is the capability: never pass it on to other sites.
	h.Set("Referrer-Policy", "no-referrer")
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("X-Robots-Tag", "noindex")
	h.Set("Cache-Control", cache)
	// The site's own fetch() and module scripts come from its opaque origin,
	// so they are cross-origin requests even here. Never with credentials:
	// the path is all a reader needs.
	h.Set("Access-Control-Allow-Origin", "*")
}

// Cache: a share can be revoked at any time, so no copy may outlive it
// (Cloudflare caches static files by extension unless told not to); a
// preview capability names one immutable version for an hour.
const (
	shareCache   = "no-store"
	previewCache = "private, max-age=3600"
)

func serveObject(w http.ResponseWriter, r *http.Request, rc io.ReadCloser, info objects.Info) {
	defer rc.Close()
	w.Header().Set("Content-Type", info.ContentType)
	w.Header().Set("Content-Length", strconv.FormatInt(info.Size, 10))
	if r.Method == http.MethodHead {
		return
	}
	_, _ = io.Copy(w, rc)
}

func serveFile(d *Deps, w http.ResponseWriter, r *http.Request, v *artifacts.Served, cache string) {
	rc, info, err := d.Artifacts.File(r.Context(), v, chi.URLParam(r, "*"))
	if err != nil {
		httpapi.WriteError(w, r, err)
		return
	}
	contentHeaders(w.Header(), cache)
	serveObject(w, r, rc, info)
}

func serveArchive(d *Deps, w http.ResponseWriter, r *http.Request, v *artifacts.Served, cache string) {
	rc, info, err := d.Artifacts.Archive(r.Context(), v)
	if err != nil {
		httpapi.WriteError(w, r, err)
		return
	}
	contentHeaders(w.Header(), cache)
	name := strings.Map(func(c rune) rune {
		if strings.ContainsRune(`/\:*?"<>|`, c) || c < ' ' {
			return '-'
		}
		return c
	}, v.Title)
	w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{
		"filename": name + "-v" + strconv.Itoa(v.Number) + ".zip",
	}))
	serveObject(w, r, rc, info)
}

// The public page around a shared version: AXP's markup without scripts,
// the site in a sandboxed frame below it.
var sharePage = template.Must(template.New("share").Parse(`<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta name="robots" content="noindex">
<title>{{.Title}}</title>
<style>
*{box-sizing:border-box}html,body{height:100%;margin:0}
body{display:flex;flex-direction:column;font:14px/1.4 system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;background:#fafafa;color:#18181b}
header{display:flex;align-items:center;gap:12px;padding:8px 12px;border-bottom:1px solid #e4e4e7;background:#fff;min-height:44px}
h1{flex:1;min-width:0;margin:0;font-size:14px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
span{color:#71717a;white-space:nowrap}a{color:inherit;white-space:nowrap}
iframe{flex:1;width:100%;border:0;background:#fff}
@media (prefers-color-scheme:dark){body{background:#09090b;color:#fafafa}header{background:#18181b;border-color:#27272a}span{color:#a1a1aa}}
@media (max-width:480px){span{display:none}}
</style>
</head>
<body>
<header>
<h1>{{.Title}}</h1>
<span>v{{.Number}} · AXP Artifact</span>
<a href="files/" target="_blank" rel="noopener noreferrer">新窗口打开</a>
<a href="archive.zip" download>下载</a>
</header>
<iframe src="files/" title="{{.Title}}" sandbox="allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads" referrerpolicy="no-referrer"></iframe>
</body>
</html>
`))

const missingPage = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>无法访问</title></head><body style="font:15px system-ui,sans-serif;padding:48px 24px;text-align:center;color:#71717a">这个分享不存在，或已被撤销。</body></html>`

// shareRoutes are the public pages: the only part of /share or /preview a
// path can reach is one version's page, files and ZIP.
func shareRoutes(r chi.Router, d *Deps) {
	shared := func(next func(http.ResponseWriter, *http.Request, *artifacts.Served)) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			v, err := d.Artifacts.Shared(r.Context(), chi.URLParam(r, "token"))
			if err != nil {
				httpapi.WriteError(w, r, err)
				return
			}
			next(w, r, v)
		}
	}
	r.Get(artifacts.SharePrefix+"{token}", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, artifacts.SharePath(chi.URLParam(r, "token")), http.StatusMovedPermanently)
	})
	r.Get(artifacts.SharePrefix+"{token}/", func(w http.ResponseWriter, r *http.Request) {
		v, err := d.Artifacts.Shared(r.Context(), chi.URLParam(r, "token"))
		h := w.Header()
		h.Set("Referrer-Policy", "no-referrer")
		h.Set("X-Robots-Tag", "noindex")
		h.Set("Cache-Control", shareCache)
		h.Set("Content-Type", "text/html; charset=utf-8")
		if err != nil {
			h.Set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'")
			w.WriteHeader(http.StatusNotFound)
			_, _ = io.WriteString(w, missingPage)
			return
		}
		h.Set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; frame-src 'self'; base-uri 'none'; form-action 'none'")
		_ = sharePage.Execute(w, v)
	})
	r.Get(artifacts.SharePrefix+"{token}/files/*", shared(func(w http.ResponseWriter, r *http.Request, v *artifacts.Served) {
		serveFile(d, w, r, v, shareCache)
	}))
	r.Get(artifacts.SharePrefix+"{token}/archive.zip", shared(func(w http.ResponseWriter, r *http.Request, v *artifacts.Served) {
		serveArchive(d, w, r, v, shareCache)
	}))
	r.Get(artifacts.PreviewPrefix+"{capability}/files/*", func(w http.ResponseWriter, r *http.Request) {
		v, err := d.Artifacts.Previewed(r.Context(), chi.URLParam(r, "capability"))
		if err != nil {
			httpapi.WriteError(w, r, err)
			return
		}
		serveFile(d, w, r, v, previewCache)
	})
}

// upload is the one upload, for whoever by finds the request's sender.
func upload(d *Deps, by func(*http.Request) (artifacts.Uploader, error)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		uploader, err := by(r)
		if err != nil {
			httpapi.WriteError(w, r, err)
			return
		}
		q := r.URL.Query()
		out, err := d.Artifacts.Upload(r.Context(), uploader, artifacts.UploadInput{
			Title: q.Get("title"), Task: q.Get("task"), Artifact: q.Get("artifact"),
		}, r.Body)
		if err != nil {
			httpapi.WriteError(w, r, err)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(out)
	}
}

// agentUpload is the artifacts plugin's upload: the runtime gateway passes
// on the agent whose key it checked.
func agentUpload(d *Deps) http.HandlerFunc {
	return upload(d, func(r *http.Request) (artifacts.Uploader, error) {
		id, ok := pg.ParseID(r.Header.Get("X-AXP-Agent-Id"))
		if !ok {
			return artifacts.Uploader{}, apierr.New(403, "FORBIDDEN", "只有智能体可以发布 Artifact。")
		}
		var group *string
		if value, ok := pg.ParseID(r.Header.Get("X-AXP-Group-Id")); ok {
			group = &value
		}
		return artifacts.Uploader{AgentID: id, GroupID: group}, nil
	})
}

// remoteUpload is `axp artifact upload` on a remote computer.
func remoteUpload(d *Deps) http.HandlerFunc {
	return upload(d, func(r *http.Request) (artifacts.Uploader, error) {
		c, err := RemoteBearer{Authorization: r.Header.Get("Authorization"), Dir: r.Header.Get("X-Working-Dir")}.computer(r.Context(), d)
		if err != nil {
			return artifacts.Uploader{}, err
		}
		return artifacts.Uploader{Computer: c}, nil
	})
}

type ArtifactList struct {
	Artifacts []artifacts.Artifact `json:"artifacts"`
}

type ArtifactPath struct {
	ArtifactID string `path:"artifact_id"`
}

type ArtifactVersionPath struct {
	ArtifactPath
	Number int `path:"number" minimum:"1"`
}

func artifactOp(id, method, path, summary string, status int) huma.Operation {
	return httpapi.Op(id, method, path, summary, status, []int{404, 422, 424, 503}, "artifacts")
}

func registerArtifacts(api *httpapi.API, d *Deps) {
	s := d.Artifacts
	huma.Register(api, artifactOp("listArtifacts", http.MethodGet, "/api/v1/artifacts", "Artifacts with a published version, most recently updated first", 200),
		func(ctx context.Context, in *struct {
			Task string `query:"task" doc:"Only this task's (its id)."`
		}) (*httpapi.Body[ArtifactList], error) {
			list, err := s.List(ctx, in.Task)
			if err != nil {
				return nil, err
			}
			return &httpapi.Body[ArtifactList]{Body: ArtifactList{list}}, nil
		})
	huma.Register(api, artifactOp("getArtifact", http.MethodGet, "/api/v1/artifacts/{artifact_id}", "An artifact and its published versions", 200),
		func(ctx context.Context, in *ArtifactPath) (*httpapi.Body[artifacts.Artifact], error) {
			a, err := s.Get(ctx, in.ArtifactID)
			if err != nil {
				return nil, err
			}
			return &httpapi.Body[artifacts.Artifact]{Body: *a}, nil
		})
	huma.Register(api, artifactOp("deleteArtifact", http.MethodDelete, "/api/v1/artifacts/{artifact_id}", "Delete an artifact with its versions and links", 204),
		func(ctx context.Context, in *ArtifactPath) (*struct{}, error) {
			return nil, s.Delete(ctx, in.ArtifactID)
		})
	huma.Register(api, artifactOp("shareArtifactVersion", http.MethodPut, "/api/v1/artifacts/{artifact_id}/versions/{number}/share",
		"Share a version publicly (its current link if shared already)", 200),
		func(ctx context.Context, in *ArtifactVersionPath) (*httpapi.Body[artifacts.ArtifactShare], error) {
			share, err := s.ShareVersion(ctx, in.ArtifactID, in.Number)
			if err != nil {
				return nil, err
			}
			return &httpapi.Body[artifacts.ArtifactShare]{Body: *share}, nil
		})
	huma.Register(api, artifactOp("unshareArtifactVersion", http.MethodDelete, "/api/v1/artifacts/{artifact_id}/versions/{number}/share",
		"Revoke a version's public link for good", 204),
		func(ctx context.Context, in *ArtifactVersionPath) (*struct{}, error) {
			return nil, s.RevokeShare(ctx, in.ArtifactID, in.Number)
		})
	// The ZIP, for the browser to download as the user.
	api.Router.Get("/api/v1/artifacts/{artifact_id}/versions/{number}/archive", func(w http.ResponseWriter, r *http.Request) {
		number, err := strconv.Atoi(chi.URLParam(r, "number"))
		if err != nil {
			httpapi.WriteError(w, r, apierr.NotFound())
			return
		}
		v, err := s.Archived(r.Context(), chi.URLParam(r, "artifact_id"), number)
		if err != nil {
			httpapi.WriteError(w, r, err)
			return
		}
		serveArchive(d, w, r, v, "private, no-store")
	})
	shareRoutes(api.Router, d)
}
