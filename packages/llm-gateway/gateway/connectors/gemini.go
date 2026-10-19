package connectors

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/0xfe-project/eta/packages/llm-gateway/gateway"
	"github.com/0xfe-project/eta/packages/llm-gateway/gateway/cpa"
	coreauth "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
)

const (
	geminiAPI          = "https://generativelanguage.googleapis.com"
	geminiLoginTimeout = 30 * time.Minute
)

// Gemini takes a Google AI Studio API key. CPA serves the key as a
// gemini-api-key entry of its config, with its built-in Gemini models;
// providers.json (Keys) is where the key is kept, and every change is
// written there before CPA's management API applies it.
type Gemini struct {
	Management    *http.Client
	ManagementURL func(string) string
	Keys          *cpa.Providers
	// HTTP talks to Google; nil uses a client with a 30s timeout.
	HTTP *http.Client
	// API overrides https://generativelanguage.googleapis.com in tests.
	API string

	mu       sync.Mutex
	sessions map[string]*gateway.LoginSession
}

func (g *Gemini) Info() gateway.ConnectorInfo {
	return gateway.ConnectorInfo{
		ID:          "gemini",
		DisplayName: "Google AI Studio",
		Flow:        gateway.FlowAPIKey,
		Provider:    "gemini",
	}
}

func (g *Gemini) client() *http.Client {
	if g.HTTP != nil {
		return g.HTTP
	}
	return &http.Client{Timeout: 30 * time.Second}
}

func (g *Gemini) api() string {
	if g.API != "" {
		return strings.TrimSuffix(g.API, "/")
	}
	return geminiAPI
}

// StartLogin opens a session for SubmitLogin to take the key into.
func (g *Gemini) StartLogin(context.Context, gateway.LoginInput) (*gateway.LoginSession, error) {
	sess := &gateway.LoginSession{
		ID:        "gemini-" + randomHex(12),
		Connector: "gemini",
		Flow:      gateway.FlowAPIKey,
		Status:    gateway.LoginPending,
		ExpiresAt: time.Now().Add(geminiLoginTimeout),
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.sessions == nil {
		g.sessions = map[string]*gateway.LoginSession{}
	}
	for id, s := range g.sessions {
		if time.Now().After(s.ExpiresAt) {
			delete(g.sessions, id)
		}
	}
	g.sessions[sess.ID] = sess
	copy := *sess
	return &copy, nil
}

func (g *Gemini) PollLogin(_ context.Context, id string) (*gateway.LoginSession, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	sess, ok := g.sessions[id]
	if !ok {
		return nil, gateway.ErrNotFound
	}
	if sess.Status == gateway.LoginPending && time.Now().After(sess.ExpiresAt) {
		sess.Status, sess.Error = gateway.LoginExpired, &gateway.Problem{Code: gateway.CodeLoginTimeout, Message: "The API key entry timed out."}
	}
	copy := *sess
	return &copy, nil
}

// SubmitLogin checks the key with Google, then adds it. A rejected key
// leaves the session pending, so the user can correct it.
func (g *Gemini) SubmitLogin(ctx context.Context, id string, in gateway.LoginInput) error {
	sess, err := g.PollLogin(ctx, id)
	if err != nil {
		return err
	}
	if sess.Status != gateway.LoginPending {
		return &gateway.UserError{Code: gateway.CodeLoginTimeout, Message: "The API key entry timed out."}
	}
	key := strings.TrimSpace(in.APIKey)
	if key == "" {
		return &gateway.UserError{Code: gateway.CodeAPIKeyRequired, Message: "The API key is empty."}
	}
	if err := g.checkNew(key); err != nil {
		return err
	}
	if err := g.verify(ctx, key); err != nil {
		var ue *gateway.UserError
		if errors.As(err, &ue) && ue.Code == gateway.CodeInvalidAPIKey {
			return &gateway.UserError{Code: gateway.CodeInvalidAPIKey, Message: "The API key is invalid.", Cause: err}
		}
		return &gateway.UserError{Code: gateway.CodeKeyCheckUnavailable, Message: "Google AI Studio could not be reached to check the API key.", Params: gateway.Params{"provider": "Google AI Studio"}, Cause: err}
	}
	keys, err := g.Keys.UpdateGemini(func(keys []cpa.APIKey) ([]cpa.APIKey, error) {
		if hasKey(keys, key) {
			return nil, errDuplicateKey
		}
		return append(keys, cpa.APIKey{Key: key, CreatedAt: time.Now().UTC()}), nil
	})
	if err != nil {
		return err
	}
	if err := g.apply(ctx, keys); err != nil {
		// Not served, so not kept: the next start would add it unasked.
		_, _ = g.Keys.UpdateGemini(func(keys []cpa.APIKey) ([]cpa.APIKey, error) {
			return slices.DeleteFunc(keys, func(k cpa.APIKey) bool { return k.Key == key }), nil
		})
		return err
	}
	g.mu.Lock()
	if s, ok := g.sessions[id]; ok {
		s.Status = gateway.LoginSucceeded
	}
	g.mu.Unlock()
	return nil
}

var errDuplicateKey = &gateway.UserError{Code: gateway.CodeDuplicateAPIKey, Message: "This API key was added before."}

func (g *Gemini) checkNew(key string) error {
	keys, err := g.Keys.Gemini()
	if err != nil {
		return err
	}
	if hasKey(keys, key) {
		return errDuplicateKey
	}
	return nil
}

func hasKey(keys []cpa.APIKey, key string) bool {
	return slices.ContainsFunc(keys, func(k cpa.APIKey) bool { return k.Key == key })
}

// apply hands CPA the keys, which it saves to its config and reloads.
func (g *Gemini) apply(ctx context.Context, keys []cpa.APIKey) error {
	body, err := json.Marshal(cpa.GeminiConfig(keys))
	if err != nil {
		return err
	}
	return gateway.Manage(ctx, g.Management, g.ManagementURL("/gemini-api-key"), http.MethodPut, body, nil)
}

func (g *Gemini) CancelLogin(_ context.Context, id string) error {
	g.mu.Lock()
	defer g.mu.Unlock()
	if _, ok := g.sessions[id]; !ok {
		return gateway.ErrNotFound
	}
	delete(g.sessions, id)
	return nil
}

// SetDisabled records the state; the service applies it through CPA.
func (g *Gemini) SetDisabled(_ context.Context, a *coreauth.Auth, disabled bool) error {
	key := a.Attributes["api_key"]
	_, err := g.Keys.UpdateGemini(func(keys []cpa.APIKey) ([]cpa.APIKey, error) {
		for i := range keys {
			if keys[i].Key == key {
				keys[i].Disabled = disabled
				return keys, nil
			}
		}
		return nil, gateway.ErrNotFound
	})
	return err
}

// Remove deletes the key here, then from CPA's config.
func (g *Gemini) Remove(ctx context.Context, a *coreauth.Auth) error {
	key := a.Attributes["api_key"]
	if _, err := g.Keys.UpdateGemini(func(keys []cpa.APIKey) ([]cpa.APIKey, error) {
		return slices.DeleteFunc(keys, func(k cpa.APIKey) bool { return k.Key == key }), nil
	}); err != nil {
		return err
	}
	return gateway.Manage(ctx, g.Management, g.ManagementURL("/gemini-api-key?api-key="+url.QueryEscape(key)), http.MethodDelete, nil, nil)
}

// Usage checks the key: Google reports no limits for it, but listing the
// models it may use costs nothing and fails for a key it rejects.
func (g *Gemini) Usage(ctx context.Context, metadata map[string]any) (gateway.Usage, error) {
	key, _ := metadata["api_key"].(string)
	if key == "" {
		return gateway.Usage{}, errNoToken
	}
	return gateway.Usage{}, g.verify(ctx, key)
}

// verify lists the models key may use. Google answers a key it does not
// accept with 400 API_KEY_INVALID, or 401/403 (revoked, leaked, API not
// enabled for its project): the key's problem either way.
func (g *Gemini) verify(ctx context.Context, key string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, g.api()+"/v1beta/models?pageSize=1", nil)
	if err != nil {
		return err
	}
	req.Header.Set("x-goog-api-key", key)
	res, err := g.client().Do(req)
	if err != nil {
		return &gateway.UserError{Code: gateway.CodeUsageUnavailable, Message: "Google AI Studio could not be reached.", Cause: err}
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	switch {
	case res.StatusCode/100 == 2:
		return nil
	case res.StatusCode == http.StatusUnauthorized || res.StatusCode == http.StatusForbidden ||
		(res.StatusCode == http.StatusBadRequest && strings.Contains(string(raw), "API_KEY_INVALID")):
		return &gateway.UserError{Code: gateway.CodeInvalidAPIKey, Message: "Google AI Studio rejected the API key.",
			Cause: fmt.Errorf("gemini models: status %d", res.StatusCode)}
	}
	return &gateway.UserError{Code: gateway.CodeUsageUnavailable, Message: "Google AI Studio could not be reached.",
		Cause: fmt.Errorf("gemini models: status %d", res.StatusCode)}
}
