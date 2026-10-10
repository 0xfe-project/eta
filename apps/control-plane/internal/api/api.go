// Package api is the control plane's HTTP surface: the public API the
// browser calls under /api (through the gateway) and the internal API
// runtimes call under /internal (through the runtime gateway). Each is its
// own httpapi API with its own OpenAPI document, generated from the code;
// the web client's types are generated from the public one.
package api

import (
	"github.com/akarachen/axp/apps/control-plane/internal/chat"
	"github.com/akarachen/axp/apps/control-plane/internal/control"
	"github.com/akarachen/axp/apps/control-plane/internal/tasks"
	"github.com/akarachen/axp/packages/service-go/httpapi"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Deps is what the handlers use.
type Deps struct {
	DB       *pgxpool.Pool
	Chat     *chat.Service
	Protocol *control.Protocol
	Tasks    *tasks.Service
	// Where remote computers reach AXP; the browser's address when empty.
	PublicURL string
	// The forge service, for remote computers' GitHub credentials.
	ForgeURL string
	// What remote computers download from /remote/dl: the axp binaries.
	RemoteDist string
	// Dev serves the internal API's docs.
	Dev bool
}

// Public is the browser's API under /api, and remote computers' under
// /remote.
func Public(d *Deps) *httpapi.API {
	api := httpapi.New(httpapi.Config{Title: "AXP Control Plane", Version: "0.1.0", Prefix: "/api", Docs: true})
	httpapi.AddHealth(api, "/api/health", "control-plane")
	remote(api, d)
	registerChat(api, d)
	registerTasks(api, d)
	return api
}

// Internal is runtimes' API under /internal. It is never served by the
// public server.
func Internal(d *Deps) *httpapi.API {
	api := httpapi.New(httpapi.Config{Title: "AXP Internal Runtime Protocol", Version: "1", Prefix: "/internal", Docs: d.Dev})
	registerInternal(api, d)
	// The tasks plugin, through the runtime gateway's /tasks.
	api.Router.Handle("/tasks/mcp", tasksMCP(d))
	// The agenvo plugin, through the runtime gateway's /agenvo.
	api.Router.Handle("/agenvo/mcp", agenvoMCP(d))
	return api
}
