package gateway

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"path/filepath"
	"strings"
	"time"

	coreauth "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
)

// Connection states shown to the user.
const (
	StateActive      = "active"
	StateDisabled    = "disabled"
	StateNeedsLogin  = "needs_login"
	StateRateLimited = "rate_limited"
	StateError       = "error"
	// StateDegraded is a transient upstream failure (timeouts, 5xx): the
	// account recovers by itself when its cooldown ends.
	StateDegraded = "degraded"
)

// Connection is a credential as the UI sees it. It never carries tokens.
type Connection struct {
	ID        string     `json:"id"`
	Connector string     `json:"connector"`
	Label     string     `json:"label"`
	Plan      string     `json:"plan,omitempty"`
	State     string     `json:"state"`
	Error     *Problem   `json:"error,omitempty"`
	RetryAt   *time.Time `json:"retry_at,omitempty"`
	CreatedAt time.Time  `json:"created_at"`
	// CheckedAt is when the account was last checked against its provider
	// (see Service.Usage); CheckError is why that check failed.
	CheckedAt  *time.Time `json:"checked_at,omitempty"`
	CheckError *Problem   `json:"check_error,omitempty"`
	// fileName is the auth file managed through CPA's management API.
	fileName string
}

// normalize maps a CPA auth record to a Connection.
//
// It follows CPA's own routing (selector.isAuthBlockedForModel): once a
// credential has per-model states, a failure blocks only its model, and CPA
// still routes every other model to it. CPA also leaves the credential in
// StatusError with the last failure until a request succeeds, and
// aggregates one model's 429 into the credential's quota; neither takes the
// account down here. Only what is about the credential does: a rejected
// login, a credential-wide quota, or a failure before any model was tried.
// Cooldowns end by themselves, whatever the sticky status says.
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
	retry := func(t time.Time) {
		if t.After(now) {
			c.RetryAt = &t
		}
	}
	perModel := len(a.ModelStates) > 0
	status := 0
	if a.LastError != nil {
		status = a.LastError.HTTPStatus
	}

	switch {
	case disabled(a):
		c.State = StateDisabled
	case loginRejected(a, now):
		c.State = StateNeedsLogin
		c.Error = problem(CodeLoginExpired, "The login is no longer accepted; sign in again.")
	case a.Quota.Exceeded && a.Quota.NextRecoverAt.After(now) && (!perModel || a.Quota.Reason == "credential_quota"):
		c.State = StateRateLimited
		retry(a.Quota.NextRecoverAt)
		c.Error = problem(CodeQuotaExhausted, "The account quota is used up; it recovers by itself.")
	case perModel || !a.Unavailable || !a.NextRetryAfter.After(now):
		// Usable; any model's own trouble is on that model (modelStatus).
	case status == http.StatusTooManyRequests:
		c.State = StateRateLimited
		retry(a.NextRetryAfter)
		c.Error = problem(CodeRateLimited, "Too many requests; the account recovers by itself.")
	case status == http.StatusPaymentRequired || status == http.StatusForbidden:
		c.State = StateError
		retry(a.NextRetryAfter)
		c.Error = problem(CodeUpstreamError, fmt.Sprintf("The provider refused the account (HTTP %d).", status), "status", status)
	default:
		c.State = StateDegraded
		retry(a.NextRetryAfter)
		c.Error = transient(status)
	}
	return c
}

// disabled reports a credential that serves nothing: disabled, or a config
// API key that excludes every model (how CPA disables those).
func disabled(a *coreauth.Auth) bool {
	if a.Disabled || a.Status == coreauth.StatusDisabled {
		return true
	}
	for _, m := range strings.Split(a.Attributes["excluded_models"], ",") {
		if strings.TrimSpace(m) == "*" {
			return true
		}
	}
	return false
}

// modelCooldown is when CPA will route a model again, zero when it does now.
func modelCooldown(ms *coreauth.ModelState, now time.Time) time.Time {
	if ms.Status == coreauth.StatusDisabled {
		return now.Add(100 * 365 * 24 * time.Hour)
	}
	var until time.Time
	if ms.Unavailable && ms.NextRetryAfter.After(now) {
		until = ms.NextRetryAfter
	}
	if ms.Quota.Exceeded && ms.Quota.NextRecoverAt.After(until) && ms.Quota.NextRecoverAt.After(now) {
		until = ms.Quota.NextRecoverAt
	}
	return until
}

func modelErrorStatus(ms *coreauth.ModelState) int {
	if ms.Quota.Exceeded {
		return http.StatusTooManyRequests
	}
	if ms.LastError != nil {
		return ms.LastError.HTTPStatus
	}
	return 0
}

// loginRejected reports a credential the provider no longer accepts. A 401
// is about the credential whichever model it came from.
func loginRejected(a *coreauth.Auth, now time.Time) bool {
	if coreauth.HasUnauthorizedAuthFailure(a) {
		return true
	}
	if a.Status == coreauth.StatusError {
		if a.LastError != nil && a.LastError.HTTPStatus == http.StatusUnauthorized {
			return true
		}
		msg := strings.TrimSpace(a.StatusMessage)
		if msg == "" && a.LastError != nil {
			msg = a.LastError.Message
		}
		if looksLikeAuthFailure(strings.ToLower(msg)) {
			return true
		}
	}
	for _, ms := range a.ModelStates {
		if ms != nil && ms.LastError != nil && ms.LastError.HTTPStatus == http.StatusUnauthorized &&
			(ms.Status == coreauth.StatusError || ms.Unavailable) && !modelCooldown(ms, now).IsZero() {
			return true
		}
	}
	return false
}

// transient is a failure that clears by itself: a provider error with its
// HTTP status, or no status when the provider could not be reached.
func transient(status int) *Problem {
	if status > 0 {
		return problem(CodeUpstreamUnstable, fmt.Sprintf("The provider failed temporarily (HTTP %d); retrying.", status), "status", status)
	}
	return problem(CodeUpstreamUnreachable, "The provider could not be reached; retrying.")
}

// Model states. A degraded model still takes requests: the failure was
// transient and CPA retries it when its short cooldown ends.
const (
	ModelAvailable   = "available"
	ModelDegraded    = "degraded"
	ModelUnavailable = "unavailable"
)

// modelStatus is what one account can do for model now, given the
// account's own state. name is the provider's display name; apiKey is
// whether its credentials are API keys.
func modelStatus(a *coreauth.Auth, conn Connection, model, name string, apiKey bool, now time.Time) (string, *Problem, *time.Time) {
	switch conn.State {
	case StateActive:
	case StateDegraded:
		return ModelDegraded, conn.Error, conn.RetryAt
	default:
		return ModelUnavailable, connectionReason(name, apiKey, conn), conn.RetryAt
	}
	ms := a.ModelStates[model]
	if ms == nil {
		return ModelAvailable, nil, nil
	}
	until := modelCooldown(ms, now)
	if until.IsZero() {
		return ModelAvailable, nil, nil
	}
	retry := &until
	if ms.Status == coreauth.StatusDisabled {
		return ModelUnavailable, problem(CodeModelDisabled, "The model is disabled."), nil
	}
	switch status := modelErrorStatus(ms); status {
	case http.StatusTooManyRequests:
		return ModelUnavailable, problem(CodeModelQuotaExhausted, name+" account: the quota for this model is used up.", "provider", name), retry
	case http.StatusPaymentRequired, http.StatusForbidden:
		return ModelUnavailable, problem(CodeModelForbidden, fmt.Sprintf("%s account may not use this model (HTTP %d).", name, status), "provider", name, "status", status), retry
	case http.StatusNotFound:
		return ModelUnavailable, problem(CodeModelNotFound, name+" does not offer this model (HTTP 404).", "provider", name), retry
	default:
		return ModelDegraded, transient(status), retry
	}
}

// connectionReason explains a model that is unavailable because of the
// account serving it.
func connectionReason(name string, apiKey bool, c Connection) *Problem {
	switch c.State {
	case StateNeedsLogin:
		if apiKey {
			return problem(CodeInvalidAPIKey, name+" API key is invalid.", "provider", name)
		}
		return problem(CodeLoginExpired, name+" login is no longer accepted.", "provider", name)
	case StateRateLimited:
		return problem(CodeQuotaExhausted, name+" account quota is used up.", "provider", name)
	case StateError:
		if c.Error != nil {
			p := *c.Error
			p.Params = Params{"provider": name}
			for k, v := range c.Error.Params {
				p.Params[k] = v
			}
			return &p
		}
		return problem(CodeUpstreamError, name+" account is unavailable.", "provider", name)
	case StateDisabled:
		return problem(CodeAccountDisabled, name+" account is disabled.", "provider", name)
	case StateDegraded:
		return c.Error
	}
	return problem(CodeNoConnection, "No "+name+" account is linked.", "provider", name)
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
	// An API key: its last four characters, as providers show keys.
	if key := a.Attributes["api_key"]; len(key) >= 8 {
		return "…" + key[len(key)-4:]
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
