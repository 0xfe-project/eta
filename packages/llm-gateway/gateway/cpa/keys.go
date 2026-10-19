package cpa

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"net/http"
	"regexp"
	"strings"
	"sync"

	sdkaccess "github.com/router-for-me/CLIProxyAPI/v8/sdk/access"
)

// scopePattern is what a scope (an agent's id) may be: no dots, so a key
// splits unambiguously.
var scopePattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)

// ScopedKey is the key the host hands one agent for /v1 only: "etak.<scope>."
// and an HMAC of the scope under the host's key. It is derived, not stored, so
// the host (which holds the host key) makes one without a call and the gateway
// checks it without a table; Keys.Revoke is the one piece of state.
// It returns "" for a scope that is not a plain id.
func ScopedKey(hostKey, scope string) string {
	if !scopePattern.MatchString(scope) || hostKey == "" {
		return ""
	}
	return "etak." + scope + "." + macOf(hostKey, scope)
}

func macOf(hostKey, scope string) string {
	mac := hmac.New(sha256.New, []byte(hostKey))
	mac.Write([]byte("eta-llm-scope:" + scope))
	return hex.EncodeToString(mac.Sum(nil))
}

// Keys is the access provider for /v1: the host's own key, and the scoped
// keys derived from it that have not been revoked. Nothing else gets in, and
// the account API (/api/llm) takes the host key alone.
type Keys struct {
	hostKey string

	mu      sync.RWMutex
	revoked map[string]struct{}
}

// NewKeys admits hostKey and the keys derived from it.
func NewKeys(hostKey string) *Keys {
	return &Keys{hostKey: hostKey, revoked: map[string]struct{}{}}
}

// Revoke ends every key of a scope until the gateway restarts (a restart
// changes the host key, which ends them all anyway).
func (k *Keys) Revoke(scope string) {
	k.mu.Lock()
	k.revoked[scope] = struct{}{}
	k.mu.Unlock()
}

// Principal says whose key a bearer value is: "host", the scope of a scoped
// key, or "" when it is neither (or the scope was revoked).
func (k *Keys) Principal(bearer string) string {
	if k.hostKey == "" || bearer == "" {
		return ""
	}
	if subtle.ConstantTimeCompare([]byte(bearer), []byte(k.hostKey)) == 1 {
		return "host"
	}
	parts := strings.Split(bearer, ".")
	if len(parts) != 3 || parts[0] != "etak" || !scopePattern.MatchString(parts[1]) {
		return ""
	}
	if subtle.ConstantTimeCompare([]byte(parts[2]), []byte(macOf(k.hostKey, parts[1]))) != 1 {
		return ""
	}
	k.mu.RLock()
	_, revoked := k.revoked[parts[1]]
	k.mu.RUnlock()
	if revoked {
		return ""
	}
	return parts[1]
}

func (*Keys) Identifier() string { return "eta-host" }

func (k *Keys) Authenticate(_ context.Context, r *http.Request) (*sdkaccess.Result, *sdkaccess.AuthError) {
	got := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	if got == "" || got == r.Header.Get("Authorization") {
		return nil, sdkaccess.NewNoCredentialsError()
	}
	principal := k.Principal(got)
	if principal == "" {
		return nil, sdkaccess.NewInvalidCredentialError()
	}
	return &sdkaccess.Result{Provider: "eta-host", Principal: principal}, nil
}
