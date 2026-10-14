package forge

// The tests talk to GitHub as emulated by emulate (vercel-labs/emulate, an
// apps/forge-service dev dependency): App JWTs, installation tokens with
// their permission and repository checks, branches and pull requests are
// its real, stateful behaviour. A thin layer in front adds what it lacks or
// does differently from GitHub, and passes everything else through:
//
//   - POST /app-manifests/{code}/conversions returns a seeded App;
//   - GET /installation/repositories answers from the seed;
//   - a second pull request for the same head is refused with 422;
//   - an App deleted on GitHub gets 401;
//   - the user's authorization of an App: emulate's OAuth issues the token,
//     the layer checks the App's client secret, adds the expiry and refresh
//     token GitHub Apps get and refreshes them, answers
//     GET /user/installations from the seed, and revokes on
//     DELETE /applications/{client_id}/grant (the token then gets 401);
//   - a merge can be made to fail the way GitHub and networks do
//     (mergeFault), and who called it is recorded (mergers);
//   - a repository's permissions, which emulate always reports as all
//     true, can be made GitHub's for a test (setRepoPermissions): all false
//     for an installation token, the user's own for the user's token;
//   - an installation token cannot create a repository in a user's account
//     (POST /user/repos gets 403, as GitHub answers an App installed on a
//     personal account even with administration: write); the user's token
//     can.

import (
	"bytes"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/http/httputil"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// Seeded Apps: one created but not installed, one installed on akarachen
// (selected repositories) and acme (all repositories).
const (
	newApp       = 77
	installedApp = 78
)

var seedRepos = map[string][]string{
	"akarachen": {"axp", "notes", "secret"},
	"acme":      {"web", "api"},
}

type seedInstallation struct {
	id, app   int
	account   string
	selection string
	repos     []string // for "selected"
}

var seedInstallations = []seedInstallation{
	{id: 100, app: installedApp, account: "akarachen", selection: "selected", repos: []string{"axp", "notes"}},
	{id: 101, app: installedApp, account: "acme", selection: "all"},
}

// emulator is the shared GitHub of this package's tests.
var emulator *githubEmulator

func TestMain(m *testing.M) {
	var err error
	emulator, err = startEmulator()
	if err != nil {
		fmt.Fprintln(os.Stderr, "emulate:", err)
		os.Exit(1)
	}
	code := m.Run()
	emulator.stop()
	os.Exit(code)
}

type githubEmulator struct {
	URL     string // the front: what the service under test calls
	backend string
	pem     string
	cmd     *exec.Cmd
	front   *httptest.Server
	dir     string

	mu          sync.Mutex
	tokens      map[string]int // installation token -> installation id
	pullHeads   map[string]bool
	deletedApps map[int]bool
	refresh     map[string]string          // refresh token -> login
	revoked     map[string]bool            // user tokens
	mergeFaults map[string]string          // merge path -> fault
	merges      map[string][]string        // merge path -> "app" or "user", per call
	repoPerms   map[string]map[string]bool // owner/name -> the user's permissions
}

func startEmulator() (*githubEmulator, error) {
	bin, err := filepath.Abs("../../node_modules/.bin/emulate")
	if err != nil {
		return nil, err
	}
	if _, err := os.Stat(bin); err != nil {
		return nil, fmt.Errorf("%s not found; run `bun install`", bin)
	}
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		return nil, err
	}
	keyPEM := string(pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(key)}))
	dir, err := os.MkdirTemp("", "forge-emulate")
	if err != nil {
		return nil, err
	}
	seed := filepath.Join(dir, "seed.json")
	if err := os.WriteFile(seed, seedConfig(keyPEM), 0o600); err != nil {
		return nil, err
	}
	port, err := freePort()
	if err != nil {
		return nil, err
	}
	e := &githubEmulator{
		backend: fmt.Sprintf("http://127.0.0.1:%d", port), pem: keyPEM, dir: dir,
		tokens: map[string]int{}, pullHeads: map[string]bool{}, deletedApps: map[int]bool{},
		refresh: map[string]string{}, revoked: map[string]bool{}, mergeFaults: map[string]string{},
		merges: map[string][]string{}, repoPerms: map[string]map[string]bool{},
	}
	e.cmd = exec.Command(bin, "--service", "github", "--port", fmt.Sprint(port), "--seed", seed)
	var logs bytes.Buffer
	e.cmd.Stdout, e.cmd.Stderr = &logs, &logs
	if err := e.cmd.Start(); err != nil {
		return nil, err
	}
	deadline := time.Now().Add(30 * time.Second)
	for {
		resp, err := http.Get(e.backend + "/rate_limit")
		if err == nil {
			resp.Body.Close()
			break
		}
		if time.Now().After(deadline) {
			e.stop()
			return nil, fmt.Errorf("did not start: %s", logs.String())
		}
		time.Sleep(100 * time.Millisecond)
	}
	e.front = httptest.NewServer(e.handler())
	e.URL = e.front.URL
	return e, nil
}

func (e *githubEmulator) stop() {
	if e.front != nil {
		e.front.Close()
	}
	if e.cmd != nil && e.cmd.Process != nil {
		_ = e.cmd.Process.Kill()
		_ = e.cmd.Wait()
	}
	_ = os.RemoveAll(e.dir)
}

func freePort() (int, error) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, err
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port, nil
}

// seedPermissions is what the seeded Apps' installations were granted.
var seedPermissions = map[string]string{
	"contents": "write", "issues": "write", "metadata": "read", "pull_requests": "write", "workflows": "write",
}

func seedConfig(keyPEM string) []byte {
	var repos []map[string]any
	for owner, names := range seedRepos {
		for _, name := range names {
			repos = append(repos, map[string]any{"owner": owner, "name": name, "private": true})
		}
	}
	app := func(id int, slug string) map[string]any {
		var installations []map[string]any
		for _, inst := range seedInstallations {
			if inst.app != id {
				continue
			}
			entry := map[string]any{
				"installation_id": inst.id, "account": inst.account,
				"repository_selection": inst.selection, "permissions": seedPermissions,
			}
			if inst.selection == "selected" {
				entry["repositories"] = inst.repos
			}
			installations = append(installations, entry)
		}
		return map[string]any{
			"app_id": id, "slug": slug, "name": slug, "private_key": keyPEM,
			"permissions": seedPermissions, "installations": installations,
		}
	}
	data, _ := json.Marshal(map[string]any{"github": map[string]any{
		"users": []map[string]any{{"login": "akarachen"}, {"login": "stranger"}},
		"orgs":  []map[string]any{{"login": "acme", "members": []map[string]any{{"login": "akarachen", "role": "admin"}}}},
		"repos": repos,
		"apps":  []map[string]any{app(newApp, "axp-new"), app(installedApp, "axp-test")},
	}})
	return data
}

// appOfManifest maps the code GitHub would send back to the App it created.
var appOfManifest = map[string]struct {
	id   int
	slug string
}{
	"new-app":       {newApp, "axp-new"},
	"installed-app": {installedApp, "axp-test"},
}

func (e *githubEmulator) handler() http.Handler {
	backend, _ := url.Parse(e.backend)
	proxy := httputil.NewSingleHostReverseProxy(backend)
	proxy.ModifyResponse = func(resp *http.Response) error {
		// Remember which installation each minted token belongs to.
		req := resp.Request
		if req.Method == http.MethodPost && strings.HasSuffix(req.URL.Path, "/access_tokens") && resp.StatusCode == http.StatusCreated {
			raw, err := io.ReadAll(resp.Body)
			if err != nil {
				return err
			}
			resp.Body = io.NopCloser(bytes.NewReader(raw))
			var token struct {
				Token string `json:"token"`
			}
			_ = json.Unmarshal(raw, &token)
			var id int
			fmt.Sscanf(strings.Split(req.URL.Path, "/")[3], "%d", &id)
			e.mu.Lock()
			e.tokens[token.Token] = id
			e.mu.Unlock()
		}
		if req.Method == http.MethodGet && resp.StatusCode == http.StatusOK && strings.Count(req.URL.Path, "/") == 3 && strings.HasPrefix(req.URL.Path, "/repos/") {
			return e.repoPermissions(resp)
		}
		return nil
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Path
		e.mu.Lock()
		revoked := e.revoked[strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")]
		e.mu.Unlock()
		switch {
		case revoked:
			reply(w, http.StatusUnauthorized, map[string]any{"message": "Bad credentials"})
			return
		case r.Method == http.MethodPost && path == "/login/oauth/access_token":
			e.accessToken(w, r)
			return
		case r.Method == http.MethodGet && path == "/user/installations":
			e.userInstallations(w, r)
			return
		case r.Method == http.MethodDelete && strings.HasPrefix(path, "/applications/"):
			e.revokeGrant(w, r)
			return
		case r.Method == http.MethodPost && strings.HasPrefix(path, "/app-manifests/"):
			e.convertManifest(w, strings.Split(path, "/")[2])
			return
		case path == "/installation/repositories":
			e.installationRepositories(w, r)
			return
		case strings.HasPrefix(path, "/app/") && e.appDeleted(r):
			reply(w, http.StatusUnauthorized, map[string]any{"message": "Bad credentials"})
			return
		case r.Method == http.MethodPut && strings.HasSuffix(path, "/merge") && e.mergeFault(w, r, proxy):
			return
		case r.Method == http.MethodPost && path == "/user/repos" && e.installationToken(r):
			reply(w, http.StatusForbidden, map[string]any{"message": "Resource not accessible by integration"})
			return
		case r.Method == http.MethodPost && strings.HasSuffix(path, "/pulls"):
			if e.duplicatePull(w, r) {
				return
			}
		}
		proxy.ServeHTTP(w, r)
	})
}

func (e *githubEmulator) convertManifest(w http.ResponseWriter, code string) {
	app, ok := appOfManifest[code]
	if !ok {
		reply(w, http.StatusNotFound, map[string]any{"message": "Not Found"})
		return
	}
	reply(w, http.StatusCreated, map[string]any{
		"id": app.id, "slug": app.slug, "name": app.slug,
		"client_id": "Iv1." + app.slug, "client_secret": "secret-" + app.slug,
		"html_url": "https://github.com/apps/" + app.slug,
		"owner":    map[string]any{"login": "akarachen", "type": "User"},
		"pem":      e.pem,
	})
}

// accessToken is GitHub's token endpoint for an App's user authorization:
// a code (exchanged by emulate) or a refresh token, which works once.
func (e *githubEmulator) accessToken(w http.ResponseWriter, r *http.Request) {
	_ = r.ParseForm()
	slug := strings.TrimPrefix(r.PostForm.Get("client_id"), "Iv1.")
	if r.PostForm.Get("client_secret") != "secret-"+slug {
		reply(w, http.StatusOK, map[string]any{"error": "incorrect_client_credentials"})
		return
	}
	code := r.PostForm.Get("code")
	var login string
	if r.PostForm.Get("grant_type") == "refresh_token" {
		e.mu.Lock()
		login = e.refresh[r.PostForm.Get("refresh_token")]
		delete(e.refresh, r.PostForm.Get("refresh_token"))
		e.mu.Unlock()
		if login == "" {
			reply(w, http.StatusOK, map[string]any{"error": "bad_refresh_token"})
			return
		}
		code = e.authorizationCode(login)
	}
	resp, err := http.PostForm(e.backend+"/login/oauth/access_token", url.Values{"code": {code}})
	if err != nil {
		reply(w, http.StatusBadGateway, nil)
		return
	}
	defer resp.Body.Close()
	var out map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&out)
	if token, ok := out["access_token"].(string); ok {
		if login == "" {
			login = e.login(token)
		}
		refresh := "ghr_" + base64.RawURLEncoding.EncodeToString([]byte(fmt.Sprint(time.Now().UnixNano())))
		e.mu.Lock()
		e.refresh[refresh] = login
		e.mu.Unlock()
		out["expires_in"], out["refresh_token"], out["refresh_token_expires_in"] = 28800, refresh, 15897600
	}
	reply(w, http.StatusOK, out)
}

// authorizationCode is the code emulate gives when login authorizes.
func (e *githubEmulator) authorizationCode(login string) string {
	client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	resp, err := client.PostForm(e.backend+"/login/oauth/callback", url.Values{"login": {login}, "redirect_uri": {"http://localhost/"}})
	if err != nil {
		return ""
	}
	resp.Body.Close()
	location, _ := url.Parse(resp.Header.Get("Location"))
	return location.Query().Get("code")
}

func (e *githubEmulator) login(token string) string {
	req, _ := http.NewRequest(http.MethodGet, e.backend+"/user", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return ""
	}
	defer resp.Body.Close()
	var user struct{ Login string }
	_ = json.NewDecoder(resp.Body).Decode(&user)
	return user.Login
}

// userInstallations are the seeded installations on the token's user and
// the organizations they belong to (akarachen is acme's admin).
func (e *githubEmulator) userInstallations(w http.ResponseWriter, r *http.Request) {
	login := e.login(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "))
	if login == "" {
		reply(w, http.StatusUnauthorized, map[string]any{"message": "Bad credentials"})
		return
	}
	installations := []map[string]any{}
	for _, inst := range seedInstallations {
		if inst.account == login || (inst.account == "acme" && login == "akarachen") {
			installations = append(installations, map[string]any{
				"id": inst.id, "app_id": inst.app, "account": map[string]any{"login": inst.account},
			})
		}
	}
	reply(w, http.StatusOK, map[string]any{"total_count": len(installations), "installations": installations})
}

func (e *githubEmulator) revokeGrant(w http.ResponseWriter, r *http.Request) {
	clientID, secret, _ := r.BasicAuth()
	var body struct {
		AccessToken string `json:"access_token"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	if secret != "secret-"+strings.TrimPrefix(clientID, "Iv1.") || body.AccessToken == "" {
		reply(w, http.StatusUnauthorized, map[string]any{"message": "Bad credentials"})
		return
	}
	e.revoke(body.AccessToken)
	w.WriteHeader(http.StatusNoContent)
}

// revoke makes GitHub refuse a user token, as when the user revokes the
// App's authorization.
func (e *githubEmulator) installationToken(r *http.Request) bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	_, ok := e.tokens[strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")]
	return ok
}

func (e *githubEmulator) revoke(token string) {
	e.mu.Lock()
	e.revoked[token] = true
	e.mu.Unlock()
}

func (e *githubEmulator) installationRepositories(w http.ResponseWriter, r *http.Request) {
	e.mu.Lock()
	id, ok := e.tokens[strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")]
	e.mu.Unlock()
	if !ok {
		reply(w, http.StatusUnauthorized, map[string]any{"message": "Bad credentials"})
		return
	}
	for _, inst := range seedInstallations {
		if inst.id != id {
			continue
		}
		names := inst.repos
		if inst.selection == "all" {
			names = seedRepos[inst.account]
		}
		var repos []map[string]any
		for _, name := range names {
			repos = append(repos, map[string]any{"full_name": inst.account + "/" + name})
		}
		reply(w, http.StatusOK, map[string]any{"total_count": len(repos), "repositories": repos})
		return
	}
	reply(w, http.StatusNotFound, map[string]any{"message": "Not Found"})
}

// appDeleted tells whether the JWT names an App the test deleted on GitHub.
func (e *githubEmulator) appDeleted(r *http.Request) bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	for id := range e.deletedApps {
		if strings.Contains(jwtIssuer(r), fmt.Sprint(id)) {
			return true
		}
	}
	return false
}

func jwtIssuer(r *http.Request) string {
	parts := strings.Split(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "), ".")
	if len(parts) != 3 {
		return ""
	}
	payload, _ := base64.RawURLEncoding.DecodeString(parts[1])
	var claims struct {
		Iss string `json:"iss"`
	}
	_ = json.Unmarshal(payload, &claims)
	return claims.Iss
}

// duplicatePull refuses a second pull request for a head, as GitHub does
// and emulate does not.
func (e *githubEmulator) duplicatePull(w http.ResponseWriter, r *http.Request) bool {
	raw, _ := io.ReadAll(r.Body)
	r.Body = io.NopCloser(bytes.NewReader(raw))
	var body struct {
		Head string `json:"head"`
	}
	_ = json.Unmarshal(raw, &body)
	key := r.URL.Path + " " + body.Head
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.pullHeads[key] {
		owner := strings.Split(r.URL.Path, "/")[2]
		reply(w, http.StatusUnprocessableEntity, map[string]any{"message": "Validation Failed", "errors": []any{map[string]any{
			"message": "A pull request already exists for " + owner + ":" + body.Head + ".",
		}}})
		return true
	}
	e.pullHeads[key] = true
	return false
}

// Merge faults, for the next merge of a pull request:
//
//   - stale: someone pushed in between; GitHub answers 409;
//   - lost: GitHub merges, the connection drops before the answer;
//   - failed: GitHub answers 502 without merging;
//   - forbidden: GitHub refuses the token's merge with 403.
const (
	faultStale     = "stale"
	faultLost      = "lost"
	faultFailed    = "failed"
	faultForbidden = "forbidden"
)

func (e *githubEmulator) failMerge(repo string, number int, fault string) {
	e.mu.Lock()
	e.mergeFaults[fmt.Sprintf("/repos/%s/pulls/%d/merge", repo, number)] = fault
	e.mu.Unlock()
}

func (e *githubEmulator) mergeFault(w http.ResponseWriter, r *http.Request, proxy http.Handler) bool {
	e.mu.Lock()
	fault := e.mergeFaults[r.URL.Path]
	delete(e.mergeFaults, r.URL.Path)
	merger := "user"
	if _, ok := e.tokens[strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")]; ok {
		merger = "app"
	}
	e.merges[r.URL.Path] = append(e.merges[r.URL.Path], merger)
	e.mu.Unlock()
	switch fault {
	case faultForbidden:
		reply(w, http.StatusForbidden, map[string]any{"message": "Resource not accessible by integration"})
	case faultStale:
		reply(w, http.StatusConflict, map[string]any{"message": "Head branch was modified. Review and try the merge again."})
	case faultFailed:
		reply(w, http.StatusBadGateway, map[string]any{"message": "Server Error"})
	case faultLost:
		proxy.ServeHTTP(httptest.NewRecorder(), r)
		conn, _, err := w.(http.Hijacker).Hijack()
		if err == nil {
			conn.Close()
		}
	default:
		return false
	}
	return true
}

// mergers is who called GitHub's merge of a pull request, in order.
func (e *githubEmulator) mergers(repo string, number int) []string {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.merges[fmt.Sprintf("/repos/%s/pulls/%d/merge", repo, number)]
}

// setRepoPermissions has GitHub report repo's permissions as it does for
// the rest of the test: the user's are perms, an installation token's all
// false.
func (e *githubEmulator) setRepoPermissions(t *testing.T, repo string, perms map[string]bool) {
	e.mu.Lock()
	e.repoPerms[repo] = perms
	e.mu.Unlock()
	t.Cleanup(func() {
		e.mu.Lock()
		delete(e.repoPerms, repo)
		e.mu.Unlock()
	})
}

func (e *githubEmulator) repoPermissions(resp *http.Response) error {
	e.mu.Lock()
	perms, ok := e.repoPerms[strings.TrimPrefix(resp.Request.URL.Path, "/repos/")]
	_, app := e.tokens[strings.TrimPrefix(resp.Request.Header.Get("Authorization"), "Bearer ")]
	e.mu.Unlock()
	if !ok {
		return nil
	}
	if app {
		perms = map[string]bool{}
	}
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return err
	}
	var repo map[string]any
	if err := json.Unmarshal(raw, &repo); err != nil {
		return err
	}
	shown := map[string]bool{}
	for _, level := range []string{"admin", "maintain", "push", "triage", "pull"} {
		shown[level] = perms[level]
	}
	repo["permissions"] = shown
	raw, _ = json.Marshal(repo)
	resp.Body = io.NopCloser(bytes.NewReader(raw))
	resp.ContentLength = int64(len(raw))
	resp.Header.Set("Content-Length", fmt.Sprint(len(raw)))
	return nil
}

func (e *githubEmulator) deleteApp(id int) {
	e.mu.Lock()
	e.deletedApps[id] = true
	e.mu.Unlock()
}

// issuedTokens is what emulate recorded about the installation tokens it
// minted (without their values).
func (e *githubEmulator) issuedTokens(t *testing.T) []map[string]any {
	t.Helper()
	resp, err := http.Get(e.backend + "/_emulate/installation-tokens")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var out struct {
		Tokens []map[string]any `json:"installation_tokens"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	return out.Tokens
}

// push creates branch from the default branch, as a git push would, with a
// token from git's credential route.
func (e *githubEmulator) push(t *testing.T, token, repo, branch string) {
	t.Helper()
	call := func(method, path string, body any, out any) int {
		var reader io.Reader
		if body != nil {
			data, _ := json.Marshal(body)
			reader = bytes.NewReader(data)
		}
		req, _ := http.NewRequest(method, e.backend+path, reader)
		req.Header.Set("Authorization", "Bearer "+token)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		if out != nil {
			_ = json.NewDecoder(resp.Body).Decode(out)
		}
		return resp.StatusCode
	}
	var main struct {
		Object struct {
			SHA string `json:"sha"`
		} `json:"object"`
	}
	if status := call(http.MethodGet, "/repos/"+repo+"/git/ref/heads/main", nil, &main); status != http.StatusOK {
		t.Fatalf("main of %s: %d", repo, status)
	}
	if status := call(http.MethodPost, "/repos/"+repo+"/git/refs", map[string]any{"ref": "refs/heads/" + branch, "sha": main.Object.SHA}, nil); status != http.StatusCreated {
		t.Fatalf("push %s to %s: %d", branch, repo, status)
	}
}

func reply(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
