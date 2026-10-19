package cpa

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/router-for-me/CLIProxyAPI/v8/sdk/config"
)

// Providers is providers.json in the state directory: the API keys the user
// entered, and the only copy of them. CPA's config is generated on every
// start (New), so a key written only through CPA's management API would be
// gone after a restart; New renders these into the config, and a change at
// runtime is written here before the management API applies it.
type Providers struct {
	path string
	mu   sync.Mutex
}

// APIKey is one key the user entered.
type APIKey struct {
	Key string `json:"api_key"`
	// Disabled keys stay, serving no model (CPA excludes them all).
	Disabled  bool      `json:"disabled,omitempty"`
	CreatedAt time.Time `json:"created_at"`
}

type providersFile struct {
	Gemini []APIKey `json:"gemini,omitempty"`
}

// OpenProviders opens providers.json in stateDir; it need not exist yet.
func OpenProviders(stateDir string) *Providers {
	return &Providers{path: filepath.Join(stateDir, "providers.json")}
}

// Gemini lists the Google AI Studio keys.
func (p *Providers) Gemini() ([]APIKey, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	f, err := p.read()
	return f.Gemini, err
}

// UpdateGemini replaces the Google AI Studio keys with what update returns
// and returns them; nothing is written when update fails.
func (p *Providers) UpdateGemini(update func([]APIKey) ([]APIKey, error)) ([]APIKey, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	f, err := p.read()
	if err != nil {
		return nil, err
	}
	keys, err := update(append([]APIKey(nil), f.Gemini...))
	if err != nil {
		return nil, err
	}
	f.Gemini = keys
	raw, err := json.MarshalIndent(f, "", "  ")
	if err != nil {
		return nil, err
	}
	tmp := p.path + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o600); err != nil {
		return nil, err
	}
	return keys, os.Rename(tmp, p.path)
}

func (p *Providers) read() (providersFile, error) {
	var f providersFile
	raw, err := os.ReadFile(p.path)
	if errors.Is(err, os.ErrNotExist) {
		return f, nil
	}
	if err != nil {
		return f, err
	}
	return f, json.Unmarshal(raw, &f)
}

// GeminiConfig is keys as CPA's gemini-api-key entries: in the generated
// config, and the body of PUT /gemini-api-key. A disabled key excludes
// every model, as CPA's own PATCH /auth-files/status does to a config key.
func GeminiConfig(keys []APIKey) []config.GeminiKey {
	out := make([]config.GeminiKey, 0, len(keys))
	for _, k := range keys {
		entry := config.GeminiKey{APIKey: k.Key}
		if k.Disabled {
			entry.ExcludedModels = []string{"*"}
		}
		out = append(out, entry)
	}
	return out
}
