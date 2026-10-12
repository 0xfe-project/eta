package llm

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

func TestGatewayKeepsItsLastCatalogWhenUnreachable(t *testing.T) {
	var down atomic.Bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if down.Load() {
			http.Error(w, "bad gateway", http.StatusBadGateway)
			return
		}
		_, _ = w.Write([]byte(`[
			{"id":"gpt","display_name":"GPT","status":"degraded","available":true,"reason":{"code":"UPSTREAM_UNSTABLE","message":"上游暂时故障"}},
			{"id":"grok","display_name":"Grok","status":"unavailable","available":false,"reason":{"code":"AUTH_EXPIRED","message":"登录已失效"}}
		]`))
	}))
	defer srv.Close()
	ctx := context.Background()

	down.Store(true)
	g := NewGateway(srv.URL)
	gpt := "gpt"
	if _, err := g.Models(ctx, true); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("never read: %v", err)
	}
	if err := EnsureUsable(ctx, g, &gpt); err == nil {
		t.Fatal("a chat started with nothing known about the model")
	}

	down.Store(false)
	// A transient upstream failure does not refuse the turn.
	if err := EnsureUsable(ctx, g, &gpt); err != nil {
		t.Fatalf("degraded model refused: %v", err)
	}
	grok := "grok"
	if err := EnsureUsable(ctx, g, &grok); err == nil || !strings.Contains(err.Error(), "登录已失效") {
		t.Fatalf("unavailable model: %v", err)
	}

	down.Store(true)
	models, err := g.Models(ctx, true)
	if err != nil || !models["gpt"].Available || models["grok"].Available {
		t.Fatalf("last catalog: %v %v", models, err)
	}
	if err := EnsureUsable(ctx, g, &gpt); err != nil {
		t.Fatalf("gateway blip refused the turn: %v", err)
	}
}
