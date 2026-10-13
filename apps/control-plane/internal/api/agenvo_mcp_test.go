package api

import (
	"encoding/json"
	"errors"
	"net/http"
	"regexp"
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

// An execute call's answer names what its script made (tasks.AgenvoMCP);
// the agent gets what the script returned.
func TestAgenvoExecuteNamesWhatItMade(t *testing.T) {
	fake := &fakeRelay{mcp: func(body []byte, _ http.Header) (*relay.Answer, error) {
		key := regexp.MustCompile(`axp:[0-9a-f]{16}`).Find(body)
		record := `{"` + string(key) + `":[{"d":"dev","i":"paseo","m":"paseo.workspaces.create",` +
			`"p":{"source":{"kind":"worktree","branchName":"feat/x"}},"r":{"workspace":{"id":"wks_1","name":"feat-x"}},"x":"accepted"}],"value":"done"}`
		text, _ := json.Marshal(record)
		return &relay.Answer{Status: 200, Header: http.Header{"Content-Type": {"application/json"}},
			Body: []byte(`{"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":` + string(text) + `}]}}`)}, nil
	}}
	handler := Internal(&Deps{Tasks: &tasks.Service{Relay: fake}}).Router
	r := do(t, handler, http.MethodPost, "/agenvo/mcp",
		`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"execute","arguments":{"code":"return 'done'"}}}`, nil)
	expect(t, r.status, 200)
	expect(t, string(r.body), `{"id":1,"jsonrpc":"2.0","result":{"_meta":{"axp/operations":[{"action":"create_worktree","status":"completed",`+
		`"runtime":"paseo","id":"wks_1","name":"feat-x","branch":"feat/x"}]},"content":[{"text":"done","type":"text"}]}}`)
}
