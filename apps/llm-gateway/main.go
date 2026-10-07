// Command llm-gateway serves AXP's LLM connections and model catalog.
package main

import (
	"log/slog"
	"net/http"
	"os"
	"time"

	"github.com/akarachen/axp/apps/llm-gateway/internal/edge"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	addr := os.Getenv("AXP_LLM_ADDR")
	if addr == "" {
		addr = ":8317"
	}
	server := &http.Server{
		Addr:              addr,
		Handler:           newHandler(os.Getenv("AXP_EDGE_SECRET")),
		ReadHeaderTimeout: 10 * time.Second,
	}
	logger.Info("llm-gateway listening", "addr", addr)
	if err := server.ListenAndServe(); err != nil {
		logger.Error("llm-gateway stopped", "error", err)
		os.Exit(1)
	}
}

func newHandler(secret string) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/llm/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"ok","service":"llm-gateway"}`))
	})
	mux.Handle("/api/llm/", requireEdge(secret, http.NotFoundHandler()))
	return mux
}

// requireEdge rejects requests that did not come through the edge gateway.
func requireEdge(secret string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !edge.Valid(r, secret) {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusForbidden)
			_, _ = w.Write([]byte(edge.Forbidden))
			return
		}
		next.ServeHTTP(w, r)
	})
}
