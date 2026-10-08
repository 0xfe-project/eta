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
// Settings come from the environment (internal/config).
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"
	_ "time/tzdata" // routines' time zones, wherever this runs

	"github.com/akarachen/axp/apps/control-plane/internal/api"
	"github.com/akarachen/axp/apps/control-plane/internal/chat"
	"github.com/akarachen/axp/apps/control-plane/internal/config"
	"github.com/akarachen/axp/apps/control-plane/internal/container"
	"github.com/akarachen/axp/apps/control-plane/internal/control"
	"github.com/akarachen/axp/apps/control-plane/internal/llm"
	"github.com/akarachen/axp/apps/control-plane/internal/plugins"
	"github.com/akarachen/axp/apps/control-plane/internal/queue"
	"github.com/akarachen/axp/apps/control-plane/internal/relay"
	"github.com/akarachen/axp/apps/control-plane/internal/routines"
	"github.com/akarachen/axp/apps/control-plane/internal/snapshots"
	"github.com/akarachen/axp/apps/control-plane/internal/store"
	"github.com/akarachen/axp/apps/control-plane/internal/tasks"
	"github.com/akarachen/axp/packages/telemetry-go"
	"github.com/danielgtaylor/huma/v2"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

const usage = "usage: axp-control-plane api|internal|controller|migrate|openapi public|internal|ensure-runtime-network"

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, usage)
		os.Exit(2)
	}
	role, args := os.Args[1], os.Args[2:]
	if role == "openapi" {
		if err := printOpenAPI(args); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		return
	}
	logger, shutdown, err := telemetry.Setup(context.Background(), "control-plane")
	if err != nil {
		fmt.Fprintln(os.Stderr, "telemetry:", err)
		os.Exit(1)
	}
	err = run(role, args)
	if err != nil && !errors.Is(err, http.ErrServerClosed) {
		logger.Error("control-plane stopped", "role", role, "error", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := telemetry.Shutdown(ctx, shutdown); err != nil {
		fmt.Fprintln(os.Stderr, "telemetry:", err)
	}
	if err != nil && !errors.Is(err, http.ErrServerClosed) {
		os.Exit(1)
	}
}

// printOpenAPI prints an API's document; it needs no database or queue.
func printOpenAPI(args []string) error {
	if len(args) != 1 {
		return errors.New(usage)
	}
	var document huma.API
	deps := &api.Deps{Chat: &chat.Service{}, Tasks: &tasks.Service{}, Dev: true}
	switch args[0] {
	case "public":
		_, document = api.Public(deps)
	case "internal":
		_, document = api.Internal(deps)
	default:
		return errors.New(usage)
	}
	data, err := json.MarshalIndent(document.OpenAPI(), "", "  ")
	if err != nil {
		return err
	}
	_, err = fmt.Println(string(data))
	return err
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
	pool, err := store.Open(ctx, cfg.DatabaseURL)
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
			Routines:  &routines.Service{Queue: q, Models: models},
			Protocol:  &control.Protocol{DB: pool, Chat: chatService, Snapshots: s3, Secret: []byte(cfg.SecretKey)},
			Tasks:     taskService,
			PublicURL: cfg.PublicURL, ForgeURL: cfg.ForgeURL, RemoteDist: cfg.RemoteDist,
			Dev: cfg.Dev,
		},
	}, nil
}

func run(role string, args []string) error {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	switch role {
	case "migrate":
		cfg, err := config.Load()
		if err != nil {
			return err
		}
		pool, err := store.Open(ctx, cfg.DatabaseURL)
		if err != nil {
			return err
		}
		defer pool.Close()
		return store.Migrate(ctx, pool)
	case "ensure-runtime-network":
		cfg, err := config.Load()
		if err != nil {
			return err
		}
		driver, err := container.NewDocker(cfg.Dev)
		if err != nil {
			return err
		}
		return driver.EnsureNetwork(ctx)
	case "api", "internal":
		s, err := connect(ctx)
		if err != nil {
			return err
		}
		if role == "api" {
			handler, _ := api.Public(s.deps)
			return serve(ctx, s.cfg.APIAddr, handler)
		}
		handler, _ := api.Internal(s.deps)
		return serve(ctx, s.cfg.InternalAddr, handler)
	case "controller":
		flags := flag.NewFlagSet("controller", flag.ExitOnError)
		interval := flags.Duration("interval", 500*time.Millisecond, "time between ticks")
		_ = flags.Parse(args)
		s, err := connect(ctx)
		if err != nil {
			return err
		}
		return runController(ctx, s, *interval)
	}
	return errors.New(usage)
}

func serve(ctx context.Context, addr string, handler http.Handler) error {
	srv := &http.Server{Addr: addr, Handler: handler, ReadHeaderTimeout: 10 * time.Second}
	go func() {
		<-ctx.Done()
		// Chat streams (SSE) never finish; browsers reconnect with
		// Last-Event-ID, so deploys do not wait for them.
		shutdownCtx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		if srv.Shutdown(shutdownCtx) != nil {
			_ = srv.Close()
		}
	}()
	slog.Info("control-plane listening", "addr", addr)
	return srv.ListenAndServe()
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
	defer func() { lock.Close(context.Background()) }()
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
	runner := &routines.Runner{
		DB: s.deps.DB, Queue: s.queue, Driver: driver, Models: s.models, Completer: s.models,
		Secret: []byte(s.cfg.SecretKey), RuntimeGatewayURL: s.cfg.RuntimeGatewayURL, NATSURL: s.cfg.NATSURL,
		CodexLaunch: s.cfg.CodexLaunch,
	}
	if err := runner.SyncSchedules(work); err != nil {
		return err
	}
	controller := &control.Controller{
		DB: s.deps.DB, Chat: s.deps.Chat, Queue: s.queue, Driver: driver, Snapshots: s.snapshots,
		Models: s.models, Routines: runner, Secret: []byte(s.cfg.SecretKey),
		RuntimeGatewayURL: s.cfg.RuntimeGatewayURL, NATSURL: s.cfg.NATSURL, CodexLaunch: s.cfg.CodexLaunch,
		ID: "controller-" + uuid.NewString()[:8], HostID: control.HostID(),
	}
	// Remote agents' runs, on their own loop: relay calls take seconds.
	go (&tasks.Runner{DB: s.deps.DB, Service: s.deps.Tasks}).Loop(ctx, 2*time.Second)
	slog.Info("Controller started", "controller", controller.ID)
	for ctx.Err() == nil {
		// A database restart drops the session and its lock: take it again
		// (waiting for any controller that got it meanwhile) before going on.
		if lock.Ping(work) != nil {
			slog.Warn("Lost the controller lock; waiting for it again")
			lock.Close(context.Background())
			if lock, err = holdLock(ctx, s.cfg.DatabaseURL); err != nil {
				break
			}
		}
		controller.Tick(work)
		select {
		case <-ctx.Done():
		case <-time.After(interval):
		}
	}
	slog.Info("Controller stopped", "controller", controller.ID)
	return nil
}
