package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/akarachen/axp/packages/telemetry-go"
)

func main() {
	logger, shutdown, err := telemetry.Setup(context.Background(), "gateway")
	if err != nil {
		fmt.Fprintln(os.Stderr, "telemetry:", err)
		os.Exit(1)
	}
	err = run(logger)
	if err != nil {
		logger.Error("gateway stopped", "error", err)
	}
	flush(shutdown)
	if err != nil {
		os.Exit(1)
	}
}

// flush delivers pending log records before the process exits.
func flush(shutdown func(context.Context) error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := telemetry.Shutdown(ctx, shutdown); err != nil {
		fmt.Fprintln(os.Stderr, "telemetry:", err)
	}
}

func run(logger *slog.Logger) error {
	routes, err := routesFromEnv()
	if err != nil {
		return err
	}
	maxBody := int64(32 << 20)
	if v := os.Getenv("AXP_GATEWAY_MAX_BODY_BYTES"); v != "" {
		if maxBody, err = strconv.ParseInt(v, 10, 64); err != nil {
			return fmt.Errorf("AXP_GATEWAY_MAX_BODY_BYTES: %w", err)
		}
	}
	secret := os.Getenv("AXP_EDGE_SECRET")
	if secret == "" {
		logger.Warn("AXP_EDGE_SECRET is empty; upstreams cannot tell gateway traffic apart")
	}

	addr := envOr("AXP_GATEWAY_ADDR", ":8080")
	server := &http.Server{
		Addr:              addr,
		Handler:           New(Config{Routes: routes, EdgeSecret: secret, MaxBodyBytes: maxBody, Logger: logger}),
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       120 * time.Second,
		// No read or write timeout: chat streams stay open for a long time.
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	errs := make(chan error, 1)
	go func() { errs <- server.ListenAndServe() }()
	for _, r := range routes {
		logger.Info("route", "prefix", r.Prefix, "upstream", r.Upstream.String())
	}
	logger.Info("gateway listening", "addr", addr)

	select {
	case err := <-errs:
		return err
	case <-ctx.Done():
	}
	shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := server.Shutdown(shutdown); err != nil && !errors.Is(err, context.DeadlineExceeded) {
		return err
	}
	return nil
}

// routesFromEnv builds the fixed route table; only upstream addresses vary
// between development and production. An unset upstream drops its route.
func routesFromEnv() ([]Route, error) {
	specs := []struct{ name, prefix, env string }{
		{"llm", "/api/llm/", "AXP_GATEWAY_UPSTREAM_LLM"},
		{"api", "/api/", "AXP_GATEWAY_UPSTREAM_API"},
		{"web", "/", "AXP_GATEWAY_UPSTREAM_WEB"},
	}
	var routes []Route
	for _, s := range specs {
		raw := os.Getenv(s.env)
		if raw == "" {
			continue
		}
		u, err := url.Parse(raw)
		if err != nil || u.Scheme == "" || u.Host == "" {
			return nil, fmt.Errorf("%s: invalid upstream URL %q", s.env, raw)
		}
		routes = append(routes, Route{Name: s.name, Prefix: s.prefix, Upstream: u})
	}
	if len(routes) == 0 {
		return nil, errors.New("no upstreams configured (AXP_GATEWAY_UPSTREAM_WEB/API/LLM)")
	}
	return routes, nil
}

func envOr(name, fallback string) string {
	if v := os.Getenv(name); v != "" {
		return v
	}
	return fallback
}
