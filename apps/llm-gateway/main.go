// Command llm-gateway serves AXP's LLM connections, model catalog and the
// OpenAI-compatible API agent runtimes call. It embeds CLIProxyAPI.
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"syscall"
	"time"

	"github.com/akarachen/axp/apps/llm-gateway/internal/connectors"
	"github.com/akarachen/axp/apps/llm-gateway/internal/cpa"
	"github.com/akarachen/axp/apps/llm-gateway/internal/llm"
	"github.com/akarachen/axp/apps/llm-gateway/internal/runtimeauth"
	"github.com/akarachen/axp/packages/telemetry-go"
	"github.com/gin-gonic/gin"
	"github.com/router-for-me/CLIProxyAPI/v7/sdk/cliproxy"
	"github.com/sirupsen/logrus"
)

func main() {
	logger, shutdown, err := telemetry.Setup(context.Background(), "llm-gateway")
	if err != nil {
		fmt.Fprintln(os.Stderr, "telemetry:", err)
		os.Exit(1)
	}
	// CLIProxyAPI prints and logs (logrus) on its own; route both through
	// OpenTelemetry. logrus starts out on stderr, so point it at stdout.
	restoreStdout, err := telemetry.RedirectStdout(logger.With("library", "cliproxy"))
	if err != nil {
		fmt.Fprintln(os.Stderr, "telemetry:", err)
		os.Exit(1)
	}
	logrus.SetOutput(os.Stdout)
	err = run(logger)
	failed := err != nil && !errors.Is(err, context.Canceled)
	if failed {
		logger.Error("llm-gateway stopped", "error", err)
	}
	restoreStdout()
	flush(shutdown)
	if failed {
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
	host, port, err := splitAddr(envOr("AXP_LLM_ADDR", ":8317"))
	if err != nil {
		return err
	}
	// Connection credentials, CPA's generated config and the model catalog.
	stateDir, err := filepath.Abs("var/llm-gateway")
	if err != nil {
		return err
	}
	edgeSecret := os.Getenv("AXP_EDGE_SECRET")
	// Runtimes reach the internal API (and this gateway) on their network.
	internalURL := envOr("AXP_INTERNAL_URL", "http://axp-internal:8001")

	var service *llm.Service
	proxy, err := cpa.New(cpa.Options{
		Host:     host,
		Port:     port,
		StateDir: stateDir,
		Access:   runtimeauth.New(internalURL),
		Mount: func(e *gin.Engine) {
			llm.Mount(e, service, edgeSecret, logger)
		},
	})
	if err != nil {
		return err
	}
	mgmt := proxy.Management()
	service = llm.NewService(llm.Config{
		Connectors: []llm.Connector{
			&connectors.Codex{Management: mgmt, ManagementURL: cpa.ManagementURL, Logger: logger},
			&connectors.XAI{Management: mgmt, ManagementURL: cpa.ManagementURL},
		},
		Auths:         proxy.Auths,
		Registry:      cliproxy.GlobalModelRegistry(),
		Management:    mgmt,
		ManagementURL: cpa.ManagementURL,
		CatalogPath:   filepath.Join(stateDir, "models.json"),
	})

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	logger.Info("llm-gateway starting", "addr", net.JoinHostPort(host, strconv.Itoa(port)), "state_dir", stateDir)
	return proxy.Run(ctx)
}

func splitAddr(addr string) (string, int, error) {
	host, rawPort, err := net.SplitHostPort(addr)
	if err != nil {
		return "", 0, fmt.Errorf("AXP_LLM_ADDR: %w", err)
	}
	port, err := strconv.Atoi(rawPort)
	if err != nil {
		return "", 0, fmt.Errorf("AXP_LLM_ADDR: invalid port %q", rawPort)
	}
	return host, port, nil
}

func envOr(name, fallback string) string {
	if v := os.Getenv(name); v != "" {
		return v
	}
	return fallback
}
