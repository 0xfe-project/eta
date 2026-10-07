package main

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/akarachen/axp/apps/llm-gateway/internal/edge"
)

func TestHealthAndEdge(t *testing.T) {
	h := newHandler("s3cret")
	cases := []struct {
		path, secret string
		want         int
	}{
		{"/api/llm/health", "", http.StatusOK},
		{"/api/llm/v1/models", "", http.StatusForbidden},
		{"/api/llm/v1/models", "wrong", http.StatusForbidden},
		{"/api/llm/v1/models", "s3cret", http.StatusNotFound},
	}
	for _, c := range cases {
		req := httptest.NewRequest("GET", c.path, nil)
		if c.secret != "" {
			req.Header.Set(edge.Header, c.secret)
		}
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if rec.Code != c.want {
			t.Errorf("%s secret=%q: %d, want %d", c.path, c.secret, rec.Code, c.want)
		}
	}
}
