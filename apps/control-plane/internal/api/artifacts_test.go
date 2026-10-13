package api

import (
	"archive/zip"
	"bytes"
	"context"
	"errors"
	"hash/crc32"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"

	"github.com/akarachen/axp/apps/control-plane/internal/artifacts"
	"github.com/akarachen/axp/apps/control-plane/internal/objects"
	"github.com/akarachen/axp/apps/control-plane/internal/tasks"
)

// memStore is S3 in memory; failAt fails that many Puts from now on.
type memStore struct {
	mu      sync.Mutex
	objects map[string]stored
	failAt  int
}

type stored struct {
	data        []byte
	contentType string
}

func (m *memStore) Put(_ context.Context, key string, r io.Reader, size int64, contentType string) error {
	data, err := io.ReadAll(r)
	if err != nil {
		return err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.failAt > 0 {
		if m.failAt--; m.failAt == 0 {
			return errors.New("S3 is down")
		}
	}
	if int64(len(data)) != size {
		return errors.New("size mismatch")
	}
	m.objects[key] = stored{data, contentType}
	return nil
}

func (m *memStore) Get(_ context.Context, key string) (io.ReadCloser, objects.Info, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	o, ok := m.objects[key]
	if !ok {
		return nil, objects.Info{}, objects.ErrNotFound
	}
	return io.NopCloser(bytes.NewReader(o.data)), objects.Info{Size: int64(len(o.data)), ContentType: o.contentType}, nil
}

func (m *memStore) DeletePrefix(_ context.Context, prefix string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	for k := range m.objects {
		if strings.HasPrefix(k, prefix) {
			delete(m.objects, k)
		}
	}
	return nil
}

func (m *memStore) keys(prefix string) int {
	m.mu.Lock()
	defer m.mu.Unlock()
	n := 0
	for k := range m.objects {
		if strings.HasPrefix(k, prefix) {
			n++
		}
	}
	return n
}

type artifactEnv struct {
	*taskEnv
	store   *memStore
	service *artifacts.Service
}

func newArtifactEnv(t *testing.T) *artifactEnv {
	e := newTaskEnv(t)
	store := &memStore{objects: map[string]stored{}}
	service := &artifacts.Service{DB: e.db, Store: store, Tasks: &tasks.Service{Relay: e.relay}, Secret: e.secret, Limits: artifacts.DefaultLimits}
	deps := &Deps{DB: e.db, Chat: e.chat, Tasks: &tasks.Service{Relay: e.relay}, Artifacts: service, Secret: e.secret, PublicURL: "https://axp.test"}
	e.public = Public(deps).Router
	e.internal = Internal(deps).Router
	return &artifactEnv{taskEnv: e, store: store, service: service}
}

// site is a ZIP of name, body pairs.
func site(t *testing.T, files ...string) []byte {
	t.Helper()
	var buf bytes.Buffer
	w := zip.NewWriter(&buf)
	for i := 0; i+1 < len(files); i += 2 {
		f, err := w.Create(files[i])
		if err != nil {
			t.Fatal(err)
		}
		_, _ = f.Write([]byte(files[i+1]))
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

// A site with relative files several levels down and a script.
func demoSite(t *testing.T, heading string) []byte {
	return site(t,
		"index.html", `<link rel="stylesheet" href="assets/css/site.css"><script src="assets/js/app.js"></script><h1>`+heading+`</h1>`,
		"assets/css/site.css", "h1{color:teal}",
		"assets/js/app.js", "document.title='ok'",
		"assets/img/dot.svg", `<svg xmlns="http://www.w3.org/2000/svg"/>`,
		"docs/index.html", "<p>docs</p>",
	)
}

func send(t *testing.T, h http.Handler, method, target string, body []byte, headers map[string]string) response {
	t.Helper()
	req := httptest.NewRequest(method, target, bytes.NewReader(body))
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return response{rec.Code, rec.Header(), rec.Body.Bytes()}
}

func query(pairs ...string) string {
	v := url.Values{}
	for i := 0; i+1 < len(pairs); i += 2 {
		if pairs[i+1] != "" {
			v.Set(pairs[i], pairs[i+1])
		}
	}
	return v.Encode()
}

// agentUpload publishes as an AXP agent, as the runtime gateway passes it on.
func (e *artifactEnv) agentUpload(agent string, body []byte, pairs ...string) response {
	return send(e.t, e.internal, http.MethodPost, "/artifacts/v1/upload?"+query(pairs...), body,
		map[string]string{"X-AXP-Agent-Id": agent, "Content-Type": "application/zip"})
}

func (e *artifactEnv) remoteUpload(token string, body []byte, pairs ...string) response {
	return send(e.t, e.public, http.MethodPost, "/remote/v1/artifacts?"+query(pairs...), body,
		map[string]string{"Authorization": "Bearer " + token, "Content-Type": "application/zip"})
}

func (e *artifactEnv) page(path string) response {
	return send(e.t, e.public, http.MethodGet, path, nil, nil)
}

func (e *artifactEnv) artifact(id string) artifacts.Artifact {
	e.t.Helper()
	var a artifacts.Artifact
	r := e.get("/artifacts/" + id)
	if r.status != 200 {
		e.t.Fatalf("artifact: %d %s", r.status, r.body)
	}
	r.json(e.t, &a)
	return a
}

func published(t *testing.T, r response) artifacts.Published {
	t.Helper()
	if r.status != 201 {
		t.Fatalf("upload: %d %s", r.status, r.body)
	}
	var p artifacts.Published
	r.json(t, &p)
	return p
}

func TestAnAgentPublishesASiteThatPreviewsInASandbox(t *testing.T) {
	e := newArtifactEnv(t)
	agent := e.createAgent("Writer")
	task := e.create(map[string]any{"kind": "none"})

	p := published(t, e.agentUpload(agent.ID, demoSite(t, "v1"), "title", "季度报告", "task", "#1"))
	expect(t, p.Version, 1)
	expect(t, p.Files, 5)

	// On the task's timeline, by the agent.
	last := e.task(task.ID).Activity
	a := last[len(last)-1]
	if a.Kind != "artifact" || a.Actor.Kind != "agent" || a.Data["artifact_id"] != p.ArtifactID || a.Data["version"] != float64(1) {
		t.Fatalf("activity %+v", a)
	}
	var list ArtifactList
	e.get("/artifacts", "task", task.ID).json(t, &list)
	expect(t, len(list.Artifacts), 1)

	got := e.artifact(p.ArtifactID)
	if got.Title != "季度报告" || *got.AgentID != agent.ID || *got.TaskNumber != 1 || len(got.Versions) != 1 || got.Versions[0].Share != nil {
		t.Fatalf("artifact %+v", got)
	}
	preview := got.Versions[0].PreviewURL
	if !strings.HasPrefix(preview, "/preview/artifacts/") || !strings.HasSuffix(preview, "/files/") {
		t.Fatal(preview)
	}
	// Every relative file works under the capability, sandboxed.
	for path, want := range map[string]string{
		"":                    "text/html; charset=utf-8",
		"index.html":          "text/html; charset=utf-8",
		"assets/css/site.css": "text/css; charset=utf-8",
		"assets/js/app.js":    "text/javascript; charset=utf-8",
		"assets/img/dot.svg":  "image/svg+xml",
		"docs/":               "text/html; charset=utf-8",
	} {
		r := e.page(preview + path)
		if r.status != 200 || r.header.Get("Content-Type") != want {
			t.Fatalf("%s: %d %s", path, r.status, r.header.Get("Content-Type"))
		}
		csp := r.header.Get("Content-Security-Policy")
		if !strings.HasPrefix(csp, "sandbox allow-scripts") || strings.Contains(csp, "allow-same-origin") ||
			r.header.Get("Referrer-Policy") != "no-referrer" || r.header.Get("X-Content-Type-Options") != "nosniff" ||
			r.header.Get("Access-Control-Allow-Origin") != "*" || r.header.Get("Access-Control-Allow-Credentials") != "" {
			t.Fatalf("%s headers %v", path, r.header)
		}
	}
	for _, path := range []string{"missing.html", "../archive.zip", "assets/../../archive.zip"} {
		if s, _ := e.page(preview + path).error(); s != 404 {
			t.Fatalf("%s: %d", path, s)
		}
	}
	// A forged or altered capability names nothing.
	capability := strings.TrimSuffix(strings.TrimPrefix(preview, "/preview/artifacts/"), "/files/")
	parts := strings.Split(capability, ".")
	for _, forged := range []string{
		parts[0] + "." + parts[1] + "." + strings.Repeat("0", 64),
		parts[0] + ".9999999999." + parts[2],
		parts[0],
	} {
		if s, _ := e.page("/preview/artifacts/" + forged + "/files/index.html").error(); s != 404 {
			t.Fatalf("forged %s: %d", forged, s)
		}
	}
	// A private version is never reachable under /share.
	for _, path := range []string{capability, parts[0], p.ArtifactID} {
		if s, _ := e.page("/share/artifacts/" + path + "/files/index.html").error(); s != 404 {
			t.Fatalf("/share/%s: %d", path, s)
		}
	}
	if r := e.page("/share/artifacts/" + strings.Repeat("A", 43) + "/"); r.status != 404 || !strings.Contains(string(r.body), "已被撤销") {
		t.Fatalf("share page: %d", r.status)
	}

	// The ZIP downloads as it was uploaded.
	r := e.page("/api/v1/artifacts/" + p.ArtifactID + "/versions/1/archive")
	if r.status != 200 || !bytes.Equal(r.body, demoSite(t, "v1")) || !strings.Contains(r.header.Get("Content-Disposition"), "attachment") {
		t.Fatalf("archive: %d %v", r.status, r.header)
	}
}

func TestASharedVersionStaysAsItWasUntilRevoked(t *testing.T) {
	e := newArtifactEnv(t)
	agent := e.createAgent("Writer")
	p := published(t, e.agentUpload(agent.ID, demoSite(t, "first"), "title", "Demo"))
	if p.TaskID != nil {
		t.Fatal("no task given")
	}

	var share artifacts.ArtifactShare
	r := send(t, e.public, http.MethodPut, "/api/v1/artifacts/"+p.ArtifactID+"/versions/1/share", nil, nil)
	r.json(t, &share)
	if r.status != 200 || !strings.HasPrefix(share.URL, "/share/artifacts/") {
		t.Fatalf("share: %d %s", r.status, r.body)
	}
	// Sharing again keeps the link.
	var again artifacts.ArtifactShare
	send(t, e.public, http.MethodPut, "/api/v1/artifacts/"+p.ArtifactID+"/versions/1/share", nil, nil).json(t, &again)
	expect(t, again.URL, share.URL)

	// The public page frames the files; both work without any session.
	shell := e.page(share.URL)
	if shell.status != 200 || !strings.Contains(string(shell.body), `<iframe src="files/"`) ||
		!strings.Contains(string(shell.body), `sandbox="allow-scripts`) || !strings.Contains(shell.header.Get("Content-Security-Policy"), "default-src 'none'") {
		t.Fatalf("shell: %d %s", shell.status, shell.body)
	}
	if r := e.page(strings.TrimSuffix(share.URL, "/")); r.status != 301 {
		t.Fatalf("no slash: %d", r.status)
	}
	check := func(want string) {
		t.Helper()
		r := e.page(share.URL + "files/")
		if r.status != 200 || !strings.Contains(string(r.body), want) || r.header.Get("Cache-Control") != "no-store" {
			t.Fatalf("shared files: %d %s", r.status, r.body)
		}
	}
	check("first")
	if r := e.page(share.URL + "files/assets/js/app.js"); r.status != 200 {
		t.Fatalf("js: %d", r.status)
	}
	if r := e.page(share.URL + "archive.zip"); r.status != 200 || !bytes.Equal(r.body, demoSite(t, "first")) {
		t.Fatalf("shared zip: %d", r.status)
	}

	// A new version does not change the shared one.
	p2 := published(t, e.agentUpload(agent.ID, demoSite(t, "second"), "artifact", p.ArtifactID))
	expect(t, p2.Version, 2)
	expect(t, p2.Title, "Demo")
	check("first")
	got := e.artifact(p.ArtifactID)
	if len(got.Versions) != 2 || got.Versions[0].Number != 2 || got.Versions[0].Share != nil || got.Versions[1].Share.URL != share.URL {
		t.Fatalf("versions %+v", got.Versions)
	}
	if r := e.page(got.Versions[0].PreviewURL); !strings.Contains(string(r.body), "second") {
		t.Fatalf("v2 preview: %s", r.body)
	}

	// Revoked, the link is gone for good; sharing again makes a new one.
	if r := send(t, e.public, http.MethodDelete, "/api/v1/artifacts/"+p.ArtifactID+"/versions/1/share", nil, nil); r.status != 204 {
		t.Fatalf("revoke: %d", r.status)
	}
	for _, path := range []string{"", "files/", "files/assets/js/app.js", "archive.zip"} {
		if r := e.page(share.URL + path); r.status != 404 {
			t.Fatalf("revoked %s: %d", path, r.status)
		}
	}
	var renewed artifacts.ArtifactShare
	send(t, e.public, http.MethodPut, "/api/v1/artifacts/"+p.ArtifactID+"/versions/1/share", nil, nil).json(t, &renewed)
	if renewed.URL == share.URL || e.page(share.URL).status != 404 || e.page(renewed.URL).status != 200 {
		t.Fatal("a revoked link came back")
	}

	// Deleting removes its objects too.
	if r := e.delete("/artifacts/" + p.ArtifactID); r.status != 204 {
		t.Fatalf("delete: %d", r.status)
	}
	expect(t, e.store.keys("artifacts/"+p.ArtifactID), 0)
	if e.page(renewed.URL).status != 404 {
		t.Fatal("deleted but shared")
	}
}

func TestOnlyTheirPublisherVersionsAnArtifact(t *testing.T) {
	e := newArtifactEnv(t)
	computer, token := e.computer("laptop", "paseo")
	_, other := e.computer("desktop", "paseo")
	agent := e.createAgent("Writer")
	mine := e.create(remoteAssignee(computer, "paseo", newWorktree))
	notMine := e.create(map[string]any{"kind": "none"})

	// A remote computer's agent publishes on a task it works on.
	p := published(t, e.remoteUpload(token, demoSite(t, "remote"), "title", "Remote", "task", mine.ID))
	last := e.task(mine.ID).Activity
	if a := last[len(last)-1]; a.Kind != "artifact" || a.Actor.Kind != "remote" || a.Data["computer_name"] != "laptop" {
		t.Fatalf("activity %+v", a)
	}
	if got := e.artifact(p.ArtifactID); *got.ComputerName != "laptop" || got.AgentID != nil {
		t.Fatalf("%+v", got)
	}
	// A new version goes on the artifact's task without naming it again.
	published(t, e.remoteUpload(token, demoSite(t, "remote 2"), "artifact", p.ArtifactID))

	for name, tc := range map[string]struct {
		r      response
		status int
		code   string
	}{
		"no token":           {e.remoteUpload("nope", demoSite(t, "x"), "title", "x", "task", mine.ID), 401, ""},
		"not its task":       {e.remoteUpload(token, demoSite(t, "x"), "title", "x", "task", notMine.ID), 403, "NOT_ASSIGNED"},
		"another's task":     {e.remoteUpload(other, demoSite(t, "x"), "title", "x", "task", mine.ID), 403, "NOT_ASSIGNED"},
		"another's artifact": {e.remoteUpload(other, demoSite(t, "x"), "artifact", p.ArtifactID), 403, "NOT_YOURS"},
		"no task":            {e.remoteUpload(token, demoSite(t, "x"), "title", "x"), 422, "VALIDATION_ERROR"},
		"an agent's version": {e.agentUpload(agent.ID, demoSite(t, "x"), "artifact", p.ArtifactID), 403, "NOT_YOURS"},
		"not an agent":       {e.agentUpload("", demoSite(t, "x"), "title", "x"), 403, "FORBIDDEN"},
		"no title":           {e.agentUpload(agent.ID, demoSite(t, "x")), 422, "VALIDATION_ERROR"},
		"no such task":       {e.agentUpload(agent.ID, demoSite(t, "x"), "title", "x", "task", "999"), 404, "NOT_FOUND"},
		"not a zip":          {e.agentUpload(agent.ID, []byte("hello"), "title", "x"), 422, "INVALID_ARTIFACT"},
		"empty":              {e.agentUpload(agent.ID, nil, "title", "x"), 422, "INVALID_ARTIFACT"},
		"unsafe path":        {e.agentUpload(agent.ID, site(t, "index.html", "x", "../x", "y"), "title", "x"), 422, "INVALID_ARTIFACT"},
	} {
		if s, code := tc.r.error(); s != tc.status || (tc.code != "" && code != tc.code) {
			t.Errorf("%s: %d %s, want %d %s", name, s, code, tc.status, tc.code)
		}
	}
	// None of those stored anything.
	expect(t, e.store.keys("artifacts/"), 2*(5+1))
	expect(t, scalar[int](e.env, "SELECT count(*) FROM artifact_version"), 2)
}

func TestAFailedUploadLeavesNothingBehind(t *testing.T) {
	e := newArtifactEnv(t)
	agent := e.createAgent("Writer")

	// The store fails on the third file.
	e.store.failAt = 3
	if s, code := e.agentUpload(agent.ID, demoSite(t, "x"), "title", "x").error(); s != 424 || code != "STORAGE_FAILED" {
		t.Fatalf("%d %s", s, code)
	}
	expect(t, e.store.keys("artifacts/"), 0)
	expect(t, scalar[string](e.env, "SELECT status FROM artifact_version"), "failed")
	var list ArtifactList
	e.get("/artifacts").json(t, &list)
	expect(t, len(list.Artifacts), 0)

	// A ZIP whose entry holds more than its header says fails as it is read.
	if s, code := e.agentUpload(agent.ID, lyingZip(t), "title", "x").error(); s != 422 || code != "INVALID_ARTIFACT" {
		t.Fatalf("lying zip: %d %s", s, code)
	}
	expect(t, e.store.keys("artifacts/"), 0)

	// Too large is refused before anything is read into a version.
	e.service.Limits.Archive = 100
	if s, _ := e.agentUpload(agent.ID, demoSite(t, "x"), "title", "x").error(); s != 413 {
		t.Fatalf("too large: %d", s)
	}
	expect(t, scalar[int](e.env, "SELECT count(*) FROM artifact_version"), 2)
}

// lyingZip has an index.html whose header declares fewer bytes than it holds.
func lyingZip(t *testing.T) []byte {
	var buf bytes.Buffer
	w := zip.NewWriter(&buf)
	data := []byte(strings.Repeat("<p>more than declared</p>", 100))
	f, err := w.CreateRaw(&zip.FileHeader{
		Name: "index.html", Method: zip.Store, CRC32: crc32.ChecksumIEEE(data),
		CompressedSize64: uint64(len(data)), UncompressedSize64: 10,
	})
	if err != nil {
		t.Fatal(err)
	}
	_, _ = f.Write(data)
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}
