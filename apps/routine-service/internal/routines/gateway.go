package routines

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/akarachen/axp/packages/service-go/apierr"
	"github.com/openai/openai-go/v3/option"
	"google.golang.org/adk/v2/model"
	"google.golang.org/adk/v2/model/openaimodel"
)

// The LLM gateway (apps/llm-gateway), which this service calls directly:
// its catalog and its OpenAI-compatible API. It trusts X-AXP-Agent-Id from
// the services that reach it; a run's usage is its routine's,
// "routine-<id>".

// AgentHeader names the agent an LLM gateway request is for.
const AgentHeader = "X-AXP-Agent-Id"

func agentOf(routineID string) string { return "routine-" + routineID }

// Catalog is the models the gateway offers.
type Catalog interface {
	Has(ctx context.Context, model string) (bool, error)
}

// Validate rejects models the gateway has never offered.
func Validate(ctx context.Context, catalog Catalog, model string) error {
	ok, err := catalog.Has(ctx, model)
	if err != nil {
		slog.WarnContext(ctx, "LLM gateway unavailable", "error", err)
		return apierr.New(503, "MODEL_SERVICE_UNAVAILABLE", "模型服务暂时不可用，请稍后再试。")
	}
	if !ok {
		return apierr.New(422, "MODEL_NOT_FOUND", "所选模型不存在。")
	}
	return nil
}

// Gateway is the LLM gateway at URL.
type Gateway struct {
	URL    string
	Client *http.Client
}

func (g *Gateway) Has(ctx context.Context, id string) (bool, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, g.URL+"/api/llm/v1/models", nil)
	if err != nil {
		return false, err
	}
	resp, err := g.Client.Do(req)
	if err != nil {
		return false, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return false, fmt.Errorf("catalog returned %d", resp.StatusCode)
	}
	var models []struct {
		ID string `json:"id"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&models); err != nil {
		return false, err
	}
	for _, m := range models {
		if m.ID == id {
			return true, nil
		}
	}
	return false, nil
}

// Model is name through the gateway, for the routine's agent.
func (g *Gateway) Model(ctx context.Context, name, routineID string) (model.LLM, error) {
	return openaimodel.NewModel(ctx, name, &openaimodel.ClientConfig{
		// The gateway takes no key from services; it is required here.
		APIKey:     "unused",
		BaseURL:    g.URL + "/v1",
		HTTPClient: g.Client,
		API:        openaimodel.APIChatCompletions,
		Options:    []option.RequestOption{option.WithHeader(AgentHeader, agentOf(routineID))},
	})
}

// KeyProxy is how a run's plugins reach the gateway: a loopback listener
// that accepts the keys of running runs and forwards /v1 to the gateway as
// their routine's agent. A key works only while its run runs.
type KeyProxy struct {
	URL string

	mu   sync.Mutex
	keys map[string]string
}

// NewKeyProxy listens on loopback and forwards to the gateway at target.
func NewKeyProxy(target string) (*KeyProxy, error) {
	upstream, err := url.Parse(target)
	if err != nil {
		return nil, err
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	p := &KeyProxy{URL: "http://" + listener.Addr().String(), keys: map[string]string{}}
	forward := httputil.NewSingleHostReverseProxy(upstream)
	forward.FlushInterval = -1
	go http.Serve(listener, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { //nolint:errcheck
		key, _ := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
		p.mu.Lock()
		agent, ok := p.keys[key]
		p.mu.Unlock()
		if !ok || !strings.HasPrefix(r.URL.Path, "/v1/") {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		r.Header.Del("Authorization")
		r.Header.Set(AgentHeader, agent)
		forward.ServeHTTP(w, r)
	}))
	return p, nil
}

// Issue is a new key for the routine's agent; revoke ends it.
func (p *KeyProxy) Issue(routineID string) (key string, revoke func()) {
	b := make([]byte, 24)
	_, _ = rand.Read(b)
	key = hex.EncodeToString(b)
	p.mu.Lock()
	p.keys[key] = agentOf(routineID)
	p.mu.Unlock()
	return key, func() {
		p.mu.Lock()
		delete(p.keys, key)
		p.mu.Unlock()
	}
}

var errEmpty = errors.New("the model answered nothing")
