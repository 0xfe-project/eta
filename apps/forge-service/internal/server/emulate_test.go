package server

// The tests talk to GitHub as emulated by emulate (vercel-labs/emulate, an
// apps/forge-service dev dependency): App JWTs, installation tokens with
// their permission and repository checks, branches and pull requests are
// its real, stateful behaviour. A thin layer in front adds what it lacks or
// does differently from GitHub, and passes everything else through:
//
//   - POST /app-manifests/{code}/conversions returns a seeded App;
//   - GET /installation/repositories answers from the seed;
//   - a second pull request for the same head is refused with 422;
//   - an App deleted on GitHub gets 401.

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
		"users": []map[string]any{{"login": "akarachen"}},
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
		return nil
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Path
		switch {
		case r.Method == http.MethodPost && strings.HasPrefix(path, "/app-manifests/"):
			e.convertManifest(w, strings.Split(path, "/")[2])
			return
		case path == "/installation/repositories":
			e.installationRepositories(w, r)
			return
		case strings.HasPrefix(path, "/app/") && e.appDeleted(r):
			reply(w, http.StatusUnauthorized, map[string]any{"message": "Bad credentials"})
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
		"id": app.id, "slug": app.slug, "name": app.slug, "client_id": "Iv1." + app.slug,
		"html_url": "https://github.com/apps/" + app.slug,
		"owner":    map[string]any{"login": "akarachen", "type": "User"},
		"pem":      e.pem,
	})
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
