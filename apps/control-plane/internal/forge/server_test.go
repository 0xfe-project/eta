package forge

import (
	"bytes"
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
	"time"

	"github.com/akarachen/axp/apps/control-plane/internal/github"
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
	gh.APIURL, gh.OAuthURL = emulator.URL, emulator.URL
	forge := New(gh, slog.New(slog.NewTextHandler(io.Discard, nil)))
	// The control plane serves these on different listeners.
	mux := http.NewServeMux()
	mux.Handle("/api/forge/", forge.Public())
	mux.Handle("/forge/", forge.Runtime())
	srv := httptest.NewServer(mux)
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
	if status != 303 || header.Get("Location") != "/?settings=connections&github=created" {
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
	return e.callTool("open_pull_request", args)
}

func (e *env) callTool(name string, args map[string]any) *mcp.CallToolResult {
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
	result, err := session.CallTool(ctx, &mcp.CallToolParams{Name: name, Arguments: args})
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
		fmt.Sprint(manifest["callback_urls"]) != "["+origin+github.CallbackPath+"]" ||
		manifest["request_oauth_on_install"] != true || manifest["public"] != true || manifest["setup_url"] != nil ||
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
	for _, name := range []string{"github.pem", "github.secret"} {
		info, err := os.Stat(filepath.Join(e.gh.StateDir, name))
		if err != nil || info.Mode().Perm() != 0o600 {
			t.Fatalf("%s: %v %v", name, info, err)
		}
	}
	if status["oauth"] != true || status["user"] != nil {
		t.Fatalf("authorization: %v", status)
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
	if status, out := e.credentials(); status != 409 || !strings.Contains(errorMessage(out), "设置 → 连接") {
		t.Errorf("credentials: %d %v", status, out)
	}
	result := e.openPullRequest(map[string]any{"repository": "a/b", "head": "x", "title": "t"})
	if !result.IsError || !strings.Contains(text(result), "设置 → 连接") {
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
	if pull["created"] != true || !strings.HasSuffix(pull["url"].(string), "/akarachen/axp/pull/1") ||
		pull["author"] != "axp-test[bot]" {
		t.Fatalf("pull: %v", pull)
	}
	// The transcript links the call to it.
	if ref := result.Meta["axp/ref"]; fmt.Sprint(ref) != fmt.Sprintf("map[kind:pull_request number:1 title:Add feature url:%s]", pull["url"]) {
		t.Fatalf("ref: %v", ref)
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
	if _, titled := again.Meta["axp/ref"].(map[string]any)["title"]; titled {
		t.Fatalf("an open one found has its own title: %v", again.Meta)
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

// authorize runs the browser's side of the user authorizing the App, as
// login, through GitHub's redirect; it returns where the browser ends up.
func (e *env) authorize(login string) string {
	e.t.Helper()
	status, out, _ := e.do("POST", "/api/forge/v1/github/authorization", false, map[string]any{"origin": origin})
	if status != 200 {
		e.t.Fatalf("authorization: %d %v", status, out)
	}
	authorize, _ := url.Parse(out["url"].(string))
	q := authorize.Query()
	if q.Get("redirect_uri") != origin+github.CallbackPath || q.Get("code_challenge_method") != "S256" || q.Get("client_id") != "Iv1.axp-test" {
		e.t.Fatalf("authorize url: %s", authorize)
	}
	return e.returnFromGitHub(url.Values{"login": {login}, "redirect_uri": {q.Get("redirect_uri")}, "state": {q.Get("state")}})
}

// returnFromGitHub has emulate's GitHub authorize and follows its redirect
// back to the service.
func (e *env) returnFromGitHub(form url.Values) string {
	e.t.Helper()
	client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	resp, err := client.PostForm(emulator.URL+"/login/oauth/callback", form)
	if err != nil {
		e.t.Fatal(err)
	}
	resp.Body.Close()
	back, _ := url.Parse(resp.Header.Get("Location"))
	_, _, header := e.do("GET", back.Path+"?"+back.RawQuery, false, nil)
	return header.Get("Location")
}

func (e *env) user() map[string]any {
	e.t.Helper()
	data, err := os.ReadFile(filepath.Join(e.gh.StateDir, "user.json"))
	if err != nil {
		return nil
	}
	var user map[string]any
	_ = json.Unmarshal(data, &user)
	return user
}

func (e *env) pull(args map[string]any) map[string]any {
	e.t.Helper()
	result := e.openPullRequest(args)
	var pull map[string]any
	if err := json.Unmarshal([]byte(text(result)), &pull); err != nil || result.IsError {
		e.t.Fatalf("result: %v", text(result))
	}
	return pull
}

func TestOpenPullRequestOnBehalfOfTheUser(t *testing.T) {
	e := newEnv(t)
	e.connect("installed-app")
	if location := e.authorize("akarachen"); location != "/?settings=connections&github=authorized" {
		t.Fatalf("location: %s", location)
	}
	_, status, _ := e.do("GET", "/api/forge/v1/github", false, nil)
	if status["user"].(map[string]any)["login"] != "akarachen" {
		t.Fatalf("status: %v", status)
	}
	user := e.user()
	info, _ := os.Stat(filepath.Join(e.gh.StateDir, "user.json"))
	if user["refresh_token"] == "" || user["expires_at"] == nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("user.json: %v %v", user, info.Mode())
	}

	_, credentials := e.credentials()
	emulator.push(t, token(credentials), "akarachen/axp", "by-user")
	pull := e.pull(map[string]any{"repository": "akarachen/axp", "head": "by-user", "title": "As the user"})
	if pull["author"] != "akarachen" || pull["created"] != true {
		t.Fatalf("pull: %v", pull)
	}
}

func TestAnExpiredTokenIsRefreshedOnce(t *testing.T) {
	e := newEnv(t)
	e.connect("installed-app")
	e.authorize("akarachen")
	before := e.user()
	later := time.Now().Add(8 * time.Hour)
	e.gh.Now = func() time.Time { return later }

	_, credentials := e.credentials()
	emulator.push(t, token(credentials), "akarachen/axp", "after-refresh")
	pull := e.pull(map[string]any{"repository": "akarachen/axp", "head": "after-refresh", "title": "Later"})
	after := e.user()
	if pull["author"] != "akarachen" || after["access_token"] == before["access_token"] || after["refresh_token"] == before["refresh_token"] {
		t.Fatalf("pull %v, user %v → %v", pull, before, after)
	}
}

func TestARevokedAuthorizationFallsBackToTheBot(t *testing.T) {
	e := newEnv(t)
	e.connect("installed-app")
	e.authorize("akarachen")
	emulator.revoke(e.user()["access_token"].(string))

	_, credentials := e.credentials()
	emulator.push(t, token(credentials), "akarachen/axp", "after-revoke")
	pull := e.pull(map[string]any{"repository": "akarachen/axp", "head": "after-revoke", "title": "Revoked"})
	if pull["author"] != "axp-test[bot]" {
		t.Fatalf("pull: %v", pull)
	}
	if _, status, _ := e.do("GET", "/api/forge/v1/github", false, nil); status["user"] != nil || e.user() != nil {
		t.Fatalf("still authorized: %v", status)
	}
}

func TestAuthorizingWhileInstalling(t *testing.T) {
	e := newEnv(t)
	e.connect("installed-app")
	// GitHub sends no state after an installation, only setup_action.
	location := e.returnFromGitHub(url.Values{"login": {"akarachen"}, "redirect_uri": {origin + github.CallbackPath + "?installation_id=100&setup_action=install"}})
	if location != "/?settings=connections&github=authorized" || e.user()["login"] != "akarachen" {
		t.Fatalf("location %s, user %v", location, e.user())
	}
}

func TestAnAuthorizationNeedsItsStateAndTheApp(t *testing.T) {
	e := newEnv(t)
	e.connect("installed-app")
	// Neither AXP's state nor an installation.
	location := e.returnFromGitHub(url.Values{"login": {"akarachen"}, "redirect_uri": {origin + github.CallbackPath}})
	if !strings.Contains(location, "github_error=") || e.user() != nil {
		t.Fatalf("stateless: %s", location)
	}
	// Someone who reaches no installation of the App.
	if location := e.authorize("stranger"); !strings.Contains(location, "github_error=") || e.user() != nil {
		t.Fatalf("stranger: %s", location)
	}
	// Declined on GitHub.
	_, _, header := e.do("GET", github.CallbackPath+"?error=access_denied&error_description=denied&state=x", false, nil)
	if !strings.Contains(header.Get("Location"), "github_error=") {
		t.Fatalf("declined: %s", header.Get("Location"))
	}
}

func TestAnAppWithoutItsClientSecret(t *testing.T) {
	e := newEnv(t)
	e.connect("installed-app")
	// An App connected before AXP kept the secret.
	_ = os.Remove(filepath.Join(e.gh.StateDir, "github.secret"))
	if status, out, _ := e.do("POST", "/api/forge/v1/github/authorization", false, map[string]any{"origin": origin}); status != 409 || errorCode(out) != "OAUTH_NOT_CONFIGURED" {
		t.Fatalf("authorize: %d %v", status, out)
	}
	if status, out, _ := e.do("POST", "/api/forge/v1/github/oauth-client", false, map[string]any{"client_id": "Iv1.axp-test", "client_secret": ""}); status != 400 {
		t.Fatalf("empty secret: %d %v", status, out)
	}
	if status, _, _ := e.do("POST", "/api/forge/v1/github/oauth-client", false, map[string]any{"client_id": "Iv1.axp-test", "client_secret": "secret-axp-test"}); status != 204 {
		t.Fatalf("oauth client: %d", status)
	}
	if location := e.authorize("akarachen"); location != "/?settings=connections&github=authorized" {
		t.Fatalf("location: %s", location)
	}
}

func TestUnauthorizingRevokesOnGitHub(t *testing.T) {
	e := newEnv(t)
	e.connect("installed-app")
	e.authorize("akarachen")
	access := e.user()["access_token"].(string)
	if status, _, _ := e.do("DELETE", "/api/forge/v1/github/authorization", false, nil); status != 204 || e.user() != nil {
		t.Fatalf("delete: %d", status)
	}
	emulator.mu.Lock()
	revoked := emulator.revoked[access]
	emulator.mu.Unlock()
	if !revoked {
		t.Fatal("not revoked on GitHub")
	}
	// Disconnecting forgets an authorization too.
	e.authorize("akarachen")
	e.do("DELETE", "/api/forge/v1/github", false, nil)
	if e.user() != nil {
		t.Fatal("user.json kept")
	}
}

// createRepository creates a private repository in the user's account with
// token, as `gh repo create` does; it returns GitHub's status and the owner.
func createRepository(t *testing.T, token, name string) (int, string) {
	t.Helper()
	data, _ := json.Marshal(map[string]any{"name": name, "private": true})
	req, _ := http.NewRequest(http.MethodPost, emulator.URL+"/user/repos", bytes.NewReader(data))
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var repo struct {
		Owner struct{ Login string } `json:"owner"`
	}
	_ = json.NewDecoder(resp.Body).Decode(&repo)
	return resp.StatusCode, repo.Owner.Login
}

// Agents in runtimes and remote computers get the same credentials: the
// App's bot until the user authorizes the App, then the user, so what
// GitHub allows only a user, such as creating a repository in their
// account, works for agents too.
func TestEveryCallerActsAsTheUserWhoAuthorized(t *testing.T) {
	e := newEnv(t)
	e.connect("installed-app")
	callers := map[string]string{"agent": "agent-1", "remote computer": "computer-1"}
	get := func(caller string) map[string]any {
		req, _ := http.NewRequest("GET", e.server.URL+"/forge/credentials", nil)
		req.Header.Set(agentHeader, caller)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		var out map[string]any
		_ = json.NewDecoder(resp.Body).Decode(&out)
		return out
	}

	for who, caller := range callers {
		out := get(caller)
		if !strings.HasPrefix(token(out), "ghs_") || out["user"] != nil {
			t.Fatalf("%s before authorizing: %v", who, out)
		}
		if status, _ := createRepository(t, token(out), "by-the-bot"); status != http.StatusForbidden {
			t.Fatalf("%s: the bot created a repository in the user's account: %d", who, status)
		}
	}

	e.authorize("akarachen")
	for who, caller := range callers {
		out := get(caller)
		if out["user"] != "akarachen" || out["token"] != e.user()["access_token"] {
			t.Fatalf("%s after authorizing: %v", who, out)
		}
		// Asked for again within the hour, so revoking in AXP takes effect.
		if left := int64(out["expires_at"].(float64)) - time.Now().Unix(); left > 3600 || left < 3500 {
			t.Fatalf("%s: token for %ds", who, left)
		}
		// The commit author stays the App's bot.
		if out["identity"].(map[string]any)["name"] != "axp-test[bot]" {
			t.Fatalf("%s identity: %v", who, out["identity"])
		}
	}
	// The ?as=user of older callers changes nothing.
	if status, out, _ := e.do("GET", "/forge/credentials?as=user", true, nil); status != 200 || out["user"] != "akarachen" {
		t.Fatalf("as=user: %d %v", status, out)
	}

	user := get("agent-1")
	emulator.push(t, token(user), "akarachen/axp", "pushed-as-user")
	if status, owner := createRepository(t, token(user), "made-by-an-agent"); status != http.StatusCreated || owner != "akarachen" {
		t.Fatalf("create as the user: %d %s", status, owner)
	}

	// Unauthorizing in AXP: the next ask gets the bot again.
	e.do("DELETE", "/api/forge/v1/github/authorization", false, nil)
	if out := get("agent-1"); !strings.HasPrefix(token(out), "ghs_") || out["user"] != nil {
		t.Fatalf("after unauthorizing: %v", out)
	}
}
