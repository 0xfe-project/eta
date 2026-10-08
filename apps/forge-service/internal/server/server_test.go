package server

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"

	"github.com/akarachen/axp/apps/forge-service/internal/github"
	"github.com/golang-jwt/jwt/v5"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

const origin = "https://axp.example.com"

// fakeGitHub answers the parts of GitHub's API the service uses, for one App.
type fakeGitHub struct {
	t   *testing.T
	key *rsa.PrivateKey
	pem string

	mu            sync.Mutex
	installations []map[string]any
	repositories  map[int64][]string // installation id -> repositories it may access
	tokens        []map[string]any   // access token requests, with the token issued
	pulls         []map[string]any
	appDeleted    bool
}

func newFakeGitHub(t *testing.T) *fakeGitHub {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	der, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	pemText := string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der}))
	return &fakeGitHub{t: t, key: key, pem: pemText, repositories: map[int64][]string{}}
}

func (f *fakeGitHub) install(account, accountType string, repositories ...string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	id := int64(100 + len(f.installations))
	f.installations = append(f.installations, map[string]any{
		"id":                   id,
		"account":              map[string]any{"login": account, "type": accountType},
		"repository_selection": "selected",
		"html_url":             fmt.Sprintf("https://github.com/settings/installations/%d", id),
	})
	f.repositories[id] = repositories
}

func (f *fakeGitHub) lastToken() map[string]any {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.tokens[len(f.tokens)-1]
}

func reply(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func (f *fakeGitHub) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	path := r.URL.Path
	auth := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	switch {
	case path == "/app-manifests/good-code/conversions" && r.Method == http.MethodPost:
		reply(w, 201, map[string]any{
			"id": 77, "slug": "axp-test", "name": "AXP Test", "client_id": "Iv1.abc",
			"html_url": "https://github.com/apps/axp-test",
			"owner":    map[string]any{"login": "akarachen", "type": "User"},
			"pem":      f.pem,
		})
		return
	case strings.HasPrefix(path, "/app-manifests/"):
		reply(w, 404, map[string]any{"message": "Not Found"})
		return
	case path == "/users/axp-test[bot]":
		reply(w, 200, map[string]any{"id": 4242})
		return
	case strings.HasPrefix(path, "/app/"):
		if f.appDeleted {
			reply(w, 401, map[string]any{"message": "Bad credentials"})
			return
		}
		claims := jwt.MapClaims{}
		if _, err := jwt.ParseWithClaims(auth, claims, func(*jwt.Token) (any, error) { return &f.key.PublicKey, nil }); err != nil || claims["iss"] != "77" {
			f.t.Errorf("bad App JWT: %v %v", err, claims)
			reply(w, 401, nil)
			return
		}
		if path == "/app/installations" {
			reply(w, 200, f.installations)
			return
		}
		id, _ := strconv.ParseInt(strings.Split(path, "/")[3], 10, 64)
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		if wanted, ok := body["repositories"].([]any); ok {
			for _, name := range wanted {
				if !slices.Contains(f.repositories[id], name.(string)) {
					reply(w, 422, map[string]any{"message": "There is at least one repository that does not exist or is not accessible"})
					return
				}
			}
		}
		token := fmt.Sprintf("ghs_%d", len(f.tokens))
		body["token"], body["installation"] = token, id
		f.tokens = append(f.tokens, body)
		reply(w, 201, map[string]any{"token": token, "expires_at": "2099-01-01T00:00:00Z"})
		return
	}
	var granted map[string]any
	for _, t := range f.tokens {
		if t["token"] == auth {
			granted = t
		}
	}
	if granted == nil {
		f.t.Errorf("%s %s without an installation token", r.Method, path)
		reply(w, 401, nil)
		return
	}
	switch {
	case path == "/installation/repositories":
		id := granted["installation"].(int64)
		var owner string
		for _, inst := range f.installations {
			if inst["id"] == id {
				owner = inst["account"].(map[string]any)["login"].(string)
			}
		}
		var repos []map[string]any
		for _, name := range f.repositories[id] {
			repos = append(repos, map[string]any{"full_name": owner + "/" + name})
		}
		reply(w, 200, map[string]any{"total_count": len(repos), "repositories": repos})
	case path == "/repos/akarachen/axp" && r.Method == http.MethodGet:
		reply(w, 200, map[string]any{"default_branch": "main"})
	case path == "/repos/akarachen/axp/pulls" && r.Method == http.MethodPost:
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		for _, p := range f.pulls {
			if p["head"] == body["head"] {
				reply(w, 422, map[string]any{"message": "Validation Failed", "errors": []any{map[string]any{
					"message": "A pull request already exists for akarachen:" + body["head"].(string) + ".",
				}}})
				return
			}
		}
		if body["head"] == "empty" {
			reply(w, 422, map[string]any{"message": "Validation Failed", "errors": []any{map[string]any{"message": "No commits between main and empty"}}})
			return
		}
		body["number"] = len(f.pulls) + 1
		f.pulls = append(f.pulls, body)
		reply(w, 201, map[string]any{"number": body["number"], "html_url": fmt.Sprintf("https://github.com/akarachen/axp/pull/%d", body["number"])})
	case path == "/repos/akarachen/axp/pulls":
		head := strings.SplitN(r.URL.Query().Get("head"), ":", 2)[1]
		var found []map[string]any
		for _, p := range f.pulls {
			if p["head"] == head {
				found = append(found, map[string]any{"number": p["number"], "html_url": fmt.Sprintf("https://github.com/akarachen/axp/pull/%d", p["number"])})
			}
		}
		reply(w, 200, found)
	default:
		reply(w, 404, map[string]any{"message": "no fake for " + r.Method + " " + path})
	}
}

type env struct {
	t      *testing.T
	fake   *fakeGitHub
	gh     *github.GitHub
	server *httptest.Server
}

func newEnv(t *testing.T) *env {
	fake := newFakeGitHub(t)
	api := httptest.NewServer(fake)
	t.Cleanup(api.Close)
	gh := github.New(t.TempDir())
	gh.APIURL = api.URL
	srv := httptest.NewServer(New(gh, slog.New(slog.NewTextHandler(io.Discard, nil))))
	t.Cleanup(srv.Close)
	return &env{t: t, fake: fake, gh: gh, server: srv}
}

// do sends a request, as a runtime when agent is set, and decodes JSON.
func (e *env) do(method, path string, agent bool, body any) (int, map[string]any, http.Header) {
	e.t.Helper()
	var reader io.Reader
	if body != nil {
		data, _ := json.Marshal(body)
		reader = strings.NewReader(string(data))
	}
	req, _ := http.NewRequest(method, e.server.URL+path, reader)
	if agent {
		req.Header.Set(agentHeader, "agent-1")
	}
	client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	resp, err := client.Do(req)
	if err != nil {
		e.t.Fatal(err)
	}
	defer resp.Body.Close()
	var out map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&out)
	return resp.StatusCode, out, resp.Header
}

// connect runs the browser's side of the manifest flow, through GitHub's redirect.
func (e *env) connect() {
	e.t.Helper()
	_, form, _ := e.do("POST", "/api/forge/v1/github/manifest", false, map[string]any{"name": "AXP Test", "origin": origin})
	action, _ := url.Parse(form["action"].(string))
	status, _, header := e.do("GET", "/api/forge/v1/github/manifest/callback?code=good-code&state="+action.Query().Get("state"), false, nil)
	if status != 303 || header.Get("Location") != "/?view=capabilities&github=created" {
		e.t.Fatalf("callback: %d %s", status, header.Get("Location"))
	}
}

func errorCode(body map[string]any) string {
	return body["error"].(map[string]any)["code"].(string)
}

func errorMessage(body map[string]any) string {
	return body["error"].(map[string]any)["message"].(string)
}

// agentTransport adds what the runtime gateway would.
type agentTransport struct{}

func (agentTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	r = r.Clone(r.Context())
	r.Header.Set(agentHeader, "agent-1")
	return http.DefaultTransport.RoundTrip(r)
}

// openPullRequest calls the MCP tool the way Codex does.
func (e *env) openPullRequest(args map[string]any) *mcp.CallToolResult {
	e.t.Helper()
	ctx := context.Background()
	client := mcp.NewClient(&mcp.Implementation{Name: "test"}, nil)
	session, err := client.Connect(ctx, &mcp.StreamableClientTransport{
		Endpoint:   e.server.URL + "/forge/mcp",
		HTTPClient: &http.Client{Transport: agentTransport{}},
	}, nil)
	if err != nil {
		e.t.Fatal(err)
	}
	defer session.Close()
	result, err := session.CallTool(ctx, &mcp.CallToolParams{Name: "open_pull_request", Arguments: args})
	if err != nil {
		e.t.Fatal(err)
	}
	return result
}

func text(result *mcp.CallToolResult) string {
	return result.Content[0].(*mcp.TextContent).Text
}

func TestNotConnected(t *testing.T) {
	e := newEnv(t)
	_, body, _ := e.do("GET", "/api/forge/v1/github", false, nil)
	if body["state"] != "not_connected" || body["app"] != nil || len(body["installations"].([]any)) != 0 {
		t.Fatalf("status: %v", body)
	}
}

func TestManifestForAUserAndAnOrganization(t *testing.T) {
	e := newEnv(t)
	_, form, _ := e.do("POST", "/api/forge/v1/github/manifest", false, map[string]any{"name": "AXP Test", "origin": origin + "/ignored"})
	if !strings.HasPrefix(form["action"].(string), "https://github.com/settings/apps/new?state=") {
		t.Fatalf("action: %v", form["action"])
	}
	var manifest map[string]any
	if err := json.Unmarshal([]byte(form["manifest"].(string)), &manifest); err != nil {
		t.Fatal(err)
	}
	if manifest["redirect_url"] != origin+"/api/forge/v1/github/manifest/callback" ||
		manifest["setup_url"] != origin+"/?view=capabilities" ||
		manifest["hook_attributes"].(map[string]any)["active"] != false {
		t.Fatalf("manifest: %v", manifest)
	}
	permissions := manifest["default_permissions"].(map[string]any)
	if permissions["contents"] != "write" || permissions["workflows"] != nil {
		t.Fatalf("permissions: %v", permissions)
	}
	_, org, _ := e.do("POST", "/api/forge/v1/github/manifest", false, map[string]any{"name": "AXP Test", "organization": "acme", "origin": origin})
	if !strings.HasPrefix(org["action"].(string), "https://github.com/organizations/acme/settings/apps/new?state=") {
		t.Fatalf("org action: %v", org["action"])
	}
}

func TestInvalidManifestRequests(t *testing.T) {
	e := newEnv(t)
	for _, body := range []map[string]any{
		{"name": "", "origin": origin},
		{"name": strings.Repeat("x", 35), "origin": origin},
		{"name": "AXP", "organization": "bad org", "origin": origin},
		{"name": "AXP", "origin": "javascript:alert(1)"},
	} {
		status, out, _ := e.do("POST", "/api/forge/v1/github/manifest", false, body)
		if status != 400 || errorMessage(out) == "" {
			t.Errorf("%v: %d %v", body, status, out)
		}
	}
}

func TestCreatingThenInstalling(t *testing.T) {
	e := newEnv(t)
	e.connect()
	_, status, _ := e.do("GET", "/api/forge/v1/github", false, nil)
	app := status["app"].(map[string]any)
	if status["state"] != "not_installed" ||
		app["install_url"] != "https://github.com/apps/axp-test/installations/new" ||
		app["settings_url"] != "https://github.com/settings/apps/axp-test" {
		t.Fatalf("status: %v", status)
	}
	info, err := os.Stat(filepath.Join(e.gh.StateDir, "github.pem"))
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("key: %v %v", info.Mode(), err)
	}
	e.fake.install("akarachen", "User", "axp", "notes")
	_, status, _ = e.do("GET", "/api/forge/v1/github?fresh=1", false, nil)
	installations := status["installations"].([]any)
	if status["state"] != "ready" || len(installations) != 1 {
		t.Fatalf("status: %v", status)
	}
	inst := installations[0].(map[string]any)
	if inst["account"] != "akarachen" || fmt.Sprint(inst["repositories"]) != "[akarachen/axp akarachen/notes]" ||
		!strings.HasSuffix(inst["manage_url"].(string), "/installations/100") {
		t.Fatalf("installation: %v", inst)
	}
}

func TestACallbackNeedsAFreshState(t *testing.T) {
	e := newEnv(t)
	_, _, header := e.do("GET", "/api/forge/v1/github/manifest/callback?code=good-code&state=forged", false, nil)
	if !strings.Contains(header.Get("Location"), "github_error=") {
		t.Fatalf("location: %s", header.Get("Location"))
	}
	if _, body, _ := e.do("GET", "/api/forge/v1/github", false, nil); body["state"] != "not_connected" {
		t.Fatalf("state: %v", body["state"])
	}
}

func TestAnExpiredCode(t *testing.T) {
	e := newEnv(t)
	_, form, _ := e.do("POST", "/api/forge/v1/github/manifest", false, map[string]any{"name": "AXP", "origin": origin})
	action, _ := url.Parse(form["action"].(string))
	_, _, header := e.do("GET", "/api/forge/v1/github/manifest/callback?code=stale&state="+action.Query().Get("state"), false, nil)
	if !strings.Contains(header.Get("Location"), "github_error=") {
		t.Fatalf("location: %s", header.Get("Location"))
	}
}

func TestOneAppAtATimeAndForgetting(t *testing.T) {
	e := newEnv(t)
	e.connect()
	if _, again, _ := e.do("POST", "/api/forge/v1/github/manifest", false, map[string]any{"name": "AXP 2", "origin": origin}); errorCode(again) != "GITHUB_ALREADY_CONNECTED" {
		t.Fatalf("again: %v", again)
	}
	if status, _, _ := e.do("DELETE", "/api/forge/v1/github", false, nil); status != 204 {
		t.Fatalf("delete: %d", status)
	}
	if _, body, _ := e.do("GET", "/api/forge/v1/github", false, nil); body["state"] != "not_connected" {
		t.Fatalf("state: %v", body["state"])
	}
}

func TestAnAppDeletedOnGitHub(t *testing.T) {
	e := newEnv(t)
	e.connect()
	e.fake.appDeleted = true
	_, status, _ := e.do("GET", "/api/forge/v1/github?fresh=1", false, nil)
	if status["state"] != "error" || status["error"].(map[string]any)["code"] != "GITHUB_APP_GONE" {
		t.Fatalf("status: %v", status)
	}
}

func TestEverythingSaysHowToConnectFirst(t *testing.T) {
	e := newEnv(t)
	for path, body := range map[string]any{
		"/forge/credential": map[string]any{"host": "github.com", "path": "a/b.git"},
		"/forge/gh-token":   map[string]any{"owner": "a"},
	} {
		status, out, _ := e.do("POST", path, true, body)
		if status != 409 || !strings.Contains(errorMessage(out), "能力") {
			t.Errorf("%s: %d %v", path, status, out)
		}
	}
	result := e.openPullRequest(map[string]any{"repository": "a/b", "head": "x", "title": "t"})
	if !result.IsError || !strings.Contains(text(result), "能力") {
		t.Fatalf("tool: %v", text(result))
	}
}

func TestRoutesNeedTheGatewayHeader(t *testing.T) {
	e := newEnv(t)
	for _, path := range []string{"/forge/credential", "/forge/mcp"} {
		if status, _, _ := e.do("POST", path, false, map[string]any{"host": "github.com", "path": "a/b"}); status != 401 {
			t.Errorf("%s: %d", path, status)
		}
	}
}

func TestGitCredentialForOneRepository(t *testing.T) {
	e := newEnv(t)
	e.connect()
	e.fake.install("akarachen", "User", "axp")
	_, out, _ := e.do("POST", "/forge/credential", true, map[string]any{"host": "github.com", "path": "akarachen/axp.git"})
	if out["username"] != "x-access-token" || out["password"] != "ghs_0" {
		t.Fatalf("credential: %v", out)
	}
	token := e.fake.lastToken()
	if fmt.Sprint(token["repositories"]) != "[axp]" || fmt.Sprint(token["permissions"]) != "map[contents:write metadata:read]" {
		t.Fatalf("token request: %v", token)
	}
	// Cached until close to expiry.
	e.do("POST", "/forge/credential", true, map[string]any{"host": "github.com", "path": "akarachen/axp"})
	if len(e.fake.tokens) != 1 {
		t.Fatalf("tokens: %d", len(e.fake.tokens))
	}
}

func TestRepositoriesTheAppCannotReach(t *testing.T) {
	e := newEnv(t)
	e.connect()
	e.fake.install("akarachen", "User", "axp")
	if _, out, _ := e.do("POST", "/forge/credential", true, map[string]any{"host": "github.com", "path": "akarachen/secret"}); errorCode(out) != "GITHUB_REPOSITORY_NOT_GRANTED" {
		t.Fatalf("not granted: %v", out)
	}
	if _, out, _ := e.do("POST", "/forge/credential", true, map[string]any{"host": "github.com", "path": "someone/else"}); errorCode(out) != "GITHUB_NOT_INSTALLED" {
		t.Fatalf("other: %v", out)
	}
}

func TestGhGetsAReadOnlyToken(t *testing.T) {
	e := newEnv(t)
	e.connect()
	e.fake.install("acme", "Organization", "web")
	_, out, _ := e.do("POST", "/forge/gh-token", true, map[string]any{"owner": "ACME"})
	if !strings.HasPrefix(out["token"].(string), "ghs_") {
		t.Fatalf("token: %v", out)
	}
	token := e.fake.lastToken()
	for name, level := range token["permissions"].(map[string]any) {
		if level != "read" {
			t.Errorf("%s: %v", name, level)
		}
	}
	if token["repositories"] != nil {
		t.Errorf("repositories: %v", token["repositories"])
	}
}

func TestIdentity(t *testing.T) {
	e := newEnv(t)
	e.connect()
	_, out, _ := e.do("GET", "/forge/identity", true, nil)
	if out["name"] != "axp-test[bot]" || out["email"] != "4242+axp-test[bot]@users.noreply.github.com" {
		t.Fatalf("identity: %v", out)
	}
}

func TestOpenPullRequest(t *testing.T) {
	e := newEnv(t)
	e.connect()
	e.fake.install("akarachen", "User", "axp")
	result := e.openPullRequest(map[string]any{
		"repository": "git@github.com:akarachen/axp.git", "head": "feature", "title": "Add feature", "body": "Why",
	})
	var pull map[string]any
	if err := json.Unmarshal([]byte(text(result)), &pull); err != nil || result.IsError {
		t.Fatalf("result: %v", text(result))
	}
	if pull["url"] != "https://github.com/akarachen/axp/pull/1" || pull["created"] != true {
		t.Fatalf("pull: %v", pull)
	}
	if e.fake.pulls[0]["base"] != "main" || e.fake.lastToken()["permissions"].(map[string]any)["pull_requests"] != "write" {
		t.Fatalf("request: %v %v", e.fake.pulls[0], e.fake.lastToken())
	}
	again := e.openPullRequest(map[string]any{"repository": "akarachen/axp", "head": "feature", "title": "x"})
	if !strings.Contains(text(again), `"created":false`) {
		t.Fatalf("again: %v", text(again))
	}
	empty := e.openPullRequest(map[string]any{"repository": "akarachen/axp", "head": "empty", "title": "x"})
	if !empty.IsError || !strings.Contains(text(empty), "No commits") {
		t.Fatalf("empty: %v", text(empty))
	}
}
