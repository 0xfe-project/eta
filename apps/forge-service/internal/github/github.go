// Package github reaches GitHub through one GitHub App, created by and
// installed for the user.
//
// The App is created from a manifest (the browser posts it to GitHub, GitHub
// sends a one-time code back) and its credentials stay in the state
// directory: github.json and the private key github.pem. Calls go through
// go-github, as the App (with a JWT signed by that key) or with an
// installation token, which carries everything the installation was granted;
// tokens are cached until close to expiry. Nothing here is per agent: once
// the user authorized the App, every agent acts on the user's behalf
// (user.go), otherwise as the App.
package github

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"maps"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"strconv"

	"github.com/golang-jwt/jwt/v5"
	gh "github.com/google/go-github/v92/github"
)

const (
	WebURL = "https://github.com"

	manifestTTL      = time.Hour
	tokenMargin      = 10 * time.Minute
	installationsTTL = 30 * time.Second
)

var (
	// GitHub App names are global on GitHub and at most 34 characters.
	appName = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9 ._-]{0,33}$`)
	account = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9-]{0,38}$`)

	// Everything GitHub lets an App ask for in repositories, and in an
	// organization it is installed on, at the highest level; the user may
	// grant less, and tokens carry whatever the installation was granted.
	appPermissions = map[string]string{
		"actions": "write", "administration": "write", "artifact_metadata": "write",
		"attestations": "write", "checks": "write", "code_quality": "write",
		"codespaces": "write", "contents": "write", "dependabot_secrets": "write",
		"deployments": "write", "discussions": "write", "environments": "write",
		"issues": "write", "merge_queues": "write", "metadata": "read",
		"packages": "write", "pages": "write", "pull_requests": "write",
		"repository_creation": "write", "repository_custom_properties": "write", "repository_hooks": "write",
		"repository_projects": "admin", "secret_scanning_alerts": "write",
		"secrets": "write", "security_events": "write", "statuses": "write",
		"vulnerability_alerts": "write", "workflows": "write",

		"members": "write", "organization_administration": "write",
		"organization_announcement_banners": "write", "organization_custom_org_roles": "write",
		"organization_custom_properties": "admin", "organization_custom_roles": "write",
		"organization_events": "read", "organization_hooks": "write",
		"organization_packages": "write", "organization_personal_access_token_requests": "write",
		"organization_personal_access_tokens": "write", "organization_plan": "read",
		"organization_projects": "admin", "organization_secrets": "write",
		"organization_self_hosted_runners": "write", "organization_user_blocking": "write",
	}
)

// Error is an answer for the user or the agent, with the HTTP status it
// travels with.
type Error struct {
	Code    string
	Message string
	Status  int
}

func (e *Error) Error() string { return e.Message }

func newError(code string, status int, format string, args ...any) *Error {
	return &Error{Code: code, Message: fmt.Sprintf(format, args...), Status: status}
}

func notConnected() *Error {
	return newError("GITHUB_NOT_CONNECTED", http.StatusConflict,
		"GitHub 还没有连接。请让用户在 AXP 的“设置 → 连接”里按向导连接 GitHub。")
}

// fromGitHub turns a failed call into an answer naming GitHub's reasons.
// GitHub's failures are 424, never 502: Cloudflare, in front of production,
// replaces an origin's 502 and 504 with its own error page.
func fromGitHub(err error) error {
	var resp *gh.ErrorResponse
	if !errors.As(err, &resp) {
		return newError("GITHUB_UNREACHABLE", http.StatusFailedDependency, "暂时连不上 GitHub。")
	}
	return newError("GITHUB_ERROR", http.StatusFailedDependency, "GitHub 返回 %d：%s", statusOf(err), reasons(err))
}

func statusOf(err error) int {
	var resp *gh.ErrorResponse
	if errors.As(err, &resp) && resp.Response != nil {
		return resp.Response.StatusCode
	}
	return 0
}

func reasons(err error) string {
	var resp *gh.ErrorResponse
	if !errors.As(err, &resp) {
		return err.Error()
	}
	parts := []string{resp.Message}
	for _, e := range resp.Errors {
		parts = append(parts, e.Message)
	}
	return strings.Trim(strings.Join(parts, "；"), "；")
}

// App is the GitHub App as saved in github.json.
type App struct {
	ID        int64  `json:"id"`
	Slug      string `json:"slug"`
	Name      string `json:"name"`
	HTMLURL   string `json:"html_url"`
	Owner     string `json:"owner"`
	OwnerType string `json:"owner_type"` // "User" or "Organization"
	BotID     int64  `json:"bot_id,omitempty"`
	ClientID  string `json:"client_id,omitempty"`
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

// ParseRepository returns owner and name from "owner/name" or a GitHub
// remote URL.
func ParseRepository(value string) (string, string, error) {
	text := strings.TrimSpace(value)
	if rest, ok := strings.CutPrefix(text, "git@github.com:"); ok {
		text = rest
	} else if strings.Contains(text, "://") {
		u, err := url.Parse(text)
		if err != nil || u.Hostname() != "github.com" {
			return "", "", newError("NOT_GITHUB", http.StatusBadRequest, "%s 不是 GitHub 仓库。", value)
		}
		text = u.Path
	}
	owner, name, ok := strings.Cut(strings.TrimSuffix(strings.Trim(text, "/"), ".git"), "/")
	if !ok || owner == "" || name == "" || strings.Contains(name, "/") {
		return "", "", newError("INVALID_REPOSITORY", http.StatusBadRequest, "无法识别仓库 %s，请写成 owner/name。", value)
	}
	return owner, name, nil
}

type token struct {
	value   string
	expires time.Time
}

// GitHub is the App: its credentials on disk and its calls to GitHub.
type GitHub struct {
	StateDir string
	APIURL   string // empty for api.github.com
	OAuthURL string // empty for github.com
	Now      func() time.Time

	mu            sync.Mutex
	tokens        map[int64]token
	installations []*gh.Installation
	listedAt      time.Time
	authorizing   map[string]authorizing

	userMu sync.Mutex // user.json
}

// New keeps the App's state in stateDir and calls the real GitHub.
func New(stateDir string) *GitHub {
	return &GitHub{StateDir: stateDir, Now: time.Now}
}

func (g *GitHub) path(name string) string { return filepath.Join(g.StateDir, name) }

func (g *GitHub) client(opts ...gh.ClientOptionsFunc) *gh.Client {
	opts = append([]gh.ClientOptionsFunc{gh.WithTimeout(20 * time.Second), gh.WithUserAgent("axp-forge")}, opts...)
	if g.APIURL != "" {
		base := strings.TrimSuffix(g.APIURL, "/") + "/"
		opts = append(opts, gh.WithURLs(&base, &base))
	}
	client, err := gh.NewClient(opts...)
	if err != nil {
		panic(err) // only for options this package never passes
	}
	return client
}

// asApp is a client authenticated as the App.
func (g *GitHub) asApp() (*gh.Client, error) {
	app, err := g.require()
	if err != nil {
		return nil, err
	}
	pem, err := os.ReadFile(g.path("github.pem"))
	if err != nil {
		return nil, err
	}
	key, err := jwt.ParseRSAPrivateKeyFromPEM(pem)
	if err != nil {
		return nil, err
	}
	return g.client(gh.WithTransport(roundTripper(func(r *http.Request) (*http.Response, error) {
		now := g.Now()
		signed, err := jwt.NewWithClaims(jwt.SigningMethodRS256, jwt.RegisteredClaims{
			IssuedAt:  jwt.NewNumericDate(now.Add(-time.Minute)),
			ExpiresAt: jwt.NewNumericDate(now.Add(9 * time.Minute)),
			Issuer:    strconv.FormatInt(app.ID, 10),
		}).SignedString(key)
		if err != nil {
			return nil, err
		}
		r = r.Clone(r.Context())
		r.Header.Set("Authorization", "Bearer "+signed)
		return http.DefaultTransport.RoundTrip(r)
	}))), nil
}

type roundTripper func(*http.Request) (*http.Response, error)

func (f roundTripper) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

// appCall wraps errors of calls made as the App: GitHub not knowing the App
// any more is worth its own answer.
func appCall(err error) error {
	if statusOf(err) == http.StatusUnauthorized {
		return newError("GITHUB_APP_GONE", http.StatusFailedDependency,
			"GitHub 不认这个 App 了（可能已在 GitHub 上删除）。请断开后重新连接。")
	}
	return fromGitHub(err)
}

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

func (g *GitHub) save(app *App) error {
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
		return nil, newError("INVALID_NAME", http.StatusBadRequest,
			"App 名称为 1 到 34 个字符，可用字母、数字、空格、点、下划线和连字符。")
	}
	if organization != "" && !account.MatchString(organization) {
		return nil, newError("INVALID_ORGANIZATION", http.StatusBadRequest, "组织名称无效。")
	}
	if app, err := g.App(); err != nil || app != nil {
		if err == nil {
			err = newError("GITHUB_ALREADY_CONNECTED", http.StatusConflict, "已经连接了一个 GitHub App。")
		}
		return nil, err
	}
	u, err := url.Parse(origin)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return nil, newError("INVALID_ORIGIN", http.StatusBadRequest, "无法确定 AXP 的访问地址。")
	}
	origin = u.Scheme + "://" + u.Host
	random := make([]byte, 24)
	_, _ = rand.Read(random)
	state := base64.RawURLEncoding.EncodeToString(random)
	path := "/settings/apps/new"
	if organization != "" {
		path = "/organizations/" + url.PathEscape(organization) + path
	}
	form := &ManifestForm{Action: WebURL + path + "?state=" + state}
	g.mu.Lock()
	pending := g.pending()
	pending[state] = g.Now().Unix()
	err = g.savePending(pending)
	g.mu.Unlock()
	if err != nil {
		return nil, err
	}
	manifest, err := json.Marshal(map[string]any{
		"name":        name,
		"url":         origin,
		"description": "AXP 的智能体以这个 App 的身份使用 GitHub。",
		// Nothing listens for webhooks; GitHub still wants a URL.
		"hook_attributes": map[string]any{"url": origin + "/api/forge/v1/github/webhook", "active": false},
		"redirect_url":    origin + "/api/forge/v1/github/manifest/callback",
		// Installing also asks the user to authorize the App, so it can open
		// pull requests on their behalf; GitHub then returns to the callback
		// URL instead of a setup URL.
		"callback_urls":            []string{origin + CallbackPath},
		"request_oauth_on_install": true,
		// A private App installs only on the account that owns it; public
		// lets the user install it on their other accounts and organizations.
		"public":              true,
		"default_permissions": appPermissions,
		"default_events":      []string{},
	})
	form.Manifest = string(manifest)
	return form, err
}

// pending returns the manifests still waiting for GitHub; g.mu is held.
func (g *GitHub) pending() map[string]int64 {
	pending := map[string]int64{}
	if data, err := os.ReadFile(g.path("pending.json")); err == nil {
		_ = json.Unmarshal(data, &pending)
	}
	maps.DeleteFunc(pending, func(_ string, at int64) bool {
		return g.Now().Sub(time.Unix(at, 0)) >= manifestTTL
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

// FinishManifest handles GitHub's redirect after the App was created: it
// exchanges the code for the App's credentials.
func (g *GitHub) FinishManifest(ctx context.Context, code, state string) (*App, error) {
	g.mu.Lock()
	pending := g.pending()
	_, ok := pending[state]
	delete(pending, state)
	err := g.savePending(pending)
	g.mu.Unlock()
	if !ok {
		return nil, newError("MANIFEST_EXPIRED", http.StatusBadRequest, "这次创建已失效，请回到 AXP 重新开始。")
	}
	if err != nil {
		return nil, err
	}
	created, _, err := g.client().Apps.CompleteAppManifest(ctx, code)
	if err != nil {
		if statusOf(err) == 0 {
			return nil, fromGitHub(err)
		}
		return nil, newError("MANIFEST_FAILED", http.StatusFailedDependency,
			"GitHub 没有返回 App 的凭据（%d），请重新创建。", statusOf(err))
	}
	app := &App{
		ID: created.GetID(), Slug: created.GetSlug(), Name: created.GetName(), HTMLURL: created.GetHTMLURL(),
		Owner: created.GetOwner().GetLogin(), OwnerType: created.GetOwner().GetType(),
	}
	if app.OwnerType == "" {
		app.OwnerType = "User"
	}
	if err := write(g.path("github.pem"), []byte(created.GetPEM()), 0o600); err != nil {
		return nil, err
	}
	if created.GetClientSecret() != "" {
		if err := write(g.path("github.secret"), []byte(created.GetClientSecret()), 0o600); err != nil {
			return nil, err
		}
		app.ClientID = created.GetClientID()
	}
	if err := g.save(app); err != nil {
		return nil, err
	}
	g.botID(ctx, app)
	return app, nil
}

// Forget drops the App's credentials and the user's authorization here; the
// App on GitHub stays.
func (g *GitHub) Forget(ctx context.Context) error {
	if err := g.ForgetUser(ctx); err != nil {
		return err
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	for _, name := range []string{"github.json", "github.pem", "github.secret"} {
		if err := os.Remove(g.path(name)); err != nil && !errors.Is(err, fs.ErrNotExist) {
			return err
		}
	}
	g.tokens, g.installations = nil, nil
	return nil
}

// botID looks up and remembers the App's bot user, for commits; best effort.
func (g *GitHub) botID(ctx context.Context, app *App) {
	if app.BotID != 0 {
		return
	}
	if user, _, err := g.client().Users.Get(ctx, app.Slug+"[bot]"); err == nil {
		app.BotID = user.GetID()
		_ = g.save(app)
	}
}

// Identity is a git author.
type Identity struct {
	Name  string `json:"name"`
	Email string `json:"email"`
}

// Identity is the App bot's git author.
func (g *GitHub) Identity(ctx context.Context) (*Identity, error) {
	app, err := g.require()
	if err != nil {
		return nil, err
	}
	g.botID(ctx, app)
	if app.BotID == 0 {
		return nil, newError("GITHUB_UNAVAILABLE", http.StatusFailedDependency, "暂时无法从 GitHub 读取 App 的身份。")
	}
	bot := app.Slug + "[bot]"
	return &Identity{Name: bot, Email: fmt.Sprintf("%d+%s@users.noreply.github.com", app.BotID, bot)}, nil
}

func (g *GitHub) listInstallations(ctx context.Context, fresh bool) ([]*gh.Installation, error) {
	g.mu.Lock()
	cached, at := g.installations, g.listedAt
	g.mu.Unlock()
	if cached != nil && !fresh && g.Now().Sub(at) < installationsTTL {
		return cached, nil
	}
	client, err := g.asApp()
	if err != nil {
		return nil, err
	}
	list, _, err := client.Apps.ListInstallations(ctx, &gh.ListOptions{PerPage: 100})
	if err != nil {
		return nil, appCall(err)
	}
	g.mu.Lock()
	g.installations, g.listedAt = list, g.Now()
	g.mu.Unlock()
	return list, nil
}

func (g *GitHub) installationFor(ctx context.Context, owner string) (*gh.Installation, error) {
	for _, fresh := range []bool{false, true} {
		list, err := g.listInstallations(ctx, fresh)
		if err != nil {
			return nil, err
		}
		for _, inst := range list {
			if strings.EqualFold(inst.GetAccount().GetLogin(), owner) {
				return inst, nil
			}
		}
	}
	return nil, newError("GITHUB_NOT_INSTALLED", http.StatusConflict,
		"AXP 的 GitHub App 没有安装到 %s。请让用户在 AXP 的“设置 → 连接”里把 App 安装到这个账号或组织，并授权需要的仓库。", owner)
}

// token returns an installation token, for all of the installation's
// repositories and permissions.
func (g *GitHub) token(ctx context.Context, id int64) (token, error) {
	g.mu.Lock()
	cached, ok := g.tokens[id]
	g.mu.Unlock()
	if ok && cached.expires.Sub(g.Now()) > tokenMargin {
		return cached, nil
	}
	client, err := g.asApp()
	if err != nil {
		return token{}, err
	}
	minted, _, err := client.Apps.CreateInstallationToken(ctx, id, nil)
	if err != nil {
		return token{}, appCall(err)
	}
	t := token{value: minted.GetToken(), expires: minted.GetExpiresAt().Time}
	g.mu.Lock()
	if g.tokens == nil {
		g.tokens = map[int64]token{}
	}
	g.tokens[id] = t
	g.mu.Unlock()
	return t, nil
}

// --- for runtimes ---------------------------------------------------------------

// userTokenTTL is the longest a user's token is handed out for: whoever
// holds it asks again by then, so revoking the authorization in AXP takes
// effect within it.
const userTokenTTL = time.Hour

// Credentials are what runtimes and remote computers set gh up with, and git
// through gh. Every caller acts as the same one: the user who authorized the
// App, with their user access token (User names them), so GitHub lets
// through what needs a user, such as creating a repository in their
// account; otherwise the App's installation token, as its bot. The App is
// private, so GitHub installs it only on the account that owns it; the one
// installation covers every repository the user granted. Identity, the
// commit author, is the App's bot either way, once GitHub knows it.
type Credentials struct {
	Token     string    `json:"token"`
	ExpiresAt int64     `json:"expires_at"`
	Identity  *Identity `json:"identity"`
	User      string    `json:"user,omitempty"`
}

func (g *GitHub) Credentials(ctx context.Context) (*Credentials, error) {
	app, err := g.require()
	if err != nil {
		return nil, err
	}
	if user := g.userToken(ctx); user != nil {
		expires := g.Now().Add(userTokenTTL).Unix()
		if user.ExpiresAt != 0 && user.ExpiresAt < expires {
			expires = user.ExpiresAt
		}
		identity, _ := g.Identity(ctx)
		return &Credentials{Token: user.AccessToken, ExpiresAt: expires, Identity: identity, User: user.Login}, nil
	}
	inst, err := g.installationFor(ctx, app.Owner)
	if err != nil {
		return nil, err
	}
	t, err := g.token(ctx, inst.GetID())
	if err != nil {
		return nil, err
	}
	identity, _ := g.Identity(ctx)
	return &Credentials{Token: t.value, ExpiresAt: t.expires.Unix(), Identity: identity}, nil
}

// PullRequest is an opened (or already open) pull request. Author is its
// author on GitHub: the user who authorized the App, or the App's bot.
type PullRequest struct {
	URL     string `json:"url"`
	Number  int    `json:"number"`
	Created bool   `json:"created"`
	Author  string `json:"author"`
}

// OpenPullRequest opens a pull request on behalf of the user who authorized
// the App, or else as the App; base defaults to the repository's default
// branch. An open pull request for head is returned instead of failing.
//
// GitHub refusing the user's token (revoked: 401, which also forgets it) or
// the user's access falling short of the App's (403, 404) makes the App open
// it instead, quietly: the user's authorship is a nicety.
func (g *GitHub) OpenPullRequest(ctx context.Context, repository, head, title, body, base string, draft bool) (*PullRequest, error) {
	owner, name, err := ParseRepository(repository)
	if err != nil {
		return nil, err
	}
	inst, err := g.installationFor(ctx, owner)
	if err != nil {
		return nil, err
	}
	if user := g.userToken(ctx); user != nil {
		pull, err := g.createPull(ctx, user.AccessToken, owner, name, head, title, body, base, draft)
		switch statusOf(err) {
		case 0:
			if err == nil {
				return pull, nil
			}
			return nil, fromGitHub(err)
		case http.StatusUnauthorized:
			g.dropUser()
		case http.StatusForbidden, http.StatusNotFound:
			// The App can, though the user cannot: the App opens it.
		default:
			return nil, pullError(err)
		}
	}
	t, err := g.token(ctx, inst.GetID())
	if err != nil {
		return nil, err
	}
	pull, err := g.createPull(ctx, t.value, owner, name, head, title, body, base, draft)
	if err != nil {
		return nil, pullError(err)
	}
	return pull, nil
}

// createPull opens the pull request with token, or returns the one open for
// head; errors are GitHub's.
func (g *GitHub) createPull(ctx context.Context, token, owner, name, head, title, body, base string, draft bool) (*PullRequest, error) {
	client := g.client(gh.WithAuthToken(token))
	if base == "" {
		repo, _, err := client.Repositories.Get(ctx, owner, name)
		if err != nil {
			return nil, err
		}
		base = repo.GetDefaultBranch()
	}
	pull, _, err := client.PullRequests.Create(ctx, owner, name, gh.CreatePullRequest{
		Title: &title, Body: &body, Head: head, Base: base, Draft: &draft,
	})
	if err == nil {
		return &PullRequest{URL: pull.GetHTMLURL(), Number: pull.GetNumber(), Created: true, Author: pull.GetUser().GetLogin()}, nil
	}
	if statusOf(err) == http.StatusUnprocessableEntity && strings.Contains(reasons(err), "already exists") {
		branch := head
		if !strings.Contains(head, ":") {
			branch = owner + ":" + head
		}
		open, _, listErr := client.PullRequests.List(ctx, owner, name, &gh.PullRequestListOptions{Head: branch, State: "open"})
		if listErr == nil && len(open) > 0 {
			return &PullRequest{URL: open[0].GetHTMLURL(), Number: open[0].GetNumber(), Author: open[0].GetUser().GetLogin()}, nil
		}
	}
	return nil, err
}

func pullError(err error) error {
	if statusOf(err) == 0 {
		return fromGitHub(err)
	}
	code := http.StatusBadRequest
	if statusOf(err) >= 500 {
		code = http.StatusFailedDependency
	}
	return newError("PULL_REQUEST_FAILED", code, "GitHub 拒绝创建 PR（%d）：%s", statusOf(err), reasons(err))
}

// --- for the browser --------------------------------------------------------------

// Status is the App's state for the setup wizard.
type Status struct {
	State         string             `json:"state"` // not_connected, not_installed, ready, error
	App           *AppView           `json:"app"`
	Installations []InstallationView `json:"installations"`
	Error         *ErrorView         `json:"error,omitempty"`
	// The user's authorization: whom pull requests are opened for, and
	// whether AXP has the client secret to ask for one.
	User  *UserView `json:"user"`
	OAuth bool      `json:"oauth"`
}

type UserView struct {
	Login   string `json:"login"`
	HTMLURL string `json:"html_url"`
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
func (g *GitHub) Status(ctx context.Context, fresh bool) (*Status, error) {
	app, err := g.App()
	if err != nil || app == nil {
		return &Status{State: "not_connected", Installations: []InstallationView{}}, err
	}
	status := &Status{State: "not_installed", Installations: []InstallationView{}, App: &AppView{
		Name: app.Name, Slug: app.Slug, Owner: app.Owner, OwnerType: app.OwnerType,
		HTMLURL: app.HTMLURL, SettingsURL: app.SettingsURL(), InstallURL: app.InstallURL(),
	}, OAuth: app.ClientID != "" && g.clientSecret() != ""}
	if user, _ := g.AuthorizedUser(); user != nil {
		status.User = &UserView{Login: user.Login, HTMLURL: WebURL + "/" + user.Login}
	}
	list, err := g.listInstallations(ctx, fresh)
	for _, inst := range list {
		if err != nil {
			break
		}
		var view InstallationView
		view, err = g.installationView(ctx, inst)
		status.Installations = append(status.Installations, view)
	}
	var forgeErr *Error
	switch {
	case errors.As(err, &forgeErr):
		status.State, status.Installations = "error", []InstallationView{}
		status.Error = &ErrorView{Code: forgeErr.Code, Message: forgeErr.Message}
	case err != nil:
		return nil, err
	case len(status.Installations) > 0:
		status.State = "ready"
	}
	return status, nil
}

func (g *GitHub) installationView(ctx context.Context, inst *gh.Installation) (InstallationView, error) {
	view := InstallationView{
		ID: inst.GetID(), Account: inst.GetAccount().GetLogin(), AccountType: inst.GetAccount().GetType(),
		RepositorySelection: inst.GetRepositorySelection(), ManageURL: inst.GetHTMLURL(), Repositories: []string{},
	}
	t, err := g.token(ctx, inst.GetID())
	if err != nil {
		return view, err
	}
	repos, _, err := g.client(gh.WithAuthToken(t.value)).Apps.ListRepos(ctx, &gh.ListOptions{PerPage: 100})
	if err != nil {
		return view, fromGitHub(err)
	}
	view.TotalRepositories = repos.GetTotalCount()
	for _, repo := range repos.Repositories {
		view.Repositories = append(view.Repositories, repo.GetFullName())
	}
	return view, nil
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
