// Command routine-service is AXP's routines: agents that run on a schedule
// and leave reports (docs/architecture/routines.md). The browser reaches it
// at /api/routines through the gateway.
//
//	routine-service           serve
//	routine-service openapi   print the API's OpenAPI document
//
// Configuration, from the environment:
//
//	AXP_ROUTINES_ADDR          listen address (default :8340)
//	AXP_ROUTINES_DATABASE_URL  its database, created when missing (default:
//	                           DATABASE_URL's server, database axp_routines)
//	AXP_NATS_URL               NATS, where schedules live
//	AXP_LLM_GATEWAY_URL        the LLM gateway
//	AXP_PLUGINS_DIR            the plugins (default ../agent-runtime/plugins);
//	                           runs get those of the routine target
//	AXP_DEV                    development's defaults
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"os/signal"
	"syscall"
	"time"
	_ "time/tzdata" // routines' time zones, wherever this runs

	"github.com/akarachen/axp/apps/routine-service/internal/api"
	"github.com/akarachen/axp/apps/routine-service/internal/routines"
	"github.com/akarachen/axp/apps/routine-service/internal/store"
	plugins "github.com/akarachen/axp/packages/plugins-go"
	"github.com/akarachen/axp/packages/telemetry-go"
)

func main() {
	if len(os.Args) == 2 && os.Args[1] == "openapi" {
		_, doc := api.New(&routines.Service{}, false)
		out, _ := json.MarshalIndent(doc.OpenAPI(), "", "  ")
		fmt.Println(string(out))
		return
	}
	logger, shutdown, err := telemetry.Setup(context.Background(), "routine-service")
	if err != nil {
		fmt.Fprintln(os.Stderr, "telemetry:", err)
		os.Exit(1)
	}
	err = run(logger)
	if err != nil {
		logger.Error("routine-service stopped", "error", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := telemetry.Shutdown(ctx, shutdown); err != nil {
		fmt.Fprintln(os.Stderr, "telemetry:", err)
	}
	if err != nil {
		os.Exit(1)
	}
}

func setting(name, production, development string) string {
	if v := os.Getenv(name); v != "" {
		return v
	}
	if os.Getenv("AXP_DEV") == "true" {
		return development
	}
	return production
}

// databaseURL is AXP_ROUTINES_DATABASE_URL, or database axp_routines on
// DATABASE_URL's server.
func databaseURL() (string, error) {
	if v := os.Getenv("AXP_ROUTINES_DATABASE_URL"); v != "" {
		return v, nil
	}
	base := setting("DATABASE_URL", "", "postgres://axp:axp@127.0.0.1:15432/axp")
	if base == "" {
		return "", errors.New("set AXP_ROUTINES_DATABASE_URL or DATABASE_URL")
	}
	u, err := url.Parse(base)
	if err != nil {
		return "", err
	}
	u.Path = "/axp_routines"
	return u.String(), nil
}

func run(logger *slog.Logger) error {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	dbURL, err := databaseURL()
	if err != nil {
		return err
	}
	db, err := store.Open(ctx, dbURL)
	if err != nil {
		return err
	}
	defer db.Close()
	if err := store.Migrate(ctx, db); err != nil {
		return fmt.Errorf("migrate: %w", err)
	}
	queue, err := routines.ConnectNATS(ctx, setting("AXP_NATS_URL", "nats://axp-nats:4222", "nats://172.30.0.1:4222"))
	if err != nil {
		return fmt.Errorf("nats: %w", err)
	}
	defer queue.Close()

	llm := setting("AXP_LLM_GATEWAY_URL", "http://axp-llm:8317", "http://127.0.0.1:8317")
	gateway := &routines.Gateway{URL: llm, Client: &http.Client{}}
	proxy, err := routines.NewKeyProxy(llm)
	if err != nil {
		return err
	}
	runPlugins, err := available(setting("AXP_PLUGINS_DIR", "../agent-runtime/plugins", "../agent-runtime/plugins"), logger)
	if err != nil {
		return err
	}
	runner := &routines.Runner{DB: db, Model: gateway.Model, Plugins: runPlugins, Proxy: proxy, WorkDir: os.TempDir()}
	service := &routines.Service{DB: db, Schedules: queue, Models: gateway, Revise: runner.Revise}
	if err := runner.Recover(ctx); err != nil {
		return err
	}
	if err := queue.Sync(ctx, service); err != nil {
		return fmt.Errorf("nats: %w", err)
	}
	go func() {
		if err := queue.Consume(ctx, runner.Fire); err != nil {
			logger.Error("Taking routine fires stopped", "error", err)
			stop()
		}
	}()

	handler, _ := api.New(service, os.Getenv("AXP_DEV") == "true")
	server := &http.Server{Addr: setting("AXP_ROUTINES_ADDR", ":8340", ":8340"), Handler: handler, ReadHeaderTimeout: 10 * time.Second}
	go func() {
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = server.Shutdown(shutdown)
	}()
	logger.Info("routine-service starting", "addr", server.Addr, "plugins", len(runPlugins))
	if err := server.ListenAndServe(); !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}

// available is the routine target's plugins whose servers' commands are
// installed here; the others are left out, with a warning.
func available(dir string, logger *slog.Logger) ([]*plugins.Plugin, error) {
	list, err := plugins.List(dir, plugins.TargetRoutine)
	if err != nil {
		return nil, err
	}
	var out []*plugins.Plugin
	for _, p := range list {
		missing := ""
		for _, s := range p.Servers {
			if s.Command != "" {
				if _, err := exec.LookPath(plugins.Expand(s.Command, map[string]string{"PLUGIN_ROOT": p.Dir})); err != nil {
					missing = s.Command
				}
			}
		}
		if missing != "" {
			logger.Warn("Leaving out a plugin whose command is not installed", "plugin", p.Name, "command", missing)
			continue
		}
		out = append(out, p)
	}
	return out, nil
}
