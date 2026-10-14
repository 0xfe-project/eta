package main

import (
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/akarachen/axp/apps/control-plane/internal/forge"
	"github.com/akarachen/axp/apps/control-plane/internal/github"
	"github.com/akarachen/axp/apps/control-plane/internal/routineapi"
)

// Each listener serves only its own routes: runtimes' (which trust
// X-AXP-Agent-Id) are never on the public listener, the browser's never on
// the internal one.
func TestListenersKeepTheirRoutes(t *testing.T) {
	code := forge.New(github.New(t.TempDir()), slog.New(slog.NewTextHandler(io.Discard, nil)))
	public, internal := handlers(openAPIDeps(), code, &routineapi.Deps{})
	status := func(h http.Handler, method, path string) int {
		req := httptest.NewRequest(method, path, nil)
		req.Header.Set("X-AXP-Agent-Id", "agent-1")
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		return rec.Code
	}
	for _, c := range []struct {
		name         string
		h            http.Handler
		method, path string
		found        bool
	}{
		{"public", public, "GET", "/api/forge/v1/github", true},
		{"public", public, "GET", "/api/routines/health", true},
		{"public", public, "GET", "/api/health", true},
		{"public", public, "GET", "/forge/credentials", false},
		{"public", public, "POST", "/routines/mcp", false},
		{"public", public, "POST", "/tasks/mcp", false},
		{"public", public, "POST", "/groups/mcp", false},
		{"public", public, "GET", "/internal/v1/runtime-auth", false},
		{"internal", internal, "GET", "/forge/credentials", true},
		{"internal", internal, "GET", "/api/forge/v1/github", false},
		{"internal", internal, "GET", "/api/routines/health", false},
		{"internal", internal, "GET", "/api/health", false},
	} {
		got := status(c.h, c.method, c.path)
		if (got != http.StatusNotFound && got != http.StatusMethodNotAllowed) != c.found {
			t.Errorf("%s %s %s: %d", c.name, c.method, c.path, got)
		}
	}
}
