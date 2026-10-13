package api

import (
	"io"
	"log/slog"
	"net/http"

	"github.com/akarachen/axp/packages/service-go/pg"
)

// The agenvo plugin's MCP server is the agenvo relay's own (search and
// execute), forwarded with the control plane's grant, which the agent never
// sees. An execute call's answer also names the places its script made
// (tasks.Service.AgenvoMCP). The runtime gateway authenticates the runtime and checks the plugin
// (apps/gateway/runtime.caddy, /agenvo).
func agenvoMCP(d *Deps) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if d.Tasks == nil || d.Tasks.Relay == nil {
			http.Error(w, "remote computers are not set up (no relay)", http.StatusServiceUnavailable)
			return
		}
		if r.Method != http.MethodPost {
			w.Header().Set("Allow", http.MethodPost)
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 1<<20))
		if err != nil {
			http.Error(w, "request too large", http.StatusRequestEntityTooLarge)
			return
		}
		var db pg.DB
		if d.DB != nil {
			db = d.DB
		}
		answer, err := d.Tasks.AgenvoMCP(r.Context(), db, body, r.Header)
		if err != nil {
			slog.WarnContext(r.Context(), "agenvo MCP request failed", "agent", r.Header.Get("X-AXP-Agent-Id"), "error", err)
			http.Error(w, "the relay could not be reached: "+err.Error(), http.StatusBadGateway)
			return
		}
		for _, name := range []string{"Content-Type", "Mcp-Session-Id"} {
			if v := answer.Header.Get(name); v != "" {
				w.Header().Set(name, v)
			}
		}
		w.WriteHeader(answer.Status)
		_, _ = w.Write(answer.Body)
	})
}
