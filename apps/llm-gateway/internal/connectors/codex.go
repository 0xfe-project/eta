package connectors

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/akarachen/axp/apps/llm-gateway/internal/llm"
)

// OpenAI's device authorization for Codex. CPA implements the same protocol
// only for its CLI (the user code is printed to stdout), so the steps are
// repeated here; the resulting credential is handed to CPA as a regular
// codex auth file through the management API.
const (
	CodexClientID          = "app_EMoamEEZ73f0CkXaXp7hrann"
	codexIssuer            = "https://auth.openai.com"
	codexVerificationURL   = "https://auth.openai.com/codex/device"
	codexDeviceRedirectURI = "https://auth.openai.com/deviceauth/callback"
	codexDeviceTimeout     = 15 * time.Minute
)

// Codex logs in to ChatGPT (Codex) with the device-code flow.
type Codex struct {
	Management    *http.Client
	ManagementURL func(string) string
	// HTTP talks to OpenAI; nil uses a client with a 30s timeout.
	HTTP *http.Client
	// Issuer overrides https://auth.openai.com in tests.
	Issuer string
	Logger *slog.Logger

	mu       sync.Mutex
	sessions map[string]*codexSession
}

type codexSession struct {
	llm.LoginSession
	cancel context.CancelFunc
}

func (c *Codex) Info() llm.ConnectorInfo {
	return llm.ConnectorInfo{
		ID:          "codex",
		DisplayName: "Codex",
		Flow:        llm.FlowDevice,
		Provider:    "codex",
		Hint:        "使用 ChatGPT 账号登录。如果授权页提示不允许设备码登录，请先在 ChatGPT 设置的“安全”中开启 Codex 的设备码授权。",
	}
}

func (c *Codex) issuer() string {
	if c.Issuer != "" {
		return strings.TrimSuffix(c.Issuer, "/")
	}
	return codexIssuer
}

func (c *Codex) client() *http.Client {
	if c.HTTP != nil {
		return c.HTTP
	}
	return &http.Client{Timeout: 30 * time.Second}
}

func (c *Codex) logger() *slog.Logger {
	if c.Logger != nil {
		return c.Logger
	}
	return slog.Default()
}

func (c *Codex) StartLogin(ctx context.Context) (*llm.LoginSession, error) {
	var code struct {
		DeviceAuthID string          `json:"device_auth_id"`
		UserCode     string          `json:"user_code"`
		UserCodeAlt  string          `json:"usercode"`
		Interval     json.RawMessage `json:"interval"`
	}
	status, err := c.postJSON(ctx, "/api/accounts/deviceauth/usercode", map[string]string{"client_id": CodexClientID}, &code)
	if err != nil || status/100 != 2 {
		return nil, &llm.UserError{Code: "LOGIN_START_FAILED", Message: "无法发起 Codex 登录，请稍后再试。",
			Cause: fmt.Errorf("device code request: status %d: %v", status, err)}
	}
	userCode := firstNonEmpty(code.UserCode, code.UserCodeAlt)
	if userCode == "" || code.DeviceAuthID == "" {
		return nil, &llm.UserError{Code: "LOGIN_START_FAILED", Message: "无法发起 Codex 登录，请稍后再试。",
			Cause: fmt.Errorf("device code response missing fields")}
	}

	pollCtx, cancel := context.WithTimeout(context.Background(), codexDeviceTimeout)
	sess := &codexSession{
		LoginSession: llm.LoginSession{
			ID:        "codex-" + randomHex(12),
			Connector: "codex",
			Flow:      llm.FlowDevice,
			Status:    llm.LoginPending,
			URL:       codexVerificationURL,
			UserCode:  userCode,
			ExpiresAt: time.Now().Add(codexDeviceTimeout),
		},
		cancel: cancel,
	}
	c.mu.Lock()
	if c.sessions == nil {
		c.sessions = map[string]*codexSession{}
	}
	c.sessions[sess.ID] = sess
	c.mu.Unlock()

	go c.complete(pollCtx, sess, code.DeviceAuthID, userCode, pollInterval(code.Interval))
	copy := sess.LoginSession
	return &copy, nil
}

// complete polls until the user approves, then exchanges the code for tokens
// and hands the credential to CPA.
func (c *Codex) complete(ctx context.Context, sess *codexSession, deviceAuthID, userCode string, interval time.Duration) {
	defer sess.cancel()
	var grant struct {
		AuthorizationCode string `json:"authorization_code"`
		CodeVerifier      string `json:"code_verifier"`
	}
	for {
		status, err := c.postJSON(ctx, "/api/accounts/deviceauth/token",
			map[string]string{"device_auth_id": deviceAuthID, "user_code": userCode}, &grant)
		if ctx.Err() != nil {
			c.finish(sess, llm.LoginExpired, "验证码已过期，请重新发起。")
			return
		}
		if err == nil && status/100 == 2 {
			break
		}
		// 403/404 mean "not approved yet"; anything else is final.
		if err == nil && status != http.StatusForbidden && status != http.StatusNotFound {
			c.logger().Warn("codex device polling failed", "status", status)
			c.finish(sess, llm.LoginFailed, "登录失败，请重试。")
			return
		}
		select {
		case <-ctx.Done():
			c.finish(sess, llm.LoginExpired, "验证码已过期，请重新发起。")
			return
		case <-time.After(interval):
		}
	}

	if err := c.exchangeAndStore(ctx, grant.AuthorizationCode, grant.CodeVerifier); err != nil {
		c.logger().Error("codex login failed", "error", err)
		c.finish(sess, llm.LoginFailed, "登录成功但保存凭据失败，请重试。")
		return
	}
	c.finish(sess, llm.LoginSucceeded, "")
}

func (c *Codex) exchangeAndStore(ctx context.Context, code, verifier string) error {
	form := url.Values{
		"grant_type":    {"authorization_code"},
		"client_id":     {CodexClientID},
		"code":          {code},
		"redirect_uri":  {codexDeviceRedirectURI},
		"code_verifier": {verifier},
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.issuer()+"/oauth/token", strings.NewReader(form.Encode()))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")
	res, err := c.client().Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(res.Body)
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("token exchange: status %d", res.StatusCode)
	}
	var tok struct {
		AccessToken  string `json:"access_token"`
		RefreshToken string `json:"refresh_token"`
		IDToken      string `json:"id_token"`
		ExpiresIn    int    `json:"expires_in"`
	}
	if err := json.Unmarshal(raw, &tok); err != nil {
		return err
	}
	cred, name, err := CodexCredential(tok.IDToken, tok.AccessToken, tok.RefreshToken, tok.ExpiresIn, time.Now())
	if err != nil {
		return err
	}
	return llm.Manage(ctx, c.Management, c.ManagementURL("/auth-files?name="+url.QueryEscape(name)), http.MethodPost, cred, nil)
}

// CodexCredential builds a credential in CPA's codex auth file format and
// its conventional file name.
func CodexCredential(idToken, accessToken, refreshToken string, expiresIn int, now time.Time) ([]byte, string, error) {
	var claims struct {
		Email string `json:"email"`
		Auth  struct {
			AccountID string `json:"chatgpt_account_id"`
			Plan      string `json:"chatgpt_plan_type"`
		} `json:"https://api.openai.com/auth"`
	}
	if err := llm.JWTClaims(idToken, &claims); err != nil {
		return nil, "", fmt.Errorf("parse id token: %w", err)
	}
	if claims.Email == "" || accessToken == "" || refreshToken == "" {
		return nil, "", fmt.Errorf("token response is missing account information")
	}
	cred, err := json.MarshalIndent(map[string]string{
		"type":          "codex",
		"id_token":      idToken,
		"access_token":  accessToken,
		"refresh_token": refreshToken,
		"account_id":    claims.Auth.AccountID,
		"email":         claims.Email,
		"expired":       now.Add(time.Duration(expiresIn) * time.Second).Format(time.RFC3339),
		"last_refresh":  now.Format(time.RFC3339),
	}, "", "  ")
	if err != nil {
		return nil, "", err
	}
	name := "codex"
	if claims.Auth.AccountID != "" {
		sum := sha256.Sum256([]byte(claims.Auth.AccountID))
		name += "-" + hex.EncodeToString(sum[:])[:8]
	}
	name += "-" + claims.Email
	if plan := strings.ToLower(strings.TrimSpace(claims.Auth.Plan)); plan != "" {
		name += "-" + plan
	}
	return cred, name + ".json", nil
}

func (c *Codex) finish(sess *codexSession, status, msg string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if sess.Status == llm.LoginPending {
		sess.Status = status
		sess.Error = msg
	}
}

func (c *Codex) PollLogin(_ context.Context, id string) (*llm.LoginSession, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	sess, ok := c.sessions[id]
	if !ok {
		return nil, llm.ErrNotFound
	}
	copy := sess.LoginSession
	return &copy, nil
}

func (c *Codex) CancelLogin(_ context.Context, id string) error {
	c.mu.Lock()
	sess, ok := c.sessions[id]
	delete(c.sessions, id)
	c.mu.Unlock()
	if !ok {
		return llm.ErrNotFound
	}
	sess.cancel()
	return nil
}

func (c *Codex) postJSON(ctx context.Context, path string, body any, out any) (int, error) {
	raw, _ := json.Marshal(body)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.issuer()+path, bytes.NewReader(raw))
	if err != nil {
		return 0, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	res, err := c.client().Do(req)
	if err != nil {
		return 0, err
	}
	defer res.Body.Close()
	data, _ := io.ReadAll(res.Body)
	if res.StatusCode/100 == 2 && out != nil {
		if err := json.Unmarshal(data, out); err != nil {
			return res.StatusCode, err
		}
	}
	return res.StatusCode, nil
}

func pollInterval(raw json.RawMessage) time.Duration {
	var s string
	if json.Unmarshal(raw, &s) == nil {
		if n, err := strconv.Atoi(strings.TrimSpace(s)); err == nil && n > 0 {
			return time.Duration(n) * time.Second
		}
	}
	var n int
	if json.Unmarshal(raw, &n) == nil && n > 0 {
		return time.Duration(n) * time.Second
	}
	return 5 * time.Second
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if v = strings.TrimSpace(v); v != "" {
			return v
		}
	}
	return ""
}

func randomHex(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}
