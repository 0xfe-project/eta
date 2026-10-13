// Command axp-control-plane is AXP's control plane: it keeps agents' state
// and operates their runtimes. One binary, one role per process:
//
//	axp-control-plane api         the browser's API under /api (AXP_API_ADDR, default :8000)
//	axp-control-plane internal    the runtime gateway's API under /internal (AXP_INTERNAL_ADDR, default :8001)
//	axp-control-plane controller  builds and runs agents' containers and delivers their work (Docker socket)
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
	"github.com/akarachen/axp/apps/control-plane/internal/artifacts"
	"github.com/akarachen/axp/apps/control-plane/internal/bundles"
	"github.com/akarachen/axp/apps/control-plane/internal/chat"
	"github.com/akarachen/axp/apps/control-plane/internal/config"
	"github.com/akarachen/axp/apps/control-plane/internal/container"
	"github.com/akarachen/axp/apps/control-plane/internal/control"
	"github.com/akarachen/axp/apps/control-plane/internal/llm"
	"github.com/akarachen/axp/apps/control-plane/internal/objects"
	"github.com/akarachen/axp/apps/control-plane/internal/plugins"
	"github.com/akarachen/axp/apps/control-plane/internal/relay"
	"github.com/akarachen/axp/apps/control-plane/internal/store"
	"github.com/akarachen/axp/apps/control-plane/internal/tasks"
	"github.com/akarachen/axp/packages/service-go"
	"github.com/akarachen/axp/packages/service-go/httpapi"
	"github.com/akarachen/axp/packages/service-go/pg"
	"github.com/danielgtaylor/huma/v2"
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
		service.Command{Name: "controller", Args: "[-interval 1s]", Run: func(ctx context.Context, args []string) error {
			flags := flag.NewFlagSet("controller", flag.ExitOnError)
			interval := flags.Duration("interval", time.Second, "time between ticks")
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
			driver, err := container.NewDocker(cfg.Dev, cfg.RuntimeImage)
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
	return &api.Deps{Chat: &chat.Service{}, Tasks: &tasks.Service{}, Artifacts: &artifacts.Service{}, Dev: true}
}

// services is everything a role may need, connected lazily where possible.
type services struct {
	cfg    config.Config
	deps   *api.Deps
	models *llm.Gateway
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
	models := llm.NewGateway(cfg.LLMGatewayURL)
	taskService := &tasks.Service{}
	relayClient, err := relay.New(cfg.RelayURL, cfg.RelayBaseURL, cfg.RelayAdminSecret, cfg.RelayCAFile, pool)
	if err != nil {
		return nil, err
	}
	if relayClient != nil {
		taskService.Relay = relayClient
	}
	chatService := &chat.Service{
		Models:  models,
		Bundles: &bundles.Catalog{Dir: cfg.BundlesDir, Plugins: &plugins.Catalog{Dir: cfg.PluginsDir}},
		Cursors: chat.Cursors{Secret: []byte(cfg.SecretKey)},
	}
	artifactService := &artifacts.Service{DB: pool, Tasks: taskService, Secret: []byte(cfg.SecretKey), Limits: artifacts.DefaultLimits}
	if cfg.S3Endpoint != "" {
		store, err := objects.NewS3(objects.Config{
			Endpoint: cfg.S3Endpoint, Bucket: cfg.S3Bucket, Region: cfg.S3Region,
			AccessKeyID: cfg.S3AccessKeyID, SecretAccessKey: cfg.S3SecretAccessKey,
		})
		if err != nil {
			return nil, err
		}
		artifactService.Store = store
		chatService.Store = store
	}
	return &services{
		cfg:    cfg,
		models: models,
		deps: &api.Deps{
			DB:        pool,
			Chat:      chatService,
			Tasks:     taskService,
			Artifacts: artifactService,
			Secret:    []byte(cfg.SecretKey),
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

// listen wakes the controller for every agent the API notifies about
// (chat.Notify): work to deliver or stop. Notifications missed while it
// reconnects are found by the next tick.
func listen(ctx context.Context, url string, wake func(string)) {
	for ctx.Err() == nil {
		conn, err := pgx.Connect(ctx, url)
		if err == nil {
			if _, err = conn.Exec(ctx, "LISTEN "+chat.WorkChannel); err == nil {
				for {
					notification, waitErr := conn.WaitForNotification(ctx)
					if waitErr != nil {
						err = waitErr
						break
					}
					wake(notification.Payload)
				}
			}
			conn.Close(context.Background())
		}
		if ctx.Err() != nil {
			return
		}
		slog.Warn("Listening for agents' work failed; retrying", "error", err)
		select {
		case <-ctx.Done():
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
	// The step in progress always finishes, even after SIGTERM: it may be
	// starting a container or delivering a command.
	work := context.WithoutCancel(ctx)
	driver, err := container.NewDocker(s.cfg.Dev, s.cfg.RuntimeImage)
	if err != nil {
		return err
	}
	if err := driver.EnsureNetwork(work); err != nil {
		return err
	}
	events, err := control.ConnectEvents(s.cfg.NATSURL)
	if err != nil {
		return err
	}
	if err := events.EnsureStream(work); err != nil {
		return err
	}
	wakes := make(chan string, 1024)
	wake := func(agentID string) {
		select {
		case wakes <- agentID:
		default: // the next tick finds it
		}
	}
	controller := &control.Controller{
		DB: s.deps.DB, Chat: s.deps.Chat, Bundles: s.deps.Chat.Bundles, Driver: driver, Models: s.models,
		Secret: []byte(s.cfg.SecretKey), PluginsDir: s.cfg.PluginsDir,
		RuntimeGatewayURL: s.cfg.RuntimeGatewayURL, NATSURL: s.cfg.NATSURL, Wake: wake,
	}
	// Remote agents' runs, on their own loop: relay calls take seconds. It
	// runs only while this controller holds the lock (a computer's capacity
	// assumes one runner), and is waited for: a start under way finishes.
	// So are the event import and the notifications.
	runner := &tasks.Runner{DB: s.deps.DB, Service: s.deps.Tasks}
	var running sync.WaitGroup
	startLoops := func() context.CancelFunc {
		loopCtx, stop := context.WithCancel(ctx)
		running.Go(func() { runner.Loop(loopCtx, 2*time.Second) })
		running.Go(func() { events.Import(loopCtx, s.deps.DB, s.deps.Chat, wake) })
		running.Go(func() { listen(loopCtx, s.cfg.DatabaseURL, wake) })
		// Stopping twice is fine.
		return func() { stop(); running.Wait() }
	}
	stopLoops := startLoops()
	slog.Info("Controller started")
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	controller.Tick(work)
	for ctx.Err() == nil {
		// A database restart drops the session and its lock: take it again
		// (waiting for any controller that got it meanwhile) before going on.
		if lock.Ping(work) != nil {
			slog.Warn("Lost the controller lock; waiting for it again")
			stopLoops()
			lock.Close(context.Background())
			if lock, err = holdLock(ctx, s.cfg.DatabaseURL); err != nil {
				break
			}
			stopLoops = startLoops()
		}
		select {
		case <-ctx.Done():
		case <-ticker.C:
			controller.Tick(work)
		case agentID := <-wakes:
			controller.Dispatch(work, agentID)
		}
	}
	stopLoops()
	slog.Info("Controller stopped")
	return nil
}
