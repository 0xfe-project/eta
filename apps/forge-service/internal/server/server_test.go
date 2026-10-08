package server

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/akarachen/axp/apps/forge-service/internal/github"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

const origin = "https://axp.example.com"

// env is the service under test, with its own state, against the shared
// emulated GitHub (emulate_test.go).
type env struct {
	t      *testing.T
	gh     *github.GitHub
	server *httptest.Server
}

func newEnv(t *testing.T) *env {
	gh := github.New(t.TempDir())
	gh.APIURL = emulator.URL
	srv := httptest.NewServer(New(gh, slog.New(slog.NewTextHandler(io.Discard, nil))))
	t.Cleanup(srv.Close)
	return &env{t: t, gh: gh, server: srv}
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

// connect runs the browser's side of the manifest flow, through GitHub's
// redirect; code picks which seeded App GitHub "created".
func (e *env) connect(code string) {
	e.t.Helper()
	_, form, _ := e.do("POST", "/api/forge/v1/github/manifest", false, map[string]any{"name": "AXP Test", "origin": origin})
	action, _ := url.Parse(form["action"].(string))
	status, _, header := e.do("GET", "/api/forge/v1/github/manifest/callback?code="+code+"&state="+action.Query().Get("state"), false, nil)
	if status != 303 || header.Get("Location") != "/?view=capabilities&github=created" {
		e.t.Fatalf("callback: %d %s", status, header.Get("Location"))
	}
}

// credentials are what a runtime sets up gh with.
func (e *env) credentials() (int, map[string]any) {
	e.t.Helper()
	status, out, _ := e.do("GET", "/forge/credentials", true, nil)
	return status, out
}

func token(credentials map[string]any) string {
	return credentials["token"].(string)
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
	if permissions["contents"] != "write" || permissions["issues"] != "write" || permissions["workflows"] != "write" {
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

func TestCreatedButNotInstalled(t *testing.T) {
	e := newEnv(t)
	e.connect("new-app")
	_, status, _ := e.do("GET", "/api/forge/v1/github", false, nil)
	app := status["app"].(map[string]any)
	if status["state"] != "not_installed" ||
		app["install_url"] != "https://github.com/apps/axp-new/installations/new" ||
		app["settings_url"] != "https://github.com/settings/apps/axp-new" {
		t.Fatalf("status: %v", status)
	}
	info, err := os.Stat(filepath.Join(e.gh.StateDir, "github.pem"))
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("key: %v %v", info, err)
	}
}

func TestInstalled(t *testing.T) {
	e := newEnv(t)
	e.connect("installed-app")
	_, status, _ := e.do("GET", "/api/forge/v1/github?fresh=1", false, nil)
	if status["state"] != "ready" {
		t.Fatalf("status: %v", status)
	}
	seen := map[string]string{}
	for _, raw := range status["installations"].([]any) {
		inst := raw.(map[string]any)
		seen[inst["account"].(string)] = fmt.Sprint(inst["repository_selection"], inst["repositories"])
	}
	if seen["akarachen"] != "selected[akarachen/axp akarachen/notes]" || seen["acme"] != "all[acme/web acme/api]" {
		t.Fatalf("installations: %v", seen)
	}
}

func TestACallbackNeedsAFreshState(t *testing.T) {
	e := newEnv(t)
	_, _, header := e.do("GET", "/api/forge/v1/github/manifest/callback?code=installed-app&state=forged", false, nil)
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
	e.connect("new-app")
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
	e.connect("new-app")
	emulator.deleteApp(newApp)
	t.Cleanup(func() {
		emulator.mu.Lock()
		delete(emulator.deletedApps, newApp)
		emulator.mu.Unlock()
	})
	_, status, _ := e.do("GET", "/api/forge/v1/github?fresh=1", false, nil)
	if status["state"] != "error" || status["error"].(map[string]any)["code"] != "GITHUB_APP_GONE" {
		t.Fatalf("status: %v", status)
	}
}

func TestEverythingSaysHowToConnectFirst(t *testing.T) {
	e := newEnv(t)
	if status, out := e.credentials(); status != 409 || !strings.Contains(errorMessage(out), "能力") {
		t.Errorf("credentials: %d %v", status, out)
	}
	result := e.openPullRequest(map[string]any{"repository": "a/b", "head": "x", "title": "t"})
	if !result.IsError || !strings.Contains(text(result), "能力") {
		t.Fatalf("tool: %v", text(result))
	}
}

func TestRoutesNeedTheGatewayHeader(t *testing.T) {
	e := newEnv(t)
	for _, path := range []string{"/forge/credentials", "/forge/mcp"} {
		if status, _, _ := e.do("GET", path, false, nil); status != 401 {
			t.Errorf("%s: %d", path, status)
		}
	}
}

func TestCredentialsNeedTheAppInstalled(t *testing.T) {
	e := newEnv(t)
	e.connect("new-app")
	if status, out := e.credentials(); status != 409 || errorCode(out) != "GITHUB_NOT_INSTALLED" {
		t.Fatalf("credentials: %d %v", status, out)
	}
}

func TestCredentialsCarryEverythingGranted(t *testing.T) {
	e := newEnv(t)
	e.connect("installed-app")
	before := len(emulator.issuedTokens(t))
	_, out := e.credentials()
	tokens := emulator.issuedTokens(t)[before:]
	// The installation on the App's owner, with every repository it was
	// granted.
	if len(tokens) != 1 || tokens[0]["account"].(map[string]any)["login"] != "akarachen" ||
		tokens[0]["repository_selection"] != "selected" || !strings.HasPrefix(token(out), "ghs_") {
		t.Fatalf("token: %v %v", tokens, out)
	}
	if got := fmt.Sprint(tokens[0]["permissions"]); got != fmt.Sprint(seedPermissions) {
		t.Errorf("permissions: %s", got)
	}
	// Cached until close to expiry.
	if _, again := e.credentials(); token(again) != token(out) || len(emulator.issuedTokens(t)) != before+1 {
		t.Fatalf("again: %v", again)
	}
}

func TestOpenPullRequestAsTheAppsBot(t *testing.T) {
	e := newEnv(t)
	e.connect("installed-app")
	_, credentials := e.credentials()
	emulator.push(t, token(credentials), "akarachen/axp", "feature")

	result := e.openPullRequest(map[string]any{
		"repository": "git@github.com:akarachen/axp.git", "head": "feature", "title": "Add feature", "body": "Why",
	})
	var pull map[string]any
	if err := json.Unmarshal([]byte(text(result)), &pull); err != nil || result.IsError {
		t.Fatalf("result: %v", text(result))
	}
	if pull["created"] != true || !strings.HasSuffix(pull["url"].(string), "/akarachen/axp/pull/1") {
		t.Fatalf("pull: %v", pull)
	}
	// On GitHub, by the App's bot, into the default branch.
	req, _ := http.NewRequest(http.MethodGet, emulator.backend+"/repos/akarachen/axp/pulls/1", nil)
	req.Header.Set("Authorization", "Bearer "+token(credentials))
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	var created struct {
		User struct{ Login string } `json:"user"`
		Base struct{ Ref string }   `json:"base"`
	}
	_ = json.NewDecoder(resp.Body).Decode(&created)
	resp.Body.Close()
	if created.User.Login != "axp-test[bot]" || created.Base.Ref != "main" {
		t.Fatalf("pull on GitHub: %+v", created)
	}

	// The open pull request for the branch comes back instead of an error.
	again := e.openPullRequest(map[string]any{"repository": "akarachen/axp", "head": "feature", "title": "x"})
	if !strings.Contains(text(again), `"created":false`) || !strings.Contains(text(again), "/pull/1") {
		t.Fatalf("again: %v", text(again))
	}
	same := e.openPullRequest(map[string]any{"repository": "akarachen/axp", "head": "main", "title": "x"})
	if !same.IsError || !strings.Contains(text(same), "GitHub 拒绝创建 PR") {
		t.Fatalf("same branch: %v", text(same))
	}

	// The bot exists once the App has acted; commits are made as it.
	_, credentials = e.credentials()
	identity := credentials["identity"].(map[string]any)
	if identity["name"] != "axp-test[bot]" || !strings.HasSuffix(identity["email"].(string), "+axp-test[bot]@users.noreply.github.com") {
		t.Fatalf("identity: %v", identity)
	}
}
