// Command forge-service is AXP's code hosting: the GitHub App agents act as.
// The browser connects the App through /api/forge; runtimes get git and gh
// credentials and open_pull_request through /forge.
//
// AXP_FORGE_ADDR is the listen address (host:port, default :8330);
// AXP_FORGE_STATE_DIR keeps the App's credentials (default var/forge).
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/akarachen/axp/apps/forge-service/internal/github"
	"github.com/akarachen/axp/apps/forge-service/internal/server"
	"github.com/akarachen/axp/packages/telemetry-go"
)

func main() {
	logger, shutdown, err := telemetry.Setup(context.Background(), "forge-service")
	if err != nil {
		fmt.Fprintln(os.Stderr, "telemetry:", err)
		os.Exit(1)
	}
	err = run(logger)
	failed := err != nil && !errors.Is(err, http.ErrServerClosed)
	if failed {
		logger.Error("forge-service stopped", "error", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := telemetry.Shutdown(ctx, shutdown); err != nil {
		fmt.Fprintln(os.Stderr, "telemetry:", err)
	}
	if failed {
		os.Exit(1)
	}
}

func run(logger *slog.Logger) error {
	addr := envOr("AXP_FORGE_ADDR", ":8330")
	state := envOr("AXP_FORGE_STATE_DIR", "var/forge")
	srv := &http.Server{
		Addr:              addr,
		Handler:           server.New(github.New(state), logger),
		ReadHeaderTimeout: 10 * time.Second,
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = srv.Shutdown(shutdownCtx)
	}()
	logger.Info("forge-service starting", "addr", addr, "state_dir", state)
	return srv.ListenAndServe()
}

func envOr(name, fallback string) string {
	if v := os.Getenv(name); v != "" {
		return v
	}
	return fallback
}
