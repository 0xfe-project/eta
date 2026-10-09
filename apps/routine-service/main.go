// Command routine-service is AXP's routines: agents that run on a schedule
// and leave reports (docs/architecture/routines.md). The browser reaches it
// at /api/routines through the gateway.
//
//	routine-service           serve (the default)
//	routine-service migrate   creates and migrates its database
//	routine-service openapi   prints the API's OpenAPI document
package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/exec"
	"time"
	_ "time/tzdata" // routines' time zones, wherever this runs

	"github.com/akarachen/axp/apps/routine-service/internal/api"
	"github.com/akarachen/axp/apps/routine-service/internal/routines"
	"github.com/akarachen/axp/apps/routine-service/migrations"
	plugins "github.com/akarachen/axp/packages/plugins-go"
	"github.com/akarachen/axp/packages/service-go"
	"github.com/akarachen/axp/packages/service-go/config"
	"github.com/akarachen/axp/packages/service-go/httpapi"
	"github.com/akarachen/axp/packages/service-go/pg"
	"github.com/danielgtaylor/huma/v2"
)

type Config struct {
	Addr string `env:"AXP_ROUTINES_ADDR" default:":8340"`
	// Its own database; by default axp_routines on DATABASE_URL's server.
	DatabaseURL     string `env:"AXP_ROUTINES_DATABASE_URL"`
	BaseDatabaseURL string `env:"DATABASE_URL" dev:"postgres://axp:axp@127.0.0.1:15432/axp"`
	// NATS, where the schedules live, and the services' password there
	// (deploy/nats.conf).
	NATSURL      string `env:"AXP_NATS_URL" dev:"nats://172.30.0.1:4222" prod:"nats://axp-nats:4222"`
	NATSPassword string `env:"AXP_NATS_PASSWORD" dev:"axp-dev-nats"`
	// The LLM gateway, for the catalog and models.
	LLMGatewayURL string `env:"AXP_LLM_GATEWAY_URL" dev:"http://127.0.0.1:8317" prod:"http://axp-llm:8317"`
	// The plugins; runs get those of the routine target.
	PluginsDir string `env:"AXP_PLUGINS_DIR" default:"../agent-runtime/plugins"`
	Dev        bool   `env:"AXP_DEV"`
}

func (c Config) database() (string, error) {
	if c.DatabaseURL != "" {
		return c.DatabaseURL, nil
	}
	if c.BaseDatabaseURL == "" {
		return "", errors.New("set AXP_ROUTINES_DATABASE_URL or DATABASE_URL")
	}
	return pg.WithDatabase(c.BaseDatabaseURL, "axp_routines")
}

func main() {
	service.Main("routine-service",
		service.Command{Name: "serve", Default: true, Run: serve},
		service.Migrate(func() (string, error) {
			c, err := config.Load[Config]()
			if err != nil {
				return "", err
			}
			return c.database()
		}, migrations.All, true),
		service.OpenAPI(map[string]func() huma.API{
			"public": func() huma.API { return api.New(&api.Deps{}).API },
		}),
	)
}

func serve(ctx context.Context, _ []string) error {
	c, err := config.Load[Config]()
	if err != nil {
		return err
	}
	url, err := c.database()
	if err != nil {
		return err
	}
	db, err := pg.Setup(ctx, url, migrations.All, true)
	if err != nil {
		return err
	}
	defer db.Close()
	queue, err := routines.ConnectNATS(ctx, c.NATSURL, c.NATSPassword)
	if err != nil {
		return err
	}
	defer queue.Close()
	gateway := &routines.Gateway{URL: c.LLMGatewayURL, Client: &http.Client{}}
	proxy, err := routines.NewKeyProxy(c.LLMGatewayURL)
	if err != nil {
		return err
	}
	runPlugins, err := available(c.PluginsDir)
	if err != nil {
		return err
	}
	runner := &routines.Runner{DB: db, Model: gateway.Model, Plugins: runPlugins, Proxy: proxy, WorkDir: os.TempDir()}
	domain := &routines.Service{Schedules: queue, Models: gateway}

	if err := runner.Recover(ctx); err != nil {
		return err
	}
	list, err := domain.List(ctx, db)
	if err != nil {
		return err
	}
	if err := queue.Sync(ctx, list); err != nil {
		return err
	}
	ctx, stop := context.WithCancel(ctx)
	defer stop()
	go func() {
		if err := queue.Consume(ctx, runner.Fire); err != nil {
			slog.Error("Taking routine fires stopped", "error", err)
			stop()
		}
	}()
	handler := api.New(&api.Deps{DB: db, Routines: domain, Revise: runner.Revise, Docs: c.Dev}).Router
	return httpapi.Serve(ctx, c.Addr, handler, 5*time.Second)
}

// available is the routine target's plugins whose servers' commands, and
// akhook for those with hooks, are installed here; the others are left out,
// with a warning.
func available(dir string) ([]*plugins.Plugin, error) {
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
		if p.Hooks != "" {
			if _, err := exec.LookPath("akhook"); err != nil {
				missing = "akhook"
			}
		}
		if missing != "" {
			slog.Warn("Leaving out a plugin whose command is not installed", "plugin", p.Name, "command", missing)
			continue
		}
		out = append(out, p)
	}
	slog.Info("Routine runs get plugins", "count", len(out))
	return out, nil
}
