// Package llm is the client for the LLM gateway (apps/llm-gateway).
//
// The control plane calls the LLM gateway directly. It needs the catalog, to
// validate an agent's model, to refuse chats whose model is unusable and to
// tell runtimes a model's context window, and one chat completion to revise
// a routine's brief.
package llm

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/akarachen/axp/apps/control-plane/internal/apierr"
)

const (
	cacheFor       = 10 * time.Second
	catalogTimeout = 5 * time.Second
	reviseTimeout  = 120 * time.Second
)

type Model struct {
	ID                 string
	DisplayName        string
	ContextWindow      int
	Available          bool
	UnavailableMessage string
}

// Catalog is the gateway's model catalog.
type Catalog interface {
	Models(ctx context.Context, refresh bool) (map[string]Model, error)
}

// ErrUnavailable is any failure to read the catalog.
var ErrUnavailable = errors.New("LLM gateway unavailable")

// Gateway is the LLM gateway at URL, its catalog cached briefly.
type Gateway struct {
	URL    string
	Client *http.Client

	mu      sync.Mutex
	fetched time.Time
	models  map[string]Model
}

func NewGateway(url string) *Gateway {
	return &Gateway{URL: strings.TrimRight(url, "/"), Client: &http.Client{}}
}

func (g *Gateway) Models(ctx context.Context, refresh bool) (map[string]Model, error) {
	g.mu.Lock()
	if !refresh && g.models != nil && time.Since(g.fetched) < cacheFor {
		models := g.models
		g.mu.Unlock()
		return models, nil
	}
	g.mu.Unlock()
	models, err := g.fetch(ctx)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrUnavailable, err)
	}
	g.mu.Lock()
	g.models, g.fetched = models, time.Now()
	g.mu.Unlock()
	return models, nil
}

func (g *Gateway) fetch(ctx context.Context) (map[string]Model, error) {
	ctx, cancel := context.WithTimeout(ctx, catalogTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, g.URL+"/api/llm/v1/models", nil)
	if err != nil {
		return nil, err
	}
	resp, err := g.Client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("catalog returned %d", resp.StatusCode)
	}
	var items []struct {
		ID                string `json:"id"`
		DisplayName       string `json:"display_name"`
		ContextWindow     int    `json:"context_window"`
		Available         bool   `json:"available"`
		UnavailableReason *struct {
			Message string `json:"message"`
		} `json:"unavailable_reason"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&items); err != nil {
		return nil, err
	}
	models := make(map[string]Model, len(items))
	for _, item := range items {
		m := Model{
			ID:            item.ID,
			DisplayName:   item.DisplayName,
			ContextWindow: item.ContextWindow,
			Available:     item.Available,
		}
		if m.DisplayName == "" {
			m.DisplayName = item.ID
		}
		if item.UnavailableReason != nil {
			m.UnavailableMessage = item.UnavailableReason.Message
		}
		models[item.ID] = m
	}
	return models, nil
}

// Complete runs one chat completion with model, for agent (the gateway
// requires one), and returns its text.
func (g *Gateway) Complete(ctx context.Context, agent, model, prompt string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, reviseTimeout)
	defer cancel()
	body, _ := json.Marshal(map[string]any{
		"model":    model,
		"messages": []map[string]string{{"role": "user", "content": prompt}},
	})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, g.URL+"/v1/chat/completions", bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-AXP-Agent-Id", agent)
	resp, err := g.Client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("chat completion returned %d", resp.StatusCode)
	}
	var out struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return "", err
	}
	if len(out.Choices) == 0 {
		return "", errors.New("no choices")
	}
	text := strings.TrimSpace(out.Choices[0].Message.Content)
	if text == "" {
		return "", errors.New("empty completion")
	}
	return text, nil
}

// Validate rejects model ids the gateway has never offered.
func Validate(ctx context.Context, catalog Catalog, id string) error {
	models, err := catalog.Models(ctx, false)
	if err == nil {
		if _, ok := models[id]; !ok {
			models, err = catalog.Models(ctx, true)
		}
	}
	if err != nil {
		slog.WarnContext(ctx, "LLM gateway unavailable", "error", err)
		return apierr.New(503, "MODEL_SERVICE_UNAVAILABLE", "模型服务暂时不可用，请稍后再试。")
	}
	if _, ok := models[id]; !ok {
		return apierr.New(422, "MODEL_NOT_FOUND", "所选模型不存在。")
	}
	return nil
}

// EnsureUsable refuses to start a turn the model cannot serve.
func EnsureUsable(ctx context.Context, catalog Catalog, id *string) error {
	if id == nil || *id == "" {
		return apierr.New(409, "MODEL_NOT_SET", "这个智能体还没有选择模型。")
	}
	models, err := catalog.Models(ctx, false)
	model, ok := models[*id]
	if err == nil && (!ok || !model.Available) {
		models, err = catalog.Models(ctx, true)
		model, ok = models[*id]
	}
	if err != nil {
		slog.WarnContext(ctx, "LLM gateway unavailable", "error", err)
		return apierr.New(409, "MODEL_UNAVAILABLE", "模型服务暂时不可用，请稍后再试。")
	}
	if !ok {
		return apierr.New(409, "MODEL_UNAVAILABLE", "这个智能体的模型已不存在，请更换模型。")
	}
	if !model.Available {
		reason := model.UnavailableMessage
		if reason == "" {
			reason = "请检查模型服务中的账号。"
		}
		return apierr.New(409, "MODEL_UNAVAILABLE", fmt.Sprintf("%s 暂不可用：%s", model.DisplayName, reason))
	}
	return nil
}

// ContextWindow is the model's context window, or nil when unknown.
func ContextWindow(ctx context.Context, catalog Catalog, id *string) *int {
	if id == nil || *id == "" {
		return nil
	}
	models, err := catalog.Models(ctx, false)
	if err != nil {
		return nil
	}
	if m, ok := models[*id]; ok && m.ContextWindow > 0 {
		return &m.ContextWindow
	}
	return nil
}
