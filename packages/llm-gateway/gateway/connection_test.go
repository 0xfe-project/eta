package gateway

import (
	"testing"
	"time"

	coreauth "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
)

func TestNormalize(t *testing.T) {
	now := time.Date(2026, 10, 7, 0, 0, 0, 0, time.UTC)
	later := now.Add(time.Hour)
	cases := []struct {
		name  string
		auth  coreauth.Auth
		state string
		code  string
		retry bool
	}{
		{"active", coreauth.Auth{Status: coreauth.StatusActive}, StateActive, "", false},
		{"refreshing is usable", coreauth.Auth{Status: coreauth.StatusRefreshing}, StateActive, "", false},
		{"disabled", coreauth.Auth{Disabled: true, Status: coreauth.StatusDisabled}, StateDisabled, "", false},
		{"quota", coreauth.Auth{Status: coreauth.StatusError, Quota: coreauth.QuotaState{Exceeded: true, NextRecoverAt: later}}, StateRateLimited, "QUOTA_EXCEEDED", true},
		{"429 cooldown", coreauth.Auth{Unavailable: true, NextRetryAfter: later, LastError: &coreauth.Error{HTTPStatus: 429}}, StateRateLimited, "RATE_LIMITED", true},
		{"401", coreauth.Auth{Status: coreauth.StatusError, LastError: &coreauth.Error{HTTPStatus: 401}}, StateNeedsLogin, "AUTH_EXPIRED", false},
		{"refresh failure", coreauth.Auth{Status: coreauth.StatusError, StatusMessage: "refresh token: invalid_grant"}, StateNeedsLogin, "AUTH_EXPIRED", false},
		{"403 cooldown", coreauth.Auth{Status: coreauth.StatusError, Unavailable: true, NextRetryAfter: later, LastError: &coreauth.Error{HTTPStatus: 403}}, StateError, "UPSTREAM_ERROR", true},
		{"5xx cooldown", coreauth.Auth{Unavailable: true, NextRetryAfter: later, LastError: &coreauth.Error{HTTPStatus: 502}}, StateDegraded, "UPSTREAM_UNSTABLE", true},
		{"timeout cooldown", coreauth.Auth{Unavailable: true, NextRetryAfter: later, LastError: &coreauth.Error{Message: "context deadline exceeded"}}, StateDegraded, "UPSTREAM_UNSTABLE", true},
		// CPA leaves StatusError and LastError behind until a request
		// succeeds; once the cooldown is over the account is usable again.
		{"ended 5xx cooldown", coreauth.Auth{Status: coreauth.StatusError, Unavailable: true, NextRetryAfter: now.Add(-time.Second), LastError: &coreauth.Error{HTTPStatus: 502}}, StateActive, "", false},
		{"ended 403 cooldown", coreauth.Auth{Status: coreauth.StatusError, Unavailable: true, NextRetryAfter: now.Add(-time.Second), LastError: &coreauth.Error{HTTPStatus: 403}}, StateActive, "", false},
		{"one model's 502", coreauth.Auth{Status: coreauth.StatusError, Unavailable: true, NextRetryAfter: later, LastError: &coreauth.Error{HTTPStatus: 502}, ModelStates: map[string]*coreauth.ModelState{
			"gpt": {Unavailable: true, NextRetryAfter: later, LastError: &coreauth.Error{HTTPStatus: 502}},
		}}, StateActive, "", false},
		{"one model's quota", coreauth.Auth{Quota: coreauth.QuotaState{Exceeded: true, Reason: "quota", NextRecoverAt: later}, ModelStates: map[string]*coreauth.ModelState{
			"gpt": {Unavailable: true, NextRetryAfter: later, Quota: coreauth.QuotaState{Exceeded: true, NextRecoverAt: later}, LastError: &coreauth.Error{HTTPStatus: 429}},
		}}, StateActive, "", false},
		{"credential quota", coreauth.Auth{Quota: coreauth.QuotaState{Exceeded: true, Reason: "credential_quota", NextRecoverAt: later}, ModelStates: map[string]*coreauth.ModelState{
			"gpt": {Unavailable: true, NextRetryAfter: later, LastError: &coreauth.Error{HTTPStatus: 429}},
		}}, StateRateLimited, "QUOTA_EXCEEDED", true},
		{"expired quota is active", coreauth.Auth{Quota: coreauth.QuotaState{Exceeded: true, NextRecoverAt: now.Add(-time.Minute)}}, StateActive, "", false},
		{"model-level 401", coreauth.Auth{Status: coreauth.StatusActive, ModelStates: map[string]*coreauth.ModelState{
			"gpt": {Unavailable: true, NextRetryAfter: later, LastError: &coreauth.Error{HTTPStatus: 401}},
		}}, StateNeedsLogin, "AUTH_EXPIRED", false},
		// CPA still routes models with no state of their own to it.
		{"every tried model rate limited", coreauth.Auth{Status: coreauth.StatusActive, ModelStates: map[string]*coreauth.ModelState{
			"a": {Unavailable: true, NextRetryAfter: later, LastError: &coreauth.Error{HTTPStatus: 429}},
			"b": {Unavailable: true, NextRetryAfter: later, LastError: &coreauth.Error{HTTPStatus: 429}},
		}}, StateActive, "", false},
		{"one model rate limited", coreauth.Auth{Status: coreauth.StatusActive, ModelStates: map[string]*coreauth.ModelState{
			"a": {Unavailable: true, NextRetryAfter: later, LastError: &coreauth.Error{HTTPStatus: 429}},
			"b": {},
		}}, StateActive, "", false},
	}
	for _, c := range cases {
		c.auth.ID = "a.json"
		c.auth.Metadata = map[string]any{"email": "a@example.com"}
		got := normalize(&c.auth, "codex", now)
		code := ""
		if got.Error != nil {
			code = got.Error.Code
		}
		if got.State != c.state || code != c.code || (got.RetryAt != nil) != c.retry {
			t.Errorf("%s: got state=%s code=%s retry=%v", c.name, got.State, code, got.RetryAt)
		}
		if got.Label != "a@example.com" || got.fileName != "a.json" {
			t.Errorf("%s: label=%q file=%q", c.name, got.Label, got.fileName)
		}
	}
}
