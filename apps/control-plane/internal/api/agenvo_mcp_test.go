package api

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"testing"

	"github.com/akarachen/axp/apps/control-plane/internal/relay"
	"github.com/akarachen/axp/apps/control-plane/internal/tasks"
)

// agenvoEnv is the internal API with a relay whose MCP endpoint answers
// with answer, recording what reached it.
type agenvoEnv struct {
	t       *testing.T
	handler http.Handler
	bodies  []string
	headers []http.Header
}

func newAgenvoEnv(t *testing.T, answer func(body []byte) (*relay.Answer, error)) *agenvoEnv {
	e := &agenvoEnv{t: t}
	fake := &fakeRelay{mcp: func(body []byte, header http.Header) (*relay.Answer, error) {
		e.bodies = append(e.bodies, string(body))
		e.headers = append(e.headers, header)
		return answer(body)
	}}
	e.handler = Internal(&Deps{Tasks: &tasks.Service{Relay: fake}}).Router
	return e
}

func (e *agenvoEnv) post(body any) response {
	e.t.Helper()
	return do(e.t, e.handler, http.MethodPost, "/agenvo/mcp", body, map[string]string{
		"Accept": "application/json, text/event-stream", "Authorization": "Bearer runtime-key",
		"X-AXP-Agent-Id": "agent-1", "Mcp-Protocol-Version": "2025-06-18",
	})
}

func agenvoCall(name string, args map[string]any) map[string]any {
	return map[string]any{"jsonrpc": "2.0", "id": 7, "method": "tools/call", "params": map[string]any{"name": name, "arguments": args}}
}

func toolAnswer(text string, isError bool) *relay.Answer {
	body, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": 7, "result": map[string]any{
		"isError": isError, "content": []map[string]string{{"type": "text", "text": text}},
	}})
	return &relay.Answer{Status: 200, Header: http.Header{"Content-Type": {"application/json"}}, Body: body}
}

type rpcAnswer struct {
	Result *struct {
		IsError bool `json:"isError"`
		Content []struct {
			Text string `json:"text"`
		} `json:"content"`
	} `json:"result"`
	Error *struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

func (r response) rpc(t *testing.T) rpcAnswer {
	t.Helper()
	var out rpcAnswer
	r.json(t, &out)
	return out
}

// The relay's own tools reach it unchanged, with the relay's answer (the
// native outcome, errors and all) passed back as it is.
func TestAgenvoForwardsTheRelaysTools(t *testing.T) {
	outcome := `{"execution":"unknown","requestId":"r1","error":{"code":"device_offline","message":"device_offline"}}`
	e := newAgenvoEnv(t, func([]byte) (*relay.Answer, error) { return toolAnswer(outcome, false), nil })
	call := agenvoCall("execute", map[string]any{"code": "return await call({deviceId:'d',instanceId:'paseo'}, 'paseo.agents.list', {});"})
	r := e.post(call)
	expect(t, r.status, 200)
	got := r.rpc(t)
	expect(t, got.Result.Content[0].Text, outcome)
	sent, _ := json.Marshal(call)
	expect(t, e.bodies[0], string(sent))
	// The runtime's key is not passed on; the relay client adds its own.
	expect(t, e.headers[0].Get("Mcp-Protocol-Version"), "2025-06-18")
	for _, method := range []string{"initialize", "tools/list", "ping", "notifications/initialized"} {
		e.post(map[string]any{"jsonrpc": "2.0", "id": 1, "method": method})
	}
	expect(t, len(e.bodies), 5)
}

// Event subscriptions (callback URLs) and anything else stay out.
func TestAgenvoRefusesOtherMethods(t *testing.T) {
	e := newAgenvoEnv(t, func([]byte) (*relay.Answer, error) { t.Fatal("reached the relay"); return nil, nil })
	for _, method := range []string{"events/subscribe", "events/list", "resources/list"} {
		got := e.post(map[string]any{"jsonrpc": "2.0", "id": 1, "method": method, "params": map[string]any{}}).rpc(t)
		if got.Error == nil || got.Error.Code != -32601 {
			t.Fatalf("%s: %+v", method, got)
		}
	}
	got := e.post(`[{"jsonrpc":"2.0","id":1,"method":"tools/list"}]`).rpc(t)
	expect(t, got.Error.Code, -32700)
	expect(t, do(t, e.handler, http.MethodGet, "/agenvo/mcp", nil, nil).status, 405)
}

// A result over the limit is refused as a whole, saying so, never cut.
func TestAgenvoRefusesResultsOverTheLimit(t *testing.T) {
	big := strings.Repeat("x", agenvoResultLimit+1)
	e := newAgenvoEnv(t, func([]byte) (*relay.Answer, error) { return toolAnswer(big, false), nil })
	got := e.post(agenvoCall("execute", map[string]any{"code": "return 1"})).rpc(t)
	if !got.Result.IsError || !strings.HasPrefix(got.Result.Content[0].Text, "result_too_large:") ||
		!strings.Contains(got.Result.Content[0].Text, "the script did run") {
		t.Fatalf("%+v", got)
	}

	// The same in an event stream; results at the limit pass whole.
	exact := strings.Repeat("y", agenvoResultLimit)
	for _, text := range []string{big, exact} {
		answer := toolAnswer(text, false)
		e = newAgenvoEnv(t, func([]byte) (*relay.Answer, error) {
			return &relay.Answer{Status: 200, Header: http.Header{"Content-Type": {"text/event-stream"}},
				Body: append(append([]byte("event: message\ndata: "), answer.Body...), "\n\n"...)}, nil
		})
		r := e.post(agenvoCall("execute", map[string]any{"code": "return 1"}))
		var data string
		for line := range strings.SplitSeq(string(r.body), "\n") {
			if rest, ok := strings.CutPrefix(line, "data: "); ok {
				data = rest
			}
		}
		var event rpcAnswer
		if err := json.Unmarshal([]byte(data), &event); err != nil {
			t.Fatal(err)
		}
		expect(t, event.Result.IsError, text == big)
		if text == exact {
			expect(t, event.Result.Content[0].Text, exact)
		}
	}
}

// Without a relay, or when it cannot be reached, the agent is told so, and
// that an execute's writes are then unknown.
func TestAgenvoReportsAnUnreachableRelay(t *testing.T) {
	handler := Internal(&Deps{Tasks: &tasks.Service{}}).Router
	r := do(t, handler, http.MethodPost, "/agenvo/mcp", agenvoCall("search", map[string]any{"query": ""}), nil)
	got := r.rpc(t)
	if got.Error == nil || !strings.Contains(got.Error.Message, "not set up") {
		t.Fatalf("%+v", got)
	}

	e := newAgenvoEnv(t, func([]byte) (*relay.Answer, error) { return nil, errors.New("relay: dial tcp: refused") })
	got = e.post(agenvoCall("execute", map[string]any{"code": "return 1"})).rpc(t)
	if got.Error == nil || !strings.Contains(got.Error.Message, "may or may not have happened") {
		t.Fatalf("%+v", got)
	}
}
