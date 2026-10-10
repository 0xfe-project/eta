package api

import (
	"errors"
	"net/http"
	"testing"

	"github.com/akarachen/axp/apps/control-plane/internal/relay"
	"github.com/akarachen/axp/apps/control-plane/internal/tasks"
)

// The relay's MCP answer comes back as it is; the runtime's key is not
// passed on (the relay client sends its own).
func TestAgenvoForwardsToTheRelay(t *testing.T) {
	var got http.Header
	var sent string
	fake := &fakeRelay{mcp: func(body []byte, header http.Header) (*relay.Answer, error) {
		got, sent = header, string(body)
		return &relay.Answer{Status: 200, Header: http.Header{"Content-Type": {"application/json"}}, Body: []byte(`{"answer":1}`)}, nil
	}}
	handler := Internal(&Deps{Tasks: &tasks.Service{Relay: fake}}).Router
	r := do(t, handler, http.MethodPost, "/agenvo/mcp", `{"jsonrpc":"2.0","id":1,"method":"tools/list"}`,
		map[string]string{"Authorization": "Bearer runtime-key", "Mcp-Protocol-Version": "2025-06-18"})
	expect(t, r.status, 200)
	expect(t, string(r.body), `{"answer":1}`)
	expect(t, sent, `{"jsonrpc":"2.0","id":1,"method":"tools/list"}`)
	expect(t, got.Get("Mcp-Protocol-Version"), "2025-06-18")

	fake.mcp = func([]byte, http.Header) (*relay.Answer, error) { return nil, errors.New("dial tcp: refused") }
	expect(t, do(t, handler, http.MethodPost, "/agenvo/mcp", `{}`, nil).status, 502)
	expect(t, do(t, Internal(&Deps{Tasks: &tasks.Service{}}).Router, http.MethodPost, "/agenvo/mcp", `{}`, nil).status, 503)
}
