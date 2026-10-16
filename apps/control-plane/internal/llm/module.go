package llm

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"github.com/akarachen/axp/apps/control-plane/internal/llm/gateway"
	"github.com/akarachen/axp/apps/control-plane/internal/llm/gateway/connectors"
	"github.com/akarachen/axp/apps/control-plane/internal/llm/gateway/cpa"
	"github.com/akarachen/axp/apps/control-plane/internal/llm/gateway/usage"
	"github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy"
	sdkusage "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/usage"
)

// Module is the LLM gateway, in the process that serves the control plane's
// APIs: connections, the model catalog, usage and the OpenAI-compatible API,
// through an embedded CLIProxyAPI. Its state (credentials, the catalog seen
// so far, the usage book) is files in one directory. CPA's state is
// process-wide: a process opens one Module.
type Module struct {
	service *gateway.Service
	proxy   *cpa.Proxy
	book    *usage.Book
	gemini  *connectors.Gemini
	logger  *slog.Logger
}

// Open prepares the module on stateDir; Run starts it.
func Open(stateDir string, logger *slog.Logger) (*Module, error) {
	stateDir, err := filepath.Abs(stateDir)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(stateDir, 0o700); err != nil {
		return nil, err
	}
	// Who used the models: CPA hands it every upstream request.
	book, err := usage.Open(filepath.Join(stateDir, "usage.json"))
	if err != nil {
		return nil, err
	}
	sdkusage.RegisterPlugin(book)
	proxy, err := cpa.New(stateDir, logger)
	if err != nil {
		return nil, err
	}
	mgmt := proxy.Management()
	gemini := &connectors.Gemini{Management: mgmt, ManagementURL: cpa.ManagementURL, Keys: cpa.OpenProviders(stateDir)}
	service := gateway.NewService(gateway.Config{
		Connectors: []gateway.Connector{
			&connectors.Codex{Management: mgmt, ManagementURL: cpa.ManagementURL, Logger: logger},
			&connectors.XAI{Management: mgmt, ManagementURL: cpa.ManagementURL},
			gemini,
		},
		Auths:         proxy.Auths,
		Registry:      cliproxy.GlobalModelRegistry(),
		Management:    mgmt,
		ManagementURL: cpa.ManagementURL,
		CatalogPath:   filepath.Join(stateDir, "models.json"),
	})
	logger.Info("LLM gateway opened", "state_dir", stateDir)
	return &Module{service: service, proxy: proxy, book: book, gemini: gemini, logger: logger}, nil
}

// Run runs CPA until ctx ends, then writes the usage book. Upstream
// failures never end it: they are the catalog's and connections' status.
func (m *Module) Run(ctx context.Context) error {
	ctx, cancel := context.WithCancel(ctx)
	booked := make(chan struct{})
	go func() { m.book.Run(ctx); close(booked) }()
	err := m.proxy.Run(ctx)
	cancel()
	<-booked
	if err != nil && !errors.Is(err, context.Canceled) {
		return fmt.Errorf("LLM gateway: %w", err)
	}
	return nil
}

// Ready is closed once the credentials are loaded and requests are served.
func (m *Module) Ready() <-chan struct{} { return m.proxy.Ready() }

// Public is the browser's API, under /api/llm.
func (m *Module) Public() http.Handler { return gateway.Public(m.service, m.book, m.logger) }

// Internal is for the internal listener: the OpenAI-compatible API under
// /v1 (for the agent X-AXP-Agent-Id names) and the catalog at
// /llm/v1/models, for the control plane's other processes (Remote). CPA
// has no embeddings: /v1/embeddings is the gateway's own, over Google AI
// Studio's accounts.
func (m *Module) Internal() http.Handler {
	mux := http.NewServeMux()
	mux.Handle("/v1/", m.proxy.Handler())
	mux.Handle("POST /v1/embeddings", gateway.Embeddings(m.service, m.book, &http.Client{Timeout: 2 * time.Minute}, m.logger))
	mux.Handle("GET "+catalogPath, gateway.Catalog(m.service))
	return mux
}

// Models is the catalog, read in this process.
func (m *Module) Models(context.Context, bool) (map[string]Model, error) {
	select {
	case <-m.Ready():
	default:
		return nil, fmt.Errorf("%w: starting", ErrUnavailable)
	}
	models := m.service.Models()
	out := make(map[string]Model, len(models))
	for _, gm := range models {
		out[gm.ID] = fromCatalog(gm)
	}
	return out, nil
}
