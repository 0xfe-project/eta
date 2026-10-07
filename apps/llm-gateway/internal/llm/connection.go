package llm

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"path/filepath"
	"strings"
	"time"

	coreauth "github.com/router-for-me/CLIProxyAPI/v7/sdk/cliproxy/auth"
)

// Connection states shown to the user.
const (
	StateActive      = "active"
	StateDisabled    = "disabled"
	StateNeedsLogin  = "needs_login"
	StateRateLimited = "rate_limited"
	StateError       = "error"
)

// ConnectionError is a product-level explanation; raw upstream errors are only logged.
type ConnectionError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// Connection is a credential as the UI sees it. It never carries tokens.
type Connection struct {
	ID        string           `json:"id"`
	Connector string           `json:"connector"`
	Label     string           `json:"label"`
	Plan      string           `json:"plan,omitempty"`
	State     string           `json:"state"`
	Error     *ConnectionError `json:"error,omitempty"`
	RetryAt   *time.Time       `json:"retry_at,omitempty"`
	CreatedAt time.Time        `json:"created_at"`
	// fileName is the auth file managed through CPA's management API.
	fileName string
}

// normalize maps a CPA auth record to a Connection.
func normalize(a *coreauth.Auth, connector string, now time.Time) Connection {
	c := Connection{
		ID:        a.ID,
		Connector: connector,
		Label:     label(a),
		Plan:      plan(a),
		State:     StateActive,
		CreatedAt: a.CreatedAt,
		fileName:  fileName(a),
	}
	httpStatus := 0
	detail := strings.TrimSpace(a.StatusMessage)
	if a.LastError != nil {
		httpStatus = a.LastError.HTTPStatus
		if detail == "" {
			detail = strings.TrimSpace(a.LastError.Message)
		}
	}
	lower := strings.ToLower(detail)
	retry := func(t time.Time) {
		if t.After(now) {
			c.RetryAt = &t
		}
	}

	// CPA records request failures per model. A rejected credential fails
	// every model, so a 401 on any of them means the account needs a login;
	// when every model is cooling down, so is the account.
	if a.Status != coreauth.StatusError && httpStatus == 0 {
		cooling, earliest := 0, time.Time{}
		for _, ms := range a.ModelStates {
			if ms == nil || ms.LastError == nil {
				continue
			}
			if ms.LastError.HTTPStatus == http.StatusUnauthorized && (ms.Unavailable || ms.Status == coreauth.StatusError) {
				httpStatus = http.StatusUnauthorized
				break
			}
			if ms.Unavailable && ms.NextRetryAfter.After(now) {
				cooling++
				if earliest.IsZero() || ms.NextRetryAfter.Before(earliest) {
					earliest = ms.NextRetryAfter
				}
				if ms.LastError.HTTPStatus == http.StatusTooManyRequests || ms.Quota.Exceeded {
					httpStatus = http.StatusTooManyRequests
				}
			}
		}
		if httpStatus == http.StatusTooManyRequests && cooling < len(a.ModelStates) {
			httpStatus = 0 // some models still work
		}
		if httpStatus == http.StatusTooManyRequests && a.NextRetryAfter.Before(earliest) {
			a = withRetry(a, earliest)
		}
	}

	switch {
	case a.Disabled || a.Status == coreauth.StatusDisabled:
		c.State = StateDisabled
	case a.Quota.Exceeded && a.Quota.NextRecoverAt.After(now):
		c.State = StateRateLimited
		retry(a.Quota.NextRecoverAt)
		c.Error = &ConnectionError{"QUOTA_EXCEEDED", "额度已用尽，恢复后会自动继续使用。"}
	case httpStatus == http.StatusTooManyRequests && a.NextRetryAfter.After(now):
		c.State = StateRateLimited
		retry(a.NextRetryAfter)
		c.Error = &ConnectionError{"RATE_LIMITED", "请求过于频繁，稍后会自动恢复。"}
	case httpStatus == http.StatusUnauthorized || (a.Status == coreauth.StatusError && looksLikeAuthFailure(lower)):
		c.State = StateNeedsLogin
		c.Error = &ConnectionError{"AUTH_EXPIRED", "登录已失效，请重新登录。"}
	case a.Status == coreauth.StatusError || (a.Unavailable && a.NextRetryAfter.After(now)):
		c.State = StateError
		retry(a.NextRetryAfter)
		msg := "账号暂时不可用。"
		if httpStatus == http.StatusForbidden {
			msg = "上游拒绝了该账号（HTTP 403），可能没有使用权限或已被停用。"
		} else if httpStatus > 0 {
			msg = fmt.Sprintf("上游返回错误（HTTP %d），稍后会自动重试。", httpStatus)
		}
		c.Error = &ConnectionError{"UPSTREAM_ERROR", msg}
	}
	return c
}

func withRetry(a *coreauth.Auth, at time.Time) *coreauth.Auth {
	copy := *a
	copy.NextRetryAfter = at
	return &copy
}

// modelUsable reports whether a connection can currently serve model.
func modelUsable(a *coreauth.Auth, model string, now time.Time) bool {
	ms := a.ModelStates[model]
	if ms == nil {
		return true
	}
	if ms.Quota.Exceeded && ms.Quota.NextRecoverAt.After(now) {
		return false
	}
	return !(ms.Unavailable && ms.NextRetryAfter.After(now))
}

func looksLikeAuthFailure(msg string) bool {
	for _, s := range []string{"refresh", "invalid_grant", "unauthorized", "token expired", "token_expired", "revoked", "re-login", "relogin"} {
		if strings.Contains(msg, s) {
			return true
		}
	}
	return false
}

func label(a *coreauth.Auth) string {
	if email, _ := a.Metadata["email"].(string); email != "" {
		return email
	}
	if a.Label != "" {
		return a.Label
	}
	return a.ID
}

func plan(a *coreauth.Auth) string {
	if p := a.Attributes["plan_type"]; p != "" {
		return p
	}
	if p, _ := a.Metadata["plan_type"].(string); p != "" {
		return p
	}
	// Codex: the plan is a claim in the ID token.
	if tok, _ := a.Metadata["id_token"].(string); tok != "" {
		var claims struct {
			Auth struct {
				Plan string `json:"chatgpt_plan_type"`
			} `json:"https://api.openai.com/auth"`
		}
		if JWTClaims(tok, &claims) == nil {
			return claims.Auth.Plan
		}
	}
	return ""
}

func fileName(a *coreauth.Auth) string {
	if p := a.Attributes["path"]; p != "" {
		return filepath.Base(p)
	}
	if a.FileName != "" {
		return filepath.Base(a.FileName)
	}
	return filepath.Base(a.ID)
}

// JWTClaims decodes a JWT payload without verifying it. Use it only on tokens
// received directly from the issuer over TLS.
func JWTClaims(token string, out any) error {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return fmt.Errorf("malformed JWT")
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return err
	}
	return json.Unmarshal(payload, out)
}
