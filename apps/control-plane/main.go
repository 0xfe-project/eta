// Command axp-control-plane is AXP's control plane: it keeps agents' state
// and operates their runtimes. One binary, one role per process:
//
//	axp-control-plane api         the browser's API under /api (AXP_API_ADDR, default :8000)
//	axp-control-plane internal    runtimes' API under /internal (AXP_INTERNAL_ADDR, default :8001)
//	axp-control-plane controller  starts, replaces and stops runtime containers (Docker socket)
//	axp-control-plane migrate     applies database migrations
//	axp-control-plane openapi public|internal
//	                              prints an API's OpenAPI document
//	axp-control-plane ensure-runtime-network
//	                              creates the Docker network runtimes run on
//
// Settings come from the environment (internal/config); service-go runs
// the commands (docs/architecture/service-framework.md).
package main

import (
	"context"
	"flag"
	"log/slog"
	"sync"
	"time"

	"github.com/akarachen/axp/apps/control-plane/internal/api"
	"github.com/akarachen/axp/apps/control-plane/internal/chat"
	"github.com/akarachen/axp/apps/control-plane/internal/config"
	"github.com/akarachen/axp/apps/control-plane/internal/container"
	"github.com/akarachen/axp/apps/control-plane/internal/control"
	"github.com/akarachen/axp/apps/control-plane/internal/llm"
	"github.com/akarachen/axp/apps/control-plane/internal/plugins"
	"github.com/akarachen/axp/apps/control-plane/internal/queue"
	"github.com/akarachen/axp/apps/control-plane/internal/relay"
	"github.com/akarachen/axp/apps/control-plane/internal/snapshots"
	"github.com/akarachen/axp/apps/control-plane/internal/store"
	"github.com/akarachen/axp/apps/control-plane/internal/tasks"
	"github.com/akarachen/axp/packages/service-go"
	"github.com/akarachen/axp/packages/service-go/httpapi"
	"github.com/akarachen/axp/packages/service-go/pg"
	"github.com/danielgtaylor/huma/v2"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func main() {
	service.Main("control-plane",
		service.Command{Name: "api", Run: func(ctx context.Context, _ []string) error {
			s, err := connect(ctx)
			if err != nil {
				return err
			}
			// Chat streams (SSE) never finish; browsers reconnect with
			// Last-Event-ID, so deploys do not wait for them.
			return httpapi.Serve(ctx, s.cfg.APIAddr, api.Public(s.deps).Router, time.Second)
		}},
		service.Command{Name: "internal", Run: func(ctx context.Context, _ []string) error {
			s, err := connect(ctx)
			if err != nil {
				return err
			}
			return httpapi.Serve(ctx, s.cfg.InternalAddr, api.Internal(s.deps).Router, time.Second)
		}},
		service.Command{Name: "controller", Args: "[-interval 500ms]", Run: func(ctx context.Context, args []string) error {
			flags := flag.NewFlagSet("controller", flag.ExitOnError)
			interval := flags.Duration("interval", 500*time.Millisecond, "time between ticks")
			_ = flags.Parse(args)
			s, err := connect(ctx)
			if err != nil {
				return err
			}
			return runController(ctx, s, *interval)
		}},
		service.Migrate(func() (string, error) {
			cfg, err := config.Load()
			return cfg.DatabaseURL, err
		}, store.Migrations, false),
		service.OpenAPI(map[string]func() huma.API{
			"public":   func() huma.API { return api.Public(openAPIDeps()).API },
			"internal": func() huma.API { return api.Internal(openAPIDeps()).API },
		}),
		service.Command{Name: "ensure-runtime-network", Run: func(ctx context.Context, _ []string) error {
			cfg, err := config.Load()
			if err != nil {
				return err
			}
			driver, err := container.NewDocker(cfg.Dev)
			if err != nil {
				return err
			}
			return driver.EnsureNetwork(ctx)
		}},
	)
}

// openAPIDeps are enough to build the APIs for their documents, connecting
// to nothing.
func openAPIDeps() *api.Deps {
	return &api.Deps{Chat: &chat.Service{}, Tasks: &tasks.Service{}, Dev: true}
}

// services is everything a role may need, connected lazily where possible.
type services struct {
	cfg       config.Config
	deps      *api.Deps
	queue     *queue.NATS
	models    *llm.Gateway
	snapshots *snapshots.S3
}

func connect(ctx context.Context) (*services, error) {
	cfg, err := config.Load()
	if err != nil {
		return nil, err
	}
	pool, err := pg.Open(ctx, cfg.DatabaseURL)
	if err != nil {
		return nil, err
	}
	q, err := queue.Connect(cfg.NATSURL)
	if err != nil {
		return nil, err
	}
	s3, err := snapshots.NewS3(cfg.S3Endpoint, cfg.S3AccessKeyID, cfg.S3SecretAccessKey)
	if err != nil {
		return nil, err
	}
	models := llm.NewGateway(cfg.LLMGatewayURL)
	taskService := &tasks.Service{}
	relayClient, err := relay.New(cfg.RelayURL, cfg.RelayOrigin, cfg.RelayAdminSecret, cfg.RelayCAFile, pool)
	if err != nil {
		return nil, err
	}
	if relayClient != nil {
		taskService.Relay = relayClient
	}
	chatService := &chat.Service{
		Queue: q, Models: models, Plugins: &plugins.Catalog{Dir: cfg.PluginsDir},
		Cursors: chat.Cursors{Secret: []byte(cfg.SecretKey)},
	}
	return &services{
		cfg:       cfg,
		queue:     q,
		models:    models,
		snapshots: s3,
		deps: &api.Deps{
			DB:        pool,
			Chat:      chatService,
			Protocol:  &control.Protocol{DB: pool, Chat: chatService, Snapshots: s3, Secret: []byte(cfg.SecretKey)},
			Tasks:     taskService,
			PublicURL: cfg.PublicURL, ForgeURL: cfg.ForgeURL, RemoteDist: cfg.RemoteDist,
			Dev: cfg.Dev,
		},
	}, nil
}

// controllerLock is the pg_advisory_lock key of the controller; any constant
// shared by all controllers works.
const controllerLock = 0x41585043

// holdLock takes the controller lock on its own connection. Deploys briefly
// run the old and new controller side by side; the new one waits here until
// the old one exits.
func holdLock(ctx context.Context, url string) (*pgx.Conn, error) {
	for {
		conn, err := pgx.Connect(ctx, url)
		if err == nil {
			if _, err = conn.Exec(ctx, "SELECT pg_advisory_lock($1)", controllerLock); err == nil {
				return conn, nil
			}
			conn.Close(context.Background())
		}
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		slog.Warn("Cannot take the controller lock yet", "error", err)
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(time.Second):
		}
	}
}

func runController(ctx context.Context, s *services, interval time.Duration) error {
	slog.Info("Waiting for the controller lock")
	lock, err := holdLock(ctx, s.cfg.DatabaseURL)
	if err != nil {
		return err
	}
	defer func() {
		if lock != nil { // nil when stopped while taking it again
			lock.Close(context.Background())
		}
	}()
	// The tick in progress always finishes, even after SIGTERM: it may be
	// stopping a runtime.
	work := context.WithoutCancel(ctx)
	driver, err := container.NewDocker(s.cfg.Dev)
	if err != nil {
		return err
	}
	if err := driver.EnsureNetwork(work); err != nil {
		return err
	}
	if err := s.snapshots.EnsureBucket(work); err != nil {
		return err
	}
	if err := s.queue.EnsureStreams(work); err != nil {
		return err
	}
	controller := &control.Controller{
		DB: s.deps.DB, Chat: s.deps.Chat, Queue: s.queue, Driver: driver, Snapshots: s.snapshots,
		Models: s.models, Secret: []byte(s.cfg.SecretKey),
		RuntimeGatewayURL: s.cfg.RuntimeGatewayURL, NATSURL: s.cfg.NATSURL, CodexLaunch: s.cfg.CodexLaunch,
		ID: "controller-" + uuid.NewString()[:8], HostID: control.HostID(),
	}
	// Remote agents' runs, on their own loop: relay calls take seconds. It
	// runs only while this controller holds the lock (a computer's capacity
	// assumes one runner), and is waited for: a start under way finishes.
	runner := &tasks.Runner{DB: s.deps.DB, Service: s.deps.Tasks}
	var running sync.WaitGroup
	startRunner := func() context.CancelFunc {
		runnerCtx, stop := context.WithCancel(ctx)
		running.Go(func() { runner.Loop(runnerCtx, 2*time.Second) })
		// Stopping twice is fine.
		return func() { stop(); running.Wait() }
	}
	stopRunner := startRunner()
	slog.Info("Controller started", "controller", controller.ID)
	for ctx.Err() == nil {
		// A database restart drops the session and its lock: take it again
		// (waiting for any controller that got it meanwhile) before going on.
		if lock.Ping(work) != nil {
			slog.Warn("Lost the controller lock; waiting for it again")
			stopRunner()
			lock.Close(context.Background())
			if lock, err = holdLock(ctx, s.cfg.DatabaseURL); err != nil {
				break
			}
			stopRunner = startRunner()
		}
		controller.Tick(work)
		select {
		case <-ctx.Done():
		case <-time.After(interval):
		}
	}
	stopRunner()
	slog.Info("Controller stopped", "controller", controller.ID)
	return nil
}
