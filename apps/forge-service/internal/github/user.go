package github

// The user's authorization of the App: with it the App acts on the user's
// behalf (a user access token, ghu_), and GitHub shows what it does, such as
// opening a pull request, as the user's with the App's badge. Without it,
// or when GitHub no longer takes it, the App acts as its bot.
//
// The App asks for it while being installed (request_oauth_on_install), and
// the user can authorize later from the wizard. The token and its refresh
// token stay in user.json; they expire after 8 hours and 6 months, and each
// refresh replaces both. Exchanging and refreshing take the App's client
// secret, kept in github.secret.

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	gh "github.com/google/go-github/v92/github"
)

const (
	authorizationTTL = 15 * time.Minute
	// CallbackPath is where GitHub sends the browser after the user
	// authorized the App, as the App's callback URL.
	CallbackPath = "/api/forge/v1/github/authorization/callback"
)

// User is the user who authorized the App, with the token to act for them.
type User struct {
	Login            string `json:"login"`
	ID               int64  `json:"id"`
	AccessToken      string `json:"access_token"`
	ExpiresAt        int64  `json:"expires_at,omitempty"` // 0: does not expire
	RefreshToken     string `json:"refresh_token,omitempty"`
	RefreshExpiresAt int64  `json:"refresh_expires_at,omitempty"`
}

type authorizing struct {
	verifier    string
	redirectURI string
	at          time.Time
}

func (g *GitHub) oauthURL() string {
	if g.OAuthURL != "" {
		return strings.TrimSuffix(g.OAuthURL, "/")
	}
	return WebURL
}

// clientSecret is the App's client secret, or "" before AXP has it.
func (g *GitHub) clientSecret() string {
	data, err := os.ReadFile(g.path("github.secret"))
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(data))
}

// SetOAuthClient saves the client ID and secret of an App created before
// AXP kept them; the user copies them from the App's settings.
func (g *GitHub) SetOAuthClient(clientID, secret string) error {
	app, err := g.require()
	if err != nil {
		return err
	}
	clientID, secret = strings.TrimSpace(clientID), strings.TrimSpace(secret)
	if clientID == "" || secret == "" || strings.ContainsAny(clientID+secret, " \t\r\n") {
		return newError("INVALID_CLIENT", http.StatusBadRequest, "请填写 App 设置页里的 Client ID 和新生成的 client secret。")
	}
	if err := write(g.path("github.secret"), []byte(secret), 0o600); err != nil {
		return err
	}
	app.ClientID = clientID
	return g.save(app)
}

// StartAuthorization returns where to send the browser for the user to
// authorize the App; GitHub comes back to CallbackPath under origin.
func (g *GitHub) StartAuthorization(origin string) (string, error) {
	app, err := g.require()
	if err != nil {
		return "", err
	}
	if app.ClientID == "" || g.clientSecret() == "" {
		return "", newError("OAUTH_NOT_CONFIGURED", http.StatusConflict,
			"AXP 还没有这个 App 的 client secret。请先在 App 设置页添加 Callback URL、生成 client secret 并填入 AXP。")
	}
	u, err := url.Parse(origin)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return "", newError("INVALID_ORIGIN", http.StatusBadRequest, "无法确定 AXP 的访问地址。")
	}
	state, verifier := random(), random()
	redirectURI := u.Scheme + "://" + u.Host + CallbackPath
	g.mu.Lock()
	now := g.Now()
	for s, a := range g.authorizing {
		if now.Sub(a.at) >= authorizationTTL {
			delete(g.authorizing, s)
		}
	}
	if g.authorizing == nil {
		g.authorizing = map[string]authorizing{}
	}
	g.authorizing[state] = authorizing{verifier: verifier, redirectURI: redirectURI, at: now}
	g.mu.Unlock()
	challenge := sha256.Sum256([]byte(verifier))
	q := url.Values{
		"client_id":             {app.ClientID},
		"redirect_uri":          {redirectURI},
		"state":                 {state},
		"code_challenge":        {base64.RawURLEncoding.EncodeToString(challenge[:])},
		"code_challenge_method": {"S256"},
	}
	return g.oauthURL() + "/login/oauth/authorize?" + q.Encode(), nil
}

func random() string {
	b := make([]byte, 32)
	_, _ = rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b)
}

// FinishAuthorization exchanges GitHub's code for the user's token. The code
// comes back either for an authorization AXP started (with its state) or
// right after an installation (setup_action, no state). Either way the user
// must reach an installation of this App, so nobody else's account ends up
// connected.
func (g *GitHub) FinishAuthorization(ctx context.Context, code, state, setupAction string) (*User, error) {
	app, err := g.require()
	if err != nil {
		return nil, err
	}
	form := url.Values{"client_id": {app.ClientID}, "client_secret": {g.clientSecret()}, "code": {code}}
	if state != "" {
		g.mu.Lock()
		a, ok := g.authorizing[state]
		delete(g.authorizing, state)
		g.mu.Unlock()
		if !ok || g.Now().Sub(a.at) >= authorizationTTL {
			return nil, newError("AUTHORIZATION_EXPIRED", http.StatusBadRequest, "这次授权已失效，请回到 AXP 重新授权。")
		}
		form.Set("code_verifier", a.verifier)
		form.Set("redirect_uri", a.redirectURI)
	} else if setupAction == "" {
		return nil, newError("AUTHORIZATION_EXPIRED", http.StatusBadRequest, "这次授权已失效，请回到 AXP 重新授权。")
	}
	if app.ClientID == "" || form.Get("client_secret") == "" {
		return nil, newError("OAUTH_NOT_CONFIGURED", http.StatusConflict, "AXP 还没有这个 App 的 client secret，无法完成授权。")
	}
	user, err := g.exchange(ctx, form)
	if err != nil {
		return nil, err
	}
	client := g.client(gh.WithAuthToken(user.AccessToken))
	me, _, err := client.Users.Get(ctx, "")
	if err != nil {
		return nil, fromGitHub(err)
	}
	user.Login, user.ID = me.GetLogin(), me.GetID()
	installations, _, err := client.Apps.ListUserInstallations(ctx, &gh.ListOptions{PerPage: 100})
	if err != nil {
		return nil, fromGitHub(err)
	}
	reaches := false
	for _, inst := range installations {
		reaches = reaches || inst.GetAppID() == app.ID
	}
	if !reaches {
		return nil, newError("AUTHORIZATION_UNRELATED", http.StatusForbidden,
			"授权的 GitHub 账号 %s 访问不到这个 App 的任何安装，AXP 没有保存它。", user.Login)
	}
	g.userMu.Lock()
	defer g.userMu.Unlock()
	return user, g.saveUser(user)
}

// exchange posts to GitHub's token endpoint: an authorization code or a
// refresh token for a new user access token.
func (g *GitHub) exchange(ctx context.Context, form url.Values) (*User, error) {
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, g.oauthURL()+"/login/oauth/access_token", strings.NewReader(form.Encode()))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "axp-forge")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, newError("GITHUB_UNREACHABLE", http.StatusFailedDependency, "暂时连不上 GitHub。")
	}
	defer resp.Body.Close()
	var out struct {
		AccessToken           string `json:"access_token"`
		ExpiresIn             int64  `json:"expires_in"`
		RefreshToken          string `json:"refresh_token"`
		RefreshTokenExpiresIn int64  `json:"refresh_token_expires_in"`
		Error                 string `json:"error"`
		ErrorDescription      string `json:"error_description"`
	}
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err := json.Unmarshal(data, &out); err != nil || resp.StatusCode != http.StatusOK {
		return nil, newError("GITHUB_ERROR", http.StatusFailedDependency, "GitHub 返回 %d。", resp.StatusCode)
	}
	if out.Error != "" || out.AccessToken == "" {
		return nil, &Error{Code: "AUTHORIZATION_FAILED", Status: http.StatusFailedDependency,
			Message: fmt.Sprintf("GitHub 没有给出授权（%s）：%s", out.Error, out.ErrorDescription)}
	}
	now := g.Now()
	user := &User{AccessToken: out.AccessToken, RefreshToken: out.RefreshToken}
	if out.ExpiresIn > 0 {
		user.ExpiresAt = now.Add(time.Duration(out.ExpiresIn) * time.Second).Unix()
	}
	if out.RefreshTokenExpiresIn > 0 {
		user.RefreshExpiresAt = now.Add(time.Duration(out.RefreshTokenExpiresIn) * time.Second).Unix()
	}
	return user, nil
}

// AuthorizedUser is who authorized the App, or nil.
func (g *GitHub) AuthorizedUser() (*User, error) {
	data, err := os.ReadFile(g.path("user.json"))
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var user User
	return &user, json.Unmarshal(data, &user)
}

// saveUser writes user.json; g.userMu is held.
func (g *GitHub) saveUser(user *User) error {
	data, err := json.MarshalIndent(user, "", "  ")
	if err != nil {
		return err
	}
	return write(g.path("user.json"), data, 0o600)
}

// dropUser forgets the user's authorization (GitHub refused it).
func (g *GitHub) dropUser() {
	g.userMu.Lock()
	defer g.userMu.Unlock()
	_ = os.Remove(g.path("user.json"))
}

// userToken returns the user and a current token, refreshing it first when
// it is close to expiry. A user is nil when nobody authorized the App;
// reason says why a user who had is not usable now.
func (g *GitHub) userToken(ctx context.Context) (user *User, reason string) {
	// One refresh at a time: a refresh token works once.
	g.userMu.Lock()
	defer g.userMu.Unlock()
	user, err := g.AuthorizedUser()
	if err != nil || user == nil {
		return nil, ""
	}
	now := g.Now()
	if user.ExpiresAt == 0 || time.Unix(user.ExpiresAt, 0).Sub(now) > tokenMargin {
		return user, ""
	}
	app, err := g.require()
	if err != nil {
		return nil, ""
	}
	if user.RefreshToken == "" || (user.RefreshExpiresAt != 0 && now.Unix() >= user.RefreshExpiresAt) {
		_ = os.Remove(g.path("user.json"))
		return nil, "你对 App 的授权已过期，请在 AXP 的“能力”页重新授权"
	}
	fresh, err := g.exchange(ctx, url.Values{
		"client_id": {app.ClientID}, "client_secret": {g.clientSecret()},
		"grant_type": {"refresh_token"}, "refresh_token": {user.RefreshToken},
	})
	var forgeErr *Error
	if errors.As(err, &forgeErr) && forgeErr.Code == "AUTHORIZATION_FAILED" {
		_ = os.Remove(g.path("user.json"))
		return nil, "GitHub 不再接受你对 App 的授权，请在 AXP 的“能力”页重新授权"
	}
	if err != nil {
		return nil, "暂时无法刷新你对 App 的授权"
	}
	fresh.Login, fresh.ID = user.Login, user.ID
	if err := g.saveUser(fresh); err != nil {
		return nil, "无法保存刷新后的授权"
	}
	return fresh, ""
}

// ForgetUser revokes the user's authorization on GitHub (best effort) and
// here.
func (g *GitHub) ForgetUser(ctx context.Context) error {
	g.userMu.Lock()
	defer g.userMu.Unlock()
	user, err := g.AuthorizedUser()
	if err != nil || user == nil {
		return err
	}
	if app, _ := g.App(); app != nil && app.ClientID != "" && g.clientSecret() != "" {
		basic := gh.BasicAuthTransport{Username: app.ClientID, Password: g.clientSecret()}
		_, _ = g.client(gh.WithTransport(&basic)).Authorizations.DeleteGrant(ctx, app.ClientID, user.AccessToken)
	}
	if err := os.Remove(g.path("user.json")); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	return nil
}
