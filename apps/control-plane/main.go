// Command axp-control-plane is AXP's control plane: it keeps agents' state
// and operates their runtimes, connects the GitHub App agents act as (forge),
// keeps routines and is the LLM gateway (llm). One binary, one role per process:
//
//	axp-control-plane serve       both APIs, each on its own listener, and the models (CLIProxyAPI):
//	                              the browser's (AXP_API_ADDR, default :8000) under /api,
//	                              /api/forge, /api/routines, /api/llm, /remote, /share and /preview;
//	                              runtimes' (AXP_INTERNAL_ADDR, default :8001) under /internal,
//	                              /forge, /routines, /tasks, /groups, /agenvo, /artifacts, /attachments,
//	                              /v1 (the LLM gateway's OpenAI-compatible API) and /llm
//	axp-control-plane controller  builds and runs agents' runtimes (Kubernetes) and delivers their work
//	axp-control-plane routine-worker
//	                              runs routines when they fire and revises their briefs
//	axp-control-plane migrate     applies both databases' migrations (the control plane's, routines')
//	axp-control-plane openapi public|internal|routines
//	                              prints an API's OpenAPI document
//
// Settings come from the environment (internal/config); service-go runs
// the commands (docs/architecture/service-framework.md).
package main

import (
	"context"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"
	_ "time/tzdata" // routines' time zones, wherever this runs

	"github.com/akarachen/axp/apps/control-plane/internal/api"
	"github.com/akarachen/axp/apps/control-plane/internal/artifacts"
	"github.com/akarachen/axp/apps/control-plane/internal/auth"
	"github.com/akarachen/axp/apps/control-plane/internal/bundles"
	"github.com/akarachen/axp/apps/control-plane/internal/bundlesvc"
	"github.com/akarachen/axp/apps/control-plane/internal/chat"
	"github.com/akarachen/axp/apps/control-plane/internal/config"
	"github.com/akarachen/axp/apps/control-plane/internal/container"
	"github.com/akarachen/axp/apps/control-plane/internal/control"
	"github.com/akarachen/axp/apps/control-plane/internal/forge"
	"github.com/akarachen/axp/apps/control-plane/internal/github"
	"github.com/akarachen/axp/apps/control-plane/internal/llm"
	"github.com/akarachen/axp/apps/control-plane/internal/objects"
	"github.com/akarachen/axp/apps/control-plane/internal/plugins"
	"github.com/akarachen/axp/apps/control-plane/internal/relay"
	"github.com/akarachen/axp/apps/control-plane/internal/routineapi"
	"github.com/akarachen/axp/apps/control-plane/internal/routines"
	routinemigrations "github.com/akarachen/axp/apps/control-plane/internal/routines/migrations"
	"github.com/akarachen/axp/apps/control-plane/internal/store"
	"github.com/akarachen/axp/apps/control-plane/internal/tasks"
	pluginsgo "github.com/akarachen/axp/packages/plugins-go"
	"github.com/akarachen/axp/packages/service-go"
	"github.com/akarachen/axp/packages/service-go/httpapi"
	"github.com/akarachen/axp/packages/service-go/pg"
	"github.com/danielgtaylor/huma/v2"
	"github.com/jackc/pgx/v5"
	"golang.org/x/sync/errgroup"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/kubernetes"
)

func main() {
	service.Main("control-plane",
		service.Command{Name: "serve", Run: func(ctx context.Context, _ []string) error {
			s, err := connect(ctx, true)
			if err != nil {
				return err
			}
			defer s.close()
			return serve(ctx, s)
		}},
		service.Command{Name: "controller", Args: "[-interval 1s]", Run: func(ctx context.Context, args []string) error {
			flags := flag.NewFlagSet("controller", flag.ExitOnError)
			interval := flags.Duration("interval", time.Second, "time between ticks")
			_ = flags.Parse(args)
			s, err := connect(ctx, false)
			if err != nil {
				return err
			}
			defer s.close()
			return runController(ctx, s, *interval)
		}},
		service.Command{Name: "routine-worker", Run: func(ctx context.Context, _ []string) error {
			cfg, err := config.Load()
			if err != nil {
				return err
			}
			return runRoutineWorker(ctx, cfg)
		}},
		service.Command{Name: "migrate", Run: func(ctx context.Context, _ []string) error {
			cfg, err := config.Load()
			if err != nil {
				return err
			}
			for _, db := range []struct {
				url        string
				migrations pg.Migrations
				create     bool
			}{{cfg.DatabaseURL, store.Migrations, false}, {cfg.RoutinesDatabaseURL, routinemigrations.All, true}} {
				pool, err := pg.Setup(ctx, db.url, db.migrations, db.create)
				if err != nil {
					return err
				}
				pool.Close()
			}
			return nil
		}},
		service.OpenAPI(map[string]func() huma.API{
			"public":   func() huma.API { return api.Public(openAPIDeps()).API },
			"internal": func() huma.API { return api.Internal(openAPIDeps()).API },
			"routines": func() huma.API { return routineapi.New(&routineapi.Deps{}).API },
		}),
	)
}

// openAPIDeps are enough to build the APIs for their documents, connecting
// to nothing.
func openAPIDeps() *api.Deps {
	return &api.Deps{Chat: &chat.Service{}, Tasks: &tasks.Service{}, Artifacts: &artifacts.Service{}, Dev: true}
}

// services is everything a role may need, connected lazily where possible.
type services struct {
	cfg  config.Config
	deps *api.Deps
	// The LLM gateway, in serve's process only; the controller reads its
	// catalog from the internal listener.
	llm    *llm.Module
	models llm.Catalog
	forge  *forge.Server
	// Routines' own database, and their schedules (only published to).
	routines *routineapi.Deps
	queue    *routines.NATS
}

func (s *services) close() {
	s.queue.Close()
	s.routines.DB.Close()
	s.deps.DB.Close()
}

// connect prepares what the roles share; serving opens the LLM gateway
// too, which only the process serving the APIs may run.
func connect(ctx context.Context, serving bool) (*services, error) {
	cfg, err := config.Load()
	if err != nil {
		return nil, err
	}
	pool, err := pg.Open(ctx, cfg.DatabaseURL)
	if err != nil {
		return nil, err
	}
	routinesDB, err := pg.Open(ctx, cfg.RoutinesDatabaseURL)
	if err != nil {
		return nil, err
	}
	queue, err := routines.DialNATS(cfg.NATSURL, "control-plane")
	if err != nil {
		return nil, err
	}
	var module *llm.Module
	var models llm.Catalog = llm.NewRemote(cfg.LLMGatewayURL)
	if serving {
		if module, err = llm.Open(cfg.LLMStateDir, slog.Default()); err != nil {
			return nil, err
		}
		models = module
	}
	gh := github.New(cfg.ForgeStateDir)
	taskService := &tasks.Service{PullHead: func(ctx context.Context, url string) (string, error) {
		pull, err := gh.PullRequest(ctx, url)
		if err != nil {
			return "", err
		}
		return pull.HeadSHA, nil
	}}
	// The relay is the agenvo bundle's service, in the bundles' namespace.
	relayURL, relayBase := "http://agenvo."+cfg.Namespace+"-bundles.svc.cluster.local", ""
	if cfg.PublicURL != "" {
		relayBase = strings.TrimRight(cfg.PublicURL, "/") + "/remote/relay"
	}
	relayClient, err := relay.New(relayURL, relayBase, auth.BundleSecret([]byte(cfg.SecretKey), "agenvo"), pool)
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
		llm:    module,
		models: models,
		forge:  forge.New(gh, slog.Default()),
		routines: &routineapi.Deps{
			DB:       routinesDB,
			Routines: &routines.Service{Schedules: queue, Models: models},
			Docs:     cfg.Dev,
		},
		queue: queue,
		deps: &api.Deps{
			DB:        pool,
			Chat:      chatService,
			Tasks:     taskService,
			Artifacts: artifactService,
			GitHub:    gh,
			Secret:    []byte(cfg.SecretKey),
			PublicURL: cfg.PublicURL, RemoteDist: cfg.RemoteDist,
			Dev: cfg.Dev,
		},
	}, nil
}

// handlers are the two listeners' routes.
func handlers(deps *api.Deps, code *forge.Server, routines *routineapi.Deps, models *llm.Module) (public, internal http.Handler) {
	pub := http.NewServeMux()
	pub.Handle("/", api.Public(deps).Router)
	pub.Handle("/api/forge/", code.Public())
	pub.Handle("/api/routines/", routineapi.New(routines).Router)
	pub.Handle("/api/llm/", models.Public())
	in := http.NewServeMux()
	in.Handle("/", api.Internal(deps).Router)
	in.Handle("/forge/", code.Runtime())
	in.Handle("/routines/mcp", routineapi.MCP(routines))
	in.Handle("/v1/", models.Internal())
	in.Handle("/llm/", models.Internal())
	return pub, in
}

// serve runs both APIs and the LLM gateway in this process, each API on
// its own listener: the public one is all the browser's gateway reaches,
// the internal one all the runtime gateway (and the control plane's other
// processes) do, so routes that trust X-AXP-Agent-Id are never on the
// public listener. The listeners open once the LLM gateway has loaded its
// credentials. Any of the three failing stops all, and SIGTERM stops all.
// Chat streams (SSE) never finish; browsers reconnect with Last-Event-ID,
// and Codex retries a model stream cut short, so stopping does not wait for
// them.
func serve(ctx context.Context, s *services) error {
	if kube, err := container.KubeConfig(); err == nil {
		if objects, err := dynamic.NewForConfig(kube); err == nil {
			s.deps.ServiceStatuses = func(ctx context.Context) (map[string]bundles.ServiceStatus, error) {
				return bundlesvc.Statuses(ctx, objects, s.cfg.Namespace+"-bundles")
			}
		}
	}
	public, internal := handlers(s.deps, s.forge, s.routines, s.llm)
	g, ctx := errgroup.WithContext(ctx)
	g.Go(func() error { return s.llm.Run(ctx) })
	select {
	case <-s.llm.Ready():
	case <-ctx.Done():
		return g.Wait()
	}
	g.Go(func() error { return httpapi.Serve(ctx, s.cfg.APIAddr, public, time.Second) })
	g.Go(func() error { return httpapi.Serve(ctx, s.cfg.InternalAddr, internal, time.Second) })
	return g.Wait()
}

// The pg_advisory_lock keys of the controller (on the control plane's
// database) and the routine worker (on routines'); any constants work.
const (
	controllerLock    = 0x41585043
	routineWorkerLock = 0x41585052
)

// holdLock takes an advisory lock on a connection of its own. Deploys
// briefly run the old and new process side by side; the new one waits here
// until the old one exits.
func holdLock(ctx context.Context, url string, key int64, name string) (*pgx.Conn, error) {
	for {
		conn, err := pgx.Connect(ctx, url)
		if err == nil {
			if _, err = conn.Exec(ctx, "SELECT pg_advisory_lock($1)", key); err == nil {
				return conn, nil
			}
			conn.Close(context.Background())
		}
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		slog.Warn("Cannot take the lock yet", "lock", name, "error", err)
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(time.Second):
		}
	}
}

func runController(ctx context.Context, s *services, interval time.Duration) error {
	slog.Info("Waiting for the controller lock")
	lock, err := holdLock(ctx, s.cfg.DatabaseURL, controllerLock, "controller")
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
	kube, err := container.KubeConfig()
	if err != nil {
		return err
	}
	client, err := kubernetes.NewForConfig(kube)
	if err != nil {
		return err
	}
	objects, err := dynamic.NewForConfig(kube)
	if err != nil {
		return err
	}
	services := &bundlesvc.Reconciler{
		Client: objects, Namespace: s.cfg.Namespace + "-bundles", Bundles: s.deps.Chat.Bundles, DB: s.deps.DB,
		DatabaseURL: s.cfg.DatabaseURL, Secret: []byte(s.cfg.SecretKey), GatewayURL: s.cfg.RuntimeGatewayURL,
		OTLPURL: s.cfg.RuntimeOTLPURL, PublicURL: s.cfg.PublicURL, Registry: s.cfg.Registry, ImageTag: s.cfg.ImageTag,
	}
	driver := &container.Kubernetes{
		Client: client, Namespace: s.cfg.Namespace + "-agents",
		Registry: s.cfg.Registry, BuildKit: s.cfg.BuildKit, BaseImage: s.cfg.RuntimeImage,
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
		RuntimeGatewayURL: s.cfg.RuntimeGatewayURL, NATSURL: s.cfg.NATSURL, OTLPURL: s.cfg.RuntimeOTLPURL, Wake: wake,
	}
	// Remote agents' runs, on their own loop: relay calls take seconds. It
	// runs only while this controller holds the lock (one runner watches
	// and starts each run; a computer's limit holds even with two), and is
	// waited for: a start under way finishes.
	// So are the event import and the notifications.
	runner := &tasks.Runner{DB: s.deps.DB, Service: s.deps.Tasks}
	var running sync.WaitGroup
	startLoops := func() context.CancelFunc {
		loopCtx, stop := context.WithCancel(ctx)
		running.Go(func() { runner.Loop(loopCtx, 2*time.Second) })
		running.Go(func() { events.Import(loopCtx, s.deps.DB, s.deps.Chat, wake) })
		// Agents the API notifies about (chat.Notify): work to deliver or
		// stop. Notifications missed while it reconnects are found by the
		// next tick.
		running.Go(func() { pg.Listen(loopCtx, s.cfg.DatabaseURL, chat.WorkChannel, wake) })
		// Bundles' services, as the catalog and their configs say.
		running.Go(func() { services.Run(loopCtx, 5*time.Second) })
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
			if lock, err = holdLock(ctx, s.cfg.DatabaseURL, controllerLock, "controller"); err != nil {
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

// runRoutineWorker runs routines when their schedules fire, and revises
// briefs from feedback; the API only records and publishes. Once it holds
// the lock (one worker at a time) it owns: failing the runs the previous
// worker left running (Recover), the schedules in NATS (SyncSchedules),
// taking fires, and revising, as the API notifies it and every minute for
// what a notification missed. On SIGTERM it stops taking fires; runs under
// way are recorded as interrupted and revisions left for the next worker.
func runRoutineWorker(ctx context.Context, cfg config.Config) error {
	db, err := pg.Open(ctx, cfg.RoutinesDatabaseURL)
	if err != nil {
		return err
	}
	defer db.Close()
	slog.Info("Waiting for the routine worker lock")
	lock, err := holdLock(ctx, cfg.RoutinesDatabaseURL, routineWorkerLock, "routine-worker")
	if err != nil {
		return err
	}
	defer lock.Close(context.Background())
	queue, err := routines.ConnectNATS(ctx, cfg.NATSURL, "routine-worker")
	if err != nil {
		return err
	}
	defer queue.Close()
	gateway := &routines.Gateway{URL: cfg.LLMGatewayURL, Client: &http.Client{}}
	models := llm.NewRemote(cfg.LLMGatewayURL)
	proxy, err := routines.NewKeyProxy(cfg.LLMGatewayURL)
	if err != nil {
		return err
	}
	runPlugins, err := routinePlugins(cfg.PluginsDir)
	if err != nil {
		return err
	}
	ctx, stop := context.WithCancel(ctx)
	runner := &routines.Runner{
		DB: db, Base: ctx, Model: gateway.Model, Plugins: runPlugins, Proxy: proxy, WorkDir: os.TempDir(),
	}
	// Runs and revisions end with ctx, recording how they ended first.
	defer func() { stop(); runner.Wait() }()
	if err := runner.Recover(ctx); err != nil {
		return err
	}
	if err := routines.SyncSchedules(ctx, db, &routines.Service{Schedules: queue, Models: models}, queue); err != nil {
		return err
	}
	g, ctx := errgroup.WithContext(ctx)
	g.Go(func() error { return queue.Consume(ctx, runner.Fire) })
	g.Go(func() error {
		pg.Listen(ctx, cfg.RoutinesDatabaseURL, routines.FeedbackChannel, runner.Revise)
		return nil
	})
	g.Go(func() error {
		ticker := time.NewTicker(time.Minute)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return nil
			case <-ticker.C:
				// A lost lock (the database restarted) lets another worker
				// take over: stop, and let the container restart.
				if err := lock.Ping(ctx); err != nil && ctx.Err() == nil {
					return fmt.Errorf("lost the routine worker lock: %w", err)
				}
				if err := runner.RevisePending(ctx); err != nil && ctx.Err() == nil {
					slog.Error("Looking for feedback to revise from failed", "error", err)
				}
			}
		}
	})
	slog.Info("Routine worker started")
	return g.Wait()
}

// routinePlugins is the routine target's plugins whose servers' commands,
// and akhook for those with hooks, are installed here; the others are left
// out, with a warning.
func routinePlugins(dir string) ([]*pluginsgo.Plugin, error) {
	list, err := pluginsgo.List(dir, pluginsgo.TargetRoutine)
	if err != nil {
		return nil, err
	}
	var out []*pluginsgo.Plugin
	for _, p := range list {
		missing := ""
		for _, s := range p.Servers {
			if s.Command != "" {
				if _, err := exec.LookPath(pluginsgo.Expand(s.Command, map[string]string{"PLUGIN_ROOT": p.Dir})); err != nil {
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
