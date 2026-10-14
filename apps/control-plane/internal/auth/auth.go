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
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
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

// Seal encrypts what the control plane keeps for the user (bundles'
// configs): AES-256-GCM with a key derived from the secret for the purpose,
// which also binds the result to it.
func Seal(secret []byte, purpose string, plain []byte) ([]byte, error) {
	a, err := aead(secret, purpose)
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, a.NonceSize())
	_, _ = rand.Read(nonce)
	return a.Seal(nonce, nonce, plain, []byte(purpose)), nil
}

// Open decrypts what Seal sealed for the purpose; it fails once the secret
// has changed.
func Open(secret []byte, purpose string, sealed []byte) ([]byte, error) {
	a, err := aead(secret, purpose)
	if err != nil {
		return nil, err
	}
	if len(sealed) < a.NonceSize() {
		return nil, errors.New("sealed data too short")
	}
	return a.Open(nil, sealed[:a.NonceSize()], sealed[a.NonceSize():], []byte(purpose))
}

func aead(secret []byte, purpose string) (cipher.AEAD, error) {
	mac := hmac.New(sha256.New, secret)
	mac.Write([]byte("seal:" + purpose))
	block, err := aes.NewCipher(mac.Sum(nil))
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}

// BundleToken is a bundle's service's credential for the runtime gateway
// ("bundle.<name>.<token>"); it works while the bundle's service uses AXP.
func BundleToken(secret []byte, bundle string) string {
	return "bundle." + bundle + "." + sign(secret, "bundle:"+bundle)
}

// BundleOf is the bundle whose token this is, or "".
func BundleOf(secret []byte, token string) string {
	rest, ok := strings.CutPrefix(token, "bundle.")
	name, _, _ := strings.Cut(rest, ".")
	if !ok || name == "" || !Matches(token, BundleToken(secret, name)) {
		return ""
	}
	return name
}

// BundleSecret is a secret of the bundle's service's own (purpose
// separates several), which the control plane can derive too: the agenvo
// relay's administrator secret, its database's password.
func BundleSecret(secret []byte, purpose string) string {
	return sign(secret, "bundle-secret:"+purpose)
}
