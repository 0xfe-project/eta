// Package edge checks that a request came through AXP's edge gateway.
package edge

import (
	"crypto/subtle"
	"net/http"
)

// Header carries the shared secret the gateway adds to every request.
const Header = "X-AXP-Edge-Secret"

// Valid reports whether r carries secret. An empty secret disables the check
// (tests and ad-hoc local runs).
func Valid(r *http.Request, secret string) bool {
	if secret == "" {
		return true
	}
	return subtle.ConstantTimeCompare([]byte(r.Header.Get(Header)), []byte(secret)) == 1
}

// Forbidden is the error body upstreams return to callers that bypass the gateway.
const Forbidden = `{"error":{"code":"FORBIDDEN","message":"请求被拒绝。"}}`
