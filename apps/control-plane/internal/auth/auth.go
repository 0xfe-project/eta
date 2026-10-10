// Package auth is runtimes' credentials, derived from the control plane's
// secret and the agent, so nothing stores them.
//
// An agent's key ("<agent id>.<token>") is what its runtime and plugins show
// AXP's services through the runtime gateway; it works as long as the agent
// exists. The control token is the controller's credential for the agent's
// runtime's control API. Agents never learn each other's: identity in
// request bodies is never trusted.
package auth

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"strings"
)

func sign(secret []byte, message string) string {
	mac := hmac.New(sha256.New, secret)
	mac.Write([]byte(message))
	return hex.EncodeToString(mac.Sum(nil))
}

// AgentKey is the agent's key for AXP's services.
func AgentKey(secret []byte, agentID string) string {
	return agentID + "." + sign(secret, "agent:"+agentID)
}

// AgentOf is the agent whose key this is, or "".
func AgentOf(secret []byte, key string) string {
	agentID, _, _ := strings.Cut(key, ".")
	if agentID == "" || !Matches(key, AgentKey(secret, agentID)) {
		return ""
	}
	return agentID
}

// ControlToken is the controller's credential for the agent's runtime.
func ControlToken(secret []byte, agentID string) string {
	return sign(secret, "control:"+agentID)
}

// Matches compares tokens in constant time.
func Matches(token, expected string) bool {
	return hmac.Equal([]byte(token), []byte(expected))
}

// Bearer is the request's bearer token, or "".
func Bearer(r *http.Request) string {
	token, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
	if !ok {
		return ""
	}
	return token
}
