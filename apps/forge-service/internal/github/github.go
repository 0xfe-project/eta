// Package github reaches GitHub through one GitHub App, created by and
// installed for the user.
//
// The App is created from a manifest (the browser posts it to GitHub, GitHub
// sends a one-time code back) and its credentials stay in the state
// directory: github.json and the private key github.pem. Every call to
// GitHub uses either a JWT signed with that key or an installation token
// minted from it with only the permissions its purpose needs; tokens are
// cached until close to expiry. Nothing here is per agent: every agent acts
// as the App.
package github

import (
	"bytes"
	"crypto/rand"
	"crypto/rsa"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"maps"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

const (
	APIURL = "https://api.github.com"
	WebURL = "https://github.com"

	manifestTTL       = time.Hour
	tokenMargin       = 10 * time.Minute
	installationsTTL  = 30 * time.Second
	repositoriesShown = 100
)

var (
	// GitHub App names are global on GitHub and at most 34 characters.
	appName = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9 ._-]{0,33}$`)
	account = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9-]{0,38}$`)
)

// Permissions maps a GitHub App permission to "read" or "write".
type Permissions map[string]string

var (
	// What the App may ever do. Workflows are left out: agents cannot
	// change CI.
	appPermissions = Permissions{
		"contents":      "write",
		"pull_requests": "write",
		"issues":        "read",
		"actions":       "read",
		"checks":        "read",
		"statuses":      "read",
		"metadata":      "read",
	}
	// What each use gets of it.
	readOnly    = readAll(appPermissions)
	push        = Permissions{"contents": "write", "metadata": "read"}
	pullRequest = Permissions{"pull_requests": "write", "contents": "read", "metadata": "read"}
	metadata    = Permissions{"metadata": "read"}
)

func readAll(p Permissions) Permissions {
	read := Permissions{}
	for name := range p {
		read[name] = "read"
	}
	return read
}

// Error is an answer for the user or the agent, with the HTTP status it
// travels with.
type Error struct {
	Code    string
	Message string
	Status  int
}

func (e *Error) Error() string { return e.Message }

func newError(code, message string, status int) *Error {
	return &Error{Code: code, Message: message, Status: status}
}

func notConnected() *Error {
	return newError("GITHUB_NOT_CONNECTED",
		"GitHub 还没有连接。请让用户在 AXP 工作区的“能力”页按向导连接 GitHub。", http.StatusConflict)
}

func notInstalled(owner string) *Error {
	return newError("GITHUB_NOT_INSTALLED", fmt.Sprintf(
		"AXP 的 GitHub App 没有安装到 %s。请让用户在 AXP 工作区的“能力”页把 App 安装到这个账号或组织，并授权需要的仓库。",
		owner), http.StatusConflict)
}

// App is the GitHub App as saved in github.json.
type App struct {
	ID        int64  `json:"id"`
	Slug      string `json:"slug"`
	Name      string `json:"name"`
	ClientID  string `json:"client_id"`
	HTMLURL   string `json:"html_url"`
	Owner     string `json:"owner"`
	OwnerType string `json:"owner_type"` // "User" or "Organization"
	BotID     *int64 `json:"bot_id,omitempty"`
}

func (a *App) SettingsURL() string {
	if a.OwnerType == "Organization" {
		return fmt.Sprintf("%s/organizations/%s/settings/apps/%s", WebURL, a.Owner, a.Slug)
	}
	return fmt.Sprintf("%s/settings/apps/%s", WebURL, a.Slug)
}

func (a *App) InstallURL() string {
	return fmt.Sprintf("%s/apps/%s/installations/new", WebURL, a.Slug)
}

// Identity is a git author.
type Identity struct {
	Name  string `json:"name"`
	Email string `json:"email"`
}

func (a *App) identity() *Identity {
	if a.BotID == nil {
		return nil
	}
	bot := a.Slug + "[bot]"
	return &Identity{Name: bot, Email: fmt.Sprintf("%d+%s@users.noreply.github.com", *a.BotID, bot)}
}

// ParseRepository returns owner and name from "owner/name" or a GitHub
// remote URL.
func ParseRepository(value string) (string, string, error) {
	text := strings.TrimSpace(value)
	if rest, ok := strings.CutPrefix(text, "git@github.com:"); ok {
		text = rest
	} else if strings.Contains(text, "://") {
		u, err := url.Parse(text)
		if err != nil || u.Hostname() != "github.com" {
			return "", "", newError("NOT_GITHUB", value+" 不是 GitHub 仓库。", http.StatusBadRequest)
		}
		text = u.Path
	}
	parts := strings.Split(strings.TrimSuffix(strings.Trim(text, "/"), ".git"), "/")
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
		return "", "", newError("INVALID_REPOSITORY",
			"无法识别仓库 "+value+"，请写成 owner/name。", http.StatusBadRequest)
	}
	return parts[0], parts[1], nil
}

type installation struct {
	ID      int64 `json:"id"`
	Account struct {
		Login string `json:"login"`
		Type  string `json:"type"`
	} `json:"account"`
	RepositorySelection string `json:"repository_selection"`
	HTMLURL             string `json:"html_url"`
}

type token struct {
	value   string
	expires time.Time
}

// GitHub is the App: its credentials on disk and its calls to GitHub.
type GitHub struct {
	StateDir string
	APIURL   string
	Client   *http.Client
	Now      func() time.Time

	mu            sync.Mutex
	tokens        map[string]token
	installations []installation
	listedAt      time.Time
}

// New keeps the App's state in stateDir and calls the real GitHub.
func New(stateDir string) *GitHub {
	return &GitHub{StateDir: stateDir, APIURL: APIURL, Client: &http.Client{Timeout: 20 * time.Second}, Now: time.Now}
}

func (g *GitHub) path(name string) string { return filepath.Join(g.StateDir, name) }

// App returns the connected App, or nil before one is created.
func (g *GitHub) App() (*App, error) {
	data, err := os.ReadFile(g.path("github.json"))
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var app App
	return &app, json.Unmarshal(data, &app)
}

func (g *GitHub) require() (*App, error) {
	app, err := g.App()
	if err == nil && app == nil {
		err = notConnected()
	}
	return app, err
}

func (g *GitHub) save(app *App, pem string) error {
	if pem != "" {
		if err := write(g.path("github.pem"), []byte(pem), 0o600); err != nil {
			return err
		}
	}
	data, err := json.MarshalIndent(app, "", "  ")
	if err != nil {
		return err
	}
	return write(g.path("github.json"), data, 0o644)
}

// ManifestForm is what the browser posts to GitHub to create the App.
type ManifestForm struct {
	Action   string `json:"action"`
	Manifest string `json:"manifest"`
}

// StartManifest validates the user's choices and returns the form, with a
// one-time state GitHub hands back to FinishManifest.
func (g *GitHub) StartManifest(name, organization, origin string) (*ManifestForm, error) {
	name = strings.TrimSpace(name)
	if !appName.MatchString(name) {
		return nil, newError("INVALID_NAME",
			"App 名称为 1 到 34 个字符，可用字母、数字、空格、点、下划线和连字符。", http.StatusBadRequest)
	}
	if organization != "" && !account.MatchString(organization) {
		return nil, newError("INVALID_ORGANIZATION", "组织名称无效。", http.StatusBadRequest)
	}
	if app, err := g.App(); err != nil {
		return nil, err
	} else if app != nil {
		return nil, newError("GITHUB_ALREADY_CONNECTED", "已经连接了一个 GitHub App。", http.StatusConflict)
	}
	u, err := url.Parse(origin)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return nil, newError("INVALID_ORIGIN", "无法确定 AXP 的访问地址。", http.StatusBadRequest)
	}
	origin = u.Scheme + "://" + u.Host
	state := randomState()
	g.mu.Lock()
	pending := g.pending()
	pending[state] = g.Now().Unix()
	err = g.savePending(pending)
	g.mu.Unlock()
	if err != nil {
		return nil, err
	}
	manifest, err := marshal(map[string]any{
		"name":        name,
		"url":         origin,
		"description": "AXP 的智能体以这个 App 的身份读取仓库、推送分支和打开 PR。",
		// Nothing listens for webhooks; GitHub still wants a URL.
		"hook_attributes":     map[string]any{"url": origin + "/api/forge/v1/github/webhook", "active": false},
		"redirect_url":        origin + "/api/forge/v1/github/manifest/callback",
		"setup_url":           origin + "/?view=capabilities",
		"setup_on_update":     true,
		"public":              false,
		"default_permissions": appPermissions,
		"default_events":      []string{},
	})
	if err != nil {
		return nil, err
	}
	base := WebURL + "/settings/apps/new"
	if organization != "" {
		base = WebURL + "/organizations/" + url.PathEscape(organization) + "/settings/apps/new"
	}
	return &ManifestForm{Action: base + "?state=" + state, Manifest: string(manifest)}, nil
}

func randomState() string {
	b := make([]byte, 24)
	_, _ = rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b)
}

// pending returns the manifests still waiting for GitHub; g.mu is held.
func (g *GitHub) pending() map[string]int64 {
	pending := map[string]int64{}
	if data, err := os.ReadFile(g.path("pending.json")); err == nil {
		_ = json.Unmarshal(data, &pending)
	}
	now := g.Now()
	maps.DeleteFunc(pending, func(_ string, at int64) bool {
		return now.Sub(time.Unix(at, 0)) >= manifestTTL
	})
	return pending
}

func (g *GitHub) savePending(pending map[string]int64) error {
	data, err := json.Marshal(pending)
	if err != nil {
		return err
	}
	return write(g.path("pending.json"), data, 0o600)
}

// FinishManifest handles GitHub's redirect after the App was created:
// it exchanges the code for the App's credentials.
func (g *GitHub) FinishManifest(code, state string) (*App, error) {
	g.mu.Lock()
	pending := g.pending()
	_, ok := pending[state]
	delete(pending, state)
	err := g.savePending(pending)
	g.mu.Unlock()
	if !ok {
		return nil, newError("MANIFEST_EXPIRED", "这次创建已失效，请回到 AXP 重新开始。", http.StatusBadRequest)
	}
	if err != nil {
		return nil, err
	}
	var data struct {
		ID       int64  `json:"id"`
		Slug     string `json:"slug"`
		Name     string `json:"name"`
		ClientID string `json:"client_id"`
		HTMLURL  string `json:"html_url"`
		PEM      string `json:"pem"`
		Owner    struct {
			Login string `json:"login"`
			Type  string `json:"type"`
		} `json:"owner"`
	}
	status, err := g.call(http.MethodPost, "/app-manifests/"+url.PathEscape(code)+"/conversions", "", nil, &data)
	if err != nil {
		return nil, err
	}
	if status != http.StatusCreated {
		return nil, newError("MANIFEST_FAILED",
			fmt.Sprintf("GitHub 没有返回 App 的凭据（%d），请重新创建。", status), http.StatusBadGateway)
	}
	ownerType := data.Owner.Type
	if ownerType == "" {
		ownerType = "User"
	}
	app := &App{
		ID: data.ID, Slug: data.Slug, Name: data.Name, ClientID: data.ClientID,
		HTMLURL: data.HTMLURL, Owner: data.Owner.Login, OwnerType: ownerType,
	}
	if err := g.save(app, data.PEM); err != nil {
		return nil, err
	}
	g.botID(app)
	return app, nil
}

// Forget drops the App's credentials here; the App on GitHub stays.
func (g *GitHub) Forget() error {
	g.mu.Lock()
	defer g.mu.Unlock()
	for _, name := range []string{"github.json", "github.pem"} {
		if err := os.Remove(g.path(name)); err != nil && !errors.Is(err, fs.ErrNotExist) {
			return err
		}
	}
	g.tokens = nil
	g.installations = nil
	return nil
}

// botID looks up and remembers the App's bot user, for commits; best effort.
func (g *GitHub) botID(app *App) {
	if app.BotID != nil {
		return
	}
	var user struct {
		ID int64 `json:"id"`
	}
	if status, err := g.call(http.MethodGet, "/users/"+url.PathEscape(app.Slug)+"%5Bbot%5D", "", nil, &user); err == nil && status == http.StatusOK {
		app.BotID = &user.ID
		_ = g.save(app, "")
	}
}

// Identity is the App bot's git author.
func (g *GitHub) Identity() (*Identity, error) {
	app, err := g.require()
	if err != nil {
		return nil, err
	}
	g.botID(app)
	if id := app.identity(); id != nil {
		return id, nil
	}
	return nil, newError("GITHUB_UNAVAILABLE", "暂时无法从 GitHub 读取 App 的身份。", http.StatusBadGateway)
}

// --- calls --------------------------------------------------------------------

// call sends a request to GitHub's API and decodes a 2xx JSON answer into
// out. Other statuses come back with a nil error and out untouched; their
// body is in the returned error only through reasons().
func (g *GitHub) call(method, path, auth string, body, out any) (int, error) {
	status, raw, err := g.send(method, path, auth, body)
	if err != nil {
		return 0, err
	}
	if status < 300 && out != nil && len(raw) > 0 {
		if err := json.Unmarshal(raw, out); err != nil {
			return 0, fmt.Errorf("decoding %s %s: %w", method, path, err)
		}
	}
	return status, nil
}

func (g *GitHub) send(method, path, auth string, body any) (int, []byte, error) {
	var reader io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return 0, nil, err
		}
		reader = bytes.NewReader(data)
	}
	req, err := http.NewRequest(method, g.APIURL+path, reader)
	if err != nil {
		return 0, nil, err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	req.Header.Set("User-Agent", "axp-forge")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if auth != "" {
		req.Header.Set("Authorization", "Bearer "+auth)
	}
	resp, err := g.Client.Do(req)
	if err != nil {
		return 0, nil, &Error{Code: "GITHUB_UNREACHABLE", Message: "暂时连不上 GitHub。", Status: http.StatusBadGateway}
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(resp.Body)
	return resp.StatusCode, raw, err
}

// failed turns a non-2xx answer into an error naming GitHub's reasons.
func failed(status int, raw []byte) *Error {
	return newError("GITHUB_ERROR", fmt.Sprintf("GitHub 返回 %d：%s", status, orNone(reasons(raw))), http.StatusBadGateway)
}

func reasons(raw []byte) string {
	var data struct {
		Message string `json:"message"`
		Errors  []any  `json:"errors"`
	}
	if json.Unmarshal(raw, &data) != nil {
		return ""
	}
	var parts []string
	if data.Message != "" {
		parts = append(parts, data.Message)
	}
	for _, e := range data.Errors {
		if m, ok := e.(map[string]any); ok {
			if s, ok := m["message"].(string); ok && s != "" {
				parts = append(parts, s)
			}
		}
	}
	return strings.Join(parts, "；")
}

func orNone(s string) string {
	if s == "" {
		return "没有说明原因"
	}
	return s
}

func (g *GitHub) jwt(app *App) (string, error) {
	pem, err := os.ReadFile(g.path("github.pem"))
	if err != nil {
		return "", err
	}
	key, err := jwt.ParseRSAPrivateKeyFromPEM(pem)
	if err != nil {
		return "", err
	}
	return signJWT(key, app.ID, g.Now())
}

func signJWT(key *rsa.PrivateKey, appID int64, now time.Time) (string, error) {
	return jwt.NewWithClaims(jwt.SigningMethodRS256, jwt.MapClaims{
		"iat": now.Add(-time.Minute).Unix(),
		"exp": now.Add(9 * time.Minute).Unix(),
		"iss": strconv.FormatInt(appID, 10),
	}).SignedString(key)
}

// asApp sends a request authenticated as the App.
func (g *GitHub) asApp(method, path string, body any) (int, []byte, error) {
	app, err := g.require()
	if err != nil {
		return 0, nil, err
	}
	signed, err := g.jwt(app)
	if err != nil {
		return 0, nil, err
	}
	status, raw, err := g.send(method, path, signed, body)
	if err == nil && status == http.StatusUnauthorized {
		return 0, nil, newError("GITHUB_APP_GONE",
			"GitHub 不认这个 App 了（可能已在 GitHub 上删除）。请断开后重新连接。", http.StatusBadGateway)
	}
	return status, raw, err
}

func (g *GitHub) listInstallations(fresh bool) ([]installation, error) {
	g.mu.Lock()
	cached, at := g.installations, g.listedAt
	g.mu.Unlock()
	if cached != nil && !fresh && g.Now().Sub(at) < installationsTTL {
		return cached, nil
	}
	status, raw, err := g.asApp(http.MethodGet, "/app/installations?per_page=100", nil)
	if err != nil {
		return nil, err
	}
	if status >= 300 {
		return nil, failed(status, raw)
	}
	var list []installation
	if err := json.Unmarshal(raw, &list); err != nil {
		return nil, err
	}
	g.mu.Lock()
	g.installations, g.listedAt = list, g.Now()
	g.mu.Unlock()
	return list, nil
}

func (g *GitHub) installationFor(owner string) (*installation, error) {
	for _, fresh := range []bool{false, true} {
		list, err := g.listInstallations(fresh)
		if err != nil {
			return nil, err
		}
		for i := range list {
			if strings.EqualFold(list[i].Account.Login, owner) {
				return &list[i], nil
			}
		}
	}
	return nil, notInstalled(owner)
}

// token returns an installation token with these permissions, for one
// repository or (repository "") all of the installation's.
func (g *GitHub) token(id int64, permissions Permissions, repository string) (token, error) {
	names := slices.Sorted(maps.Keys(permissions))
	key := fmt.Sprintf("%d|%s|", id, repository)
	for _, name := range names {
		key += name + "=" + permissions[name] + ","
	}
	g.mu.Lock()
	cached, ok := g.tokens[key]
	g.mu.Unlock()
	if ok && cached.expires.Sub(g.Now()) > tokenMargin {
		return cached, nil
	}
	body := map[string]any{"permissions": permissions}
	if repository != "" {
		body["repositories"] = []string{repository}
	}
	status, raw, err := g.asApp(http.MethodPost, fmt.Sprintf("/app/installations/%d/access_tokens", id), body)
	if err != nil {
		return token{}, err
	}
	if status == http.StatusUnprocessableEntity && repository != "" {
		return token{}, newError("GITHUB_REPOSITORY_NOT_GRANTED", fmt.Sprintf(
			"AXP 的 GitHub App 没有被授权访问仓库 %s。请让用户在 AXP 工作区的“能力”页管理 App 能访问的仓库。",
			repository), http.StatusConflict)
	}
	if status >= 300 {
		return token{}, failed(status, raw)
	}
	var data struct {
		Token     string    `json:"token"`
		ExpiresAt time.Time `json:"expires_at"`
	}
	if err := json.Unmarshal(raw, &data); err != nil {
		return token{}, err
	}
	t := token{value: data.Token, expires: data.ExpiresAt}
	g.mu.Lock()
	if g.tokens == nil {
		g.tokens = map[string]token{}
	}
	g.tokens[key] = t
	g.mu.Unlock()
	return t, nil
}

// --- for runtimes ---------------------------------------------------------------

// Credential is what git needs to fetch and push a repository.
type Credential struct {
	Username  string `json:"username"`
	Password  string `json:"password"`
	ExpiresAt int64  `json:"expires_at"`
}

func (g *GitHub) Credential(owner, name string) (*Credential, error) {
	inst, err := g.installationFor(owner)
	if err != nil {
		return nil, err
	}
	t, err := g.token(inst.ID, push, name)
	if err != nil {
		return nil, err
	}
	return &Credential{Username: "x-access-token", Password: t.value, ExpiresAt: t.expires.Unix()}, nil
}

// ReadToken is a read-only token for gh, covering the installation of owner.
type ReadToken struct {
	Token     string `json:"token"`
	ExpiresAt int64  `json:"expires_at"`
}

func (g *GitHub) ReadToken(owner string) (*ReadToken, error) {
	inst, err := g.installationFor(owner)
	if err != nil {
		return nil, err
	}
	t, err := g.token(inst.ID, readOnly, "")
	if err != nil {
		return nil, err
	}
	return &ReadToken{Token: t.value, ExpiresAt: t.expires.Unix()}, nil
}

// PullRequest is an opened (or already open) pull request.
type PullRequest struct {
	URL     string `json:"url"`
	Number  int    `json:"number"`
	Created bool   `json:"created"`
}

// OpenPullRequest opens a pull request as the App; base defaults to the
// repository's default branch. An open pull request for head is returned
// instead of failing.
func (g *GitHub) OpenPullRequest(repository, head, title, body, base string, draft bool) (*PullRequest, error) {
	owner, name, err := ParseRepository(repository)
	if err != nil {
		return nil, err
	}
	inst, err := g.installationFor(owner)
	if err != nil {
		return nil, err
	}
	t, err := g.token(inst.ID, pullRequest, name)
	if err != nil {
		return nil, err
	}
	repo := "/repos/" + url.PathEscape(owner) + "/" + url.PathEscape(name)
	if base == "" {
		status, raw, err := g.send(http.MethodGet, repo, t.value, nil)
		if err != nil {
			return nil, err
		}
		if status >= 300 {
			return nil, failed(status, raw)
		}
		var info struct {
			DefaultBranch string `json:"default_branch"`
		}
		if err := json.Unmarshal(raw, &info); err != nil {
			return nil, err
		}
		base = info.DefaultBranch
	}
	status, raw, err := g.send(http.MethodPost, repo+"/pulls", t.value, map[string]any{
		"title": title, "body": body, "head": head, "base": base, "draft": draft,
	})
	if err != nil {
		return nil, err
	}
	type pull struct {
		HTMLURL string `json:"html_url"`
		Number  int    `json:"number"`
	}
	if status == http.StatusCreated {
		var p pull
		if err := json.Unmarshal(raw, &p); err != nil {
			return nil, err
		}
		return &PullRequest{URL: p.HTMLURL, Number: p.Number, Created: true}, nil
	}
	why := reasons(raw)
	if status == http.StatusUnprocessableEntity && strings.Contains(why, "already exists") {
		branch := head
		if !strings.Contains(head, ":") {
			branch = owner + ":" + head
		}
		var open []pull
		query := "?state=open&head=" + url.QueryEscape(branch)
		if s, err := g.call(http.MethodGet, repo+"/pulls"+query, t.value, nil, &open); err == nil && s == http.StatusOK && len(open) > 0 {
			return &PullRequest{URL: open[0].HTMLURL, Number: open[0].Number}, nil
		}
	}
	code := http.StatusBadRequest
	if status >= 500 {
		code = http.StatusBadGateway
	}
	return nil, newError("PULL_REQUEST_FAILED", fmt.Sprintf("GitHub 拒绝创建 PR（%d）：%s", status, orNone(why)), code)
}

// --- for the browser --------------------------------------------------------------

// Status is the App's state for the setup wizard.
type Status struct {
	State         string             `json:"state"` // not_connected, not_installed, ready, error
	App           *AppView           `json:"app"`
	Installations []InstallationView `json:"installations"`
	Error         *ErrorView         `json:"error,omitempty"`
}

type AppView struct {
	Name        string `json:"name"`
	Slug        string `json:"slug"`
	Owner       string `json:"owner"`
	OwnerType   string `json:"owner_type"`
	HTMLURL     string `json:"html_url"`
	SettingsURL string `json:"settings_url"`
	InstallURL  string `json:"install_url"`
}

type InstallationView struct {
	ID                  int64    `json:"id"`
	Account             string   `json:"account"`
	AccountType         string   `json:"account_type"`
	RepositorySelection string   `json:"repository_selection"`
	Repositories        []string `json:"repositories"`
	TotalRepositories   int      `json:"total_repositories"`
	ManageURL           string   `json:"manage_url,omitempty"`
}

type ErrorView struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// Status reports the App and where it is installed; fresh skips the short
// cache of installations.
func (g *GitHub) Status(fresh bool) (*Status, error) {
	app, err := g.App()
	if err != nil {
		return nil, err
	}
	status := &Status{State: "not_connected", Installations: []InstallationView{}}
	if app == nil {
		return status, nil
	}
	status.App = &AppView{
		Name: app.Name, Slug: app.Slug, Owner: app.Owner, OwnerType: app.OwnerType,
		HTMLURL: app.HTMLURL, SettingsURL: app.SettingsURL(), InstallURL: app.InstallURL(),
	}
	list, err := g.listInstallations(fresh)
	if err == nil {
		for _, inst := range list {
			view, viewErr := g.installationView(inst)
			if viewErr != nil {
				err = viewErr
				break
			}
			status.Installations = append(status.Installations, view)
		}
	}
	var forgeErr *Error
	switch {
	case errors.As(err, &forgeErr):
		status.State = "error"
		status.Installations = []InstallationView{}
		status.Error = &ErrorView{Code: forgeErr.Code, Message: forgeErr.Message}
	case err != nil:
		return nil, err
	case len(status.Installations) > 0:
		status.State = "ready"
	default:
		status.State = "not_installed"
	}
	return status, nil
}

func (g *GitHub) installationView(inst installation) (InstallationView, error) {
	view := InstallationView{
		ID: inst.ID, Account: inst.Account.Login, AccountType: inst.Account.Type,
		RepositorySelection: inst.RepositorySelection, ManageURL: inst.HTMLURL,
		Repositories: []string{},
	}
	if view.AccountType == "" {
		view.AccountType = "User"
	}
	if view.RepositorySelection == "" {
		view.RepositorySelection = "selected"
	}
	t, err := g.token(inst.ID, metadata, "")
	if err != nil {
		return view, err
	}
	var data struct {
		TotalCount   int `json:"total_count"`
		Repositories []struct {
			FullName string `json:"full_name"`
		} `json:"repositories"`
	}
	status, raw, err := g.send(http.MethodGet, fmt.Sprintf("/installation/repositories?per_page=%d", repositoriesShown), t.value, nil)
	if err != nil {
		return view, err
	}
	if status >= 300 {
		return view, failed(status, raw)
	}
	if err := json.Unmarshal(raw, &data); err != nil {
		return view, err
	}
	view.TotalRepositories = data.TotalCount
	for _, r := range data.Repositories {
		view.Repositories = append(view.Repositories, r.FullName)
	}
	return view, nil
}

// marshal encodes JSON without escaping HTML characters, as GitHub shows
// the manifest's text to the user.
func marshal(v any) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	return bytes.TrimRight(buf.Bytes(), "\n"), nil
}

// write replaces a file atomically.
func write(path string, data []byte, mode os.FileMode) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, mode); err != nil {
		return err
	}
	if err := os.Chmod(tmp, mode); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}
