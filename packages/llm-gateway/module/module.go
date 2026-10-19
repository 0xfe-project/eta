// Package module is the LLM gateway as one unit: an embedded CLIProxyAPI
// (CPA) behind a loopback HTTP listener that serves the OpenAI-compatible
// /v1 for the host's model layer and /api/llm for its account screens.
package module

import (
	"context"
	"crypto/subtle"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/0xfe-project/eta/packages/llm-gateway/gateway"
	"github.com/0xfe-project/eta/packages/llm-gateway/gateway/connectors"
	"github.com/0xfe-project/eta/packages/llm-gateway/gateway/cpa"
	"github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy"
)

// Options configure a Module.
type Options struct {
	// StateDir holds the gateway's files: credentials, the catalog seen so
	// far, API keys and CPA's generated config.
	StateDir string
	// AccessKey is the bearer key every request needs, /v1 and /api/llm
	// alike. The host generates it per process; nothing else knows it.
	AccessKey string
	// Addr is the loopback address to listen on; empty means a free port.
	Addr string
	// CPAExtra is merged over CPA's generated config. Tests use it to point
	// an upstream at a fake server.
	CPAExtra map[string]any
	Logger   *slog.Logger
}

// Module is the gateway. CPA's state is process-wide (its logger, model
// registry, access providers): a process opens one Module.
type Module struct {
	service *gateway.Service
	proxy   *cpa.Proxy
	gemini  *connectors.Gemini
	key     string
	ln      net.Listener
	logger  *slog.Logger
}

// Open prepares the module and binds its listener, so the port is known
// before anything runs; Run starts serving.
func Open(opts Options) (*Module, error) {
	if len(opts.AccessKey) < 16 {
		return nil, errors.New("LLM gateway: the access key is missing or too short")
	}
	logger := opts.Logger
	if logger == nil {
		logger = slog.Default()
	}
	stateDir, err := filepath.Abs(opts.StateDir)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(stateDir, 0o700); err != nil {
		return nil, err
	}
	addr := opts.Addr
	if addr == "" {
		addr = "127.0.0.1:0"
	}
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return nil, err
	}
	proxy, err := cpa.New(stateDir, opts.AccessKey, opts.CPAExtra, logger)
	if err != nil {
		_ = ln.Close()
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
	logger.Info("LLM gateway opened", "state_dir", stateDir, "addr", ln.Addr().String())
	return &Module{service: service, proxy: proxy, gemini: gemini, key: opts.AccessKey, ln: ln, logger: logger}, nil
}

// Addr is where the module listens.
func (m *Module) Addr() net.Addr { return m.ln.Addr() }

// Ready is closed once the credentials are loaded and /v1 is served.
func (m *Module) Ready() <-chan struct{} { return m.proxy.Ready() }

// Handler serves /v1 (CPA's OpenAI-compatible API, which authenticates the
// key itself) and /api/llm (the account API, behind the same key).
func (m *Module) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.Handle("/v1/", m.proxy.Handler())
	mux.Handle("/api/llm/", m.requireKey(gateway.Admin(m.service, m.logger)))
	// 200 once the credentials are loaded and /v1 serves; 503 before.
	mux.Handle("GET /api/llm/ready", m.requireKey(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		select {
		case <-m.Ready():
			w.WriteHeader(http.StatusNoContent)
		default:
			w.WriteHeader(http.StatusServiceUnavailable)
		}
	})))
	return mux
}

func (m *Module) requireKey(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		if subtle.ConstantTimeCompare([]byte(got), []byte(m.key)) != 1 {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write([]byte(`{"error":{"code":"UNAUTHORIZED","message":"unauthorized"}}`))
			return
		}
		next.ServeHTTP(w, r)
	})
}

// Run serves until ctx ends: it runs CPA and the listener, then stops both
// (open streams get a few seconds, then are cut). Upstream failures never
// end it: they are the catalog's and the connections' status.
func (m *Module) Run(ctx context.Context) error {
	srv := &http.Server{Handler: m.Handler(), ReadHeaderTimeout: 10 * time.Second}
	served := make(chan error, 1)
	go func() { served <- srv.Serve(m.ln) }()

	err := m.proxy.Run(ctx)

	shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if serr := srv.Shutdown(shutdown); serr != nil {
		_ = srv.Close()
	}
	<-served
	if err != nil && !errors.Is(err, context.Canceled) {
		return fmt.Errorf("LLM gateway: %w", err)
	}
	return nil
}
