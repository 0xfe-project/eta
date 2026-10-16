// Package service is AXP's framework for Go services: how one is put
// together, started and stopped. The layout every service follows, and why,
// is in docs/architecture/service-framework.md:
//
//	main.go          the composition root: config, connections, commands
//	internal/<area>  domain packages: the service's rules and its SQL, no HTTP
//	internal/api     transport: huma operations calling the domain
//	migrations       the schema, embedded and applied by pg.Migrate
//
// The packages, from the bottom up (each depends only on those above it):
//
//	apierr       product errors: status, code, message
//	jsontime     the API's timestamps
//	config       settings from the environment, with dev/prod defaults
//	pg           PostgreSQL: pool, own database, migrations, transactions, rows
//	httpapi      huma on chi: error envelope, request ids, operations, serving
//	idempotency  Idempotency-Key for POSTs
//	service      one binary, several commands; telemetry and signals
package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/akarachen/axp/packages/telemetry-go"
	"github.com/danielgtaylor/huma/v2"
)

// Command is one thing the binary does: a server, a worker, a migration.
type Command struct {
	Name string
	// Args describes the arguments, for the usage line.
	Args string
	// Default runs when the binary gets no arguments.
	Default bool
	// Plain commands only print (to stdout): no telemetry.
	Plain bool
	// Run runs until it is done or ctx ends (SIGINT, SIGTERM).
	Run func(ctx context.Context, args []string) error
}

// Main runs the command its first argument names and exits: 0 when it
// returns nil, 1 when it fails, 2 for an unknown command. name is the
// service's, for telemetry.
func Main(name string, commands ...Command) {
	command, args, ok := pick(commands, os.Args[1:])
	if !ok {
		fmt.Fprintln(os.Stderr, usage(name, commands))
		os.Exit(2)
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if command.Plain {
		if err := command.Run(ctx, args); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		return
	}
	logger, shutdown, err := telemetry.Setup(context.Background(), name, command.Name)
	if err != nil {
		fmt.Fprintln(os.Stderr, "telemetry:", err)
		os.Exit(1)
	}
	err = run(ctx, command, args)
	if err != nil {
		logger.Error(name+" stopped", "command", command.Name, "error", err)
	}
	flush, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := telemetry.Shutdown(flush, shutdown); err != nil {
		fmt.Fprintln(os.Stderr, "telemetry:", err)
	}
	if err != nil {
		os.Exit(1)
	}
}

// run runs command, reporting a panic before it ends the process.
func run(ctx context.Context, command Command, args []string) error {
	defer telemetry.Recover()
	return command.Run(ctx, args)
}

func pick(commands []Command, args []string) (Command, []string, bool) {
	if len(args) == 0 {
		for _, c := range commands {
			if c.Default {
				return c, nil, true
			}
		}
		return Command{}, nil, false
	}
	for _, c := range commands {
		if c.Name == args[0] {
			return c, args[1:], true
		}
	}
	return Command{}, nil, false
}

func usage(name string, commands []Command) string {
	var lines []string
	for _, c := range commands {
		lines = append(lines, strings.TrimSpace(c.Name+" "+c.Args))
	}
	return "usage: " + name + " " + strings.Join(lines, " | ")
}

// ErrUsage is a command's answer to arguments it does not take.
var ErrUsage = errors.New("invalid arguments")

// OpenAPI is the command `openapi [api]`: it prints an API's OpenAPI
// document, built without connecting to anything. With one API the name may
// be left out.
func OpenAPI(apis map[string]func() huma.API) Command {
	var names []string
	for name := range apis {
		names = append(names, name)
	}
	return Command{
		Name: "openapi", Args: strings.Join(names, "|"), Plain: true,
		Run: func(_ context.Context, args []string) error {
			build, ok := apis[strings.Join(args, "")]
			if len(args) == 0 && len(apis) == 1 {
				for _, only := range apis {
					build, ok = only, true
				}
			}
			if !ok || len(args) > 1 {
				return fmt.Errorf("%w: openapi %s", ErrUsage, strings.Join(names, "|"))
			}
			data, err := json.MarshalIndent(build().OpenAPI(), "", "  ")
			if err != nil {
				return err
			}
			_, err = fmt.Println(string(data))
			return err
		},
	}
}
