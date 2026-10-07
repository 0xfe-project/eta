// Package runtimeauth authenticates agent runtimes on the OpenAI-compatible
// API. A runtime's API key is "<instance id>.<runtime token>", the token the
// control plane issued to that runtime instance; the control plane's internal
// API confirms it, so a key stops working when its runtime is replaced.
package runtimeauth

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	sdkaccess "github.com/router-for-me/CLIProxyAPI/v7/sdk/access"
)

// cacheTTL bounds how long a replaced runtime's key keeps working.
const cacheTTL = 30 * time.Second

// Identity is the runtime instance a key belongs to.
type Identity struct {
	AgentID    string `json:"agent_id"`
	InstanceID string `json:"instance_id"`
	Generation int    `json:"generation"`
}

// Provider is a CPA access provider backed by the internal API.
type Provider struct {
	InternalURL string
	Client      *http.Client

	mu    sync.Mutex
	cache map[string]cached
}

type cached struct {
	identity Identity
	expires  time.Time
}

func New(internalURL string) *Provider {
	return &Provider{
		InternalURL: strings.TrimRight(internalURL, "/"),
		Client:      &http.Client{Timeout: 5 * time.Second},
		cache:       map[string]cached{},
	}
}

func (p *Provider) Identifier() string { return "axp-runtime" }

func (p *Provider) Authenticate(ctx context.Context, r *http.Request) (*sdkaccess.Result, *sdkaccess.AuthError) {
	key, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
	if !ok || key == "" {
		return nil, sdkaccess.NewNoCredentialsError()
	}
	identity, err := p.identity(ctx, key)
	if err != nil {
		return nil, err
	}
	return &sdkaccess.Result{
		Provider:  p.Identifier(),
		Principal: identity.AgentID,
		Metadata: map[string]string{
			"agent_id":    identity.AgentID,
			"instance_id": identity.InstanceID,
		},
	}, nil
}

func (p *Provider) identity(ctx context.Context, key string) (Identity, *sdkaccess.AuthError) {
	p.mu.Lock()
	hit, ok := p.cache[key]
	p.mu.Unlock()
	if ok && time.Now().Before(hit.expires) {
		return hit.identity, nil
	}
	instance, token, ok := strings.Cut(key, ".")
	if !ok || instance == "" || token == "" {
		return Identity{}, sdkaccess.NewInvalidCredentialError()
	}
	endpoint := fmt.Sprintf("%s/internal/v1/runtime-instances/%s/identity", p.InternalURL, url.PathEscape(instance))
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return Identity{}, sdkaccess.NewInternalAuthError("", err)
	}
	req.Header.Set("Authorization", "Bearer "+token)
	res, err := p.Client.Do(req)
	if err != nil {
		return Identity{}, sdkaccess.NewInternalAuthError("Control plane unavailable", err)
	}
	defer res.Body.Close()
	switch {
	case res.StatusCode == http.StatusOK:
	case res.StatusCode < 500:
		// Unknown, wrong or replaced runtime.
		return Identity{}, sdkaccess.NewInvalidCredentialError()
	default:
		return Identity{}, sdkaccess.NewInternalAuthError("Control plane unavailable", fmt.Errorf("identity: %s", res.Status))
	}
	var identity Identity
	if err := json.NewDecoder(res.Body).Decode(&identity); err != nil {
		return Identity{}, sdkaccess.NewInternalAuthError("", err)
	}
	p.mu.Lock()
	now := time.Now()
	for k, v := range p.cache {
		if now.After(v.expires) {
			delete(p.cache, k)
		}
	}
	p.cache[key] = cached{identity: identity, expires: now.Add(cacheTTL)}
	p.mu.Unlock()
	return identity, nil
}
