package relay

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
)

// Recording a script's native calls: the relay runs the recording script
// (checked against @agenvo/server's QuickJS runner), so these give Restore
// the answers it makes.

func execute(code string) []byte {
	body, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": 7, "method": "tools/call",
		"params": map[string]any{"name": "execute", "arguments": map[string]any{"code": code}}})
	return body
}

func answer(id int, failed bool, texts ...string) []byte {
	content := []map[string]string{}
	for _, t := range texts {
		content = append(content, map[string]string{"type": "text", "text": t})
	}
	body, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": id, "result": map[string]any{"content": content, "isError": failed}})
	return body
}

func texts(t *testing.T, body []byte) ([]string, map[string]any) {
	t.Helper()
	var rpc struct {
		Result struct {
			Content []struct {
				Text string `json:"text"`
			} `json:"content"`
			Meta map[string]any `json:"_meta"`
		} `json:"result"`
	}
	if err := json.Unmarshal(body, &rpc); err != nil {
		t.Fatalf("%s: %v", body, err)
	}
	var out []string
	for _, c := range rpc.Result.Content {
		out = append(out, c.Text)
	}
	return out, rpc.Result.Meta
}

func TestRecordOnlyRewritesExecute(t *testing.T) {
	for _, body := range []string{
		`{"jsonrpc":"2.0","id":1,"method":"tools/list"}`,
		`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"search","arguments":{"query":""}}}`,
		`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"execute","arguments":{}}}`,
		`not json`,
	} {
		if out, r := Record([]byte(body), nil); string(out) != body || r != nil {
			t.Errorf("%s became %s", body, out)
		}
	}
	code := "const call = 1; return call"
	out, r := Record(execute(code), []string{"worktree.create"})
	var rpc struct {
		ID     int `json:"id"`
		Params struct {
			Arguments struct {
				Code string `json:"code"`
			} `json:"arguments"`
		} `json:"params"`
	}
	if err := json.Unmarshal(out, &rpc); err != nil || r == nil || rpc.ID != 7 {
		t.Fatalf("%s: %v", out, err)
	}
	// The code keeps its first line, in a function of its own.
	first, _, _ := strings.Cut(rpc.Params.Arguments.Code, "\n")
	if !strings.HasSuffix(first, "(async () => { "+code) || r.shift != len(first)-len(code) {
		t.Fatalf("first line %q", first)
	}
}

func TestRestorePutsBackWhatTheScriptReturned(t *testing.T) {
	calls := `[{"d":"dev","i":"herdr","m":"worktree.create","p":{"branch":"b"},"r":{"result":{}},"x":"accepted"},` +
		`{"d":"dev","i":"herdr","m":"pane.read","s":true}]`
	for value, want := range map[string]string{
		`"plain <text>\n"`:            "plain <text>\n",
		`{"b":2,"a":[1,1.5e+300]}`:    `{"b":2,"a":[1,1.5e+300]}`,
		`null`:                        "null",
		`"{\"looks\":\"like JSON\"}"`: `{"looks":"like JSON"}`,
	} {
		_, r := Record(execute("return 1"), nil)
		text := `{"` + r.key() + `":` + calls + `,"value":` + value + `}`
		var got []ScriptCall
		out := r.Restore("application/json", answer(7, false, text), func(c []ScriptCall) map[string]any {
			got = c
			return map[string]any{"axp/operations": []string{"x"}}
		})
		parts, meta := texts(t, out)
		if len(parts) != 1 || parts[0] != want {
			t.Errorf("%s: got %q, want %q", value, parts, want)
		}
		want := []ScriptCall{{DeviceID: "dev", InstanceID: "herdr", Method: "worktree.create",
			Params: json.RawMessage(`{"branch":"b"}`), Result: json.RawMessage(`{"result":{}}`), Execution: "accepted"}}
		if !reflect.DeepEqual(got, want) || meta["axp/operations"] == nil {
			t.Errorf("%s: calls %+v, meta %v", value, got, meta)
		}
	}
}

func TestRestoreLeavesAnswersItDidNotMake(t *testing.T) {
	_, r := Record(execute("return 1"), nil)
	for _, body := range [][]byte{
		answer(7, false, `{"value":1}`),
		answer(7, false, `{"axp:other":[],"value":1}`),
		answer(8, false, `{"`+r.key()+`":[],"value":1}`),
		[]byte("<html>"),
	} {
		if out := r.Restore("application/json", body, func([]ScriptCall) map[string]any { return map[string]any{"k": 1} }); string(out) != string(body) {
			t.Errorf("%s became %s", body, out)
		}
	}
}

func TestRestoreTakesTheRecordOutOfAnError(t *testing.T) {
	_, r := Record(execute("return 1"), nil)
	recorded := `[{"d":"dev","i":"paseo","m":"paseo.workspaces.create","p":{"title":"t"}},{"d":"dev","i":"paseo","m":"x","s":true}]`
	receipts := `[{"deviceId":"dev","instanceId":"paseo","method":"paseo.workspaces.create","execution":"unknown","error":{"code":"native_error"}}]`
	body := answer(7, true,
		"Execution failed (script_error): Error: after"+r.marker()+recorded+"\nRequest ID: abc",
		"Dispatched calls (not rolled back; inspect native state before repeating writes):\n"+receipts)
	var got []ScriptCall
	parts, _ := texts(t, r.Restore("application/json", body, func(c []ScriptCall) map[string]any { got = c; return nil }))
	if parts[0] != "Execution failed (script_error): Error: after\nRequest ID: abc" || !strings.HasPrefix(parts[1], "Dispatched calls") {
		t.Fatalf("texts %q", parts)
	}
	// Unsettled when it threw; the relay saw it end unknown.
	want := []ScriptCall{{DeviceID: "dev", InstanceID: "paseo", Method: "paseo.workspaces.create",
		Params: json.RawMessage(`{"title":"t"}`), Execution: "unknown", Error: &Fault{Code: "native_error"}}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("calls %+v", got)
	}

	// Stopped by the relay, it recorded nothing: the relay's receipts are all.
	body = answer(7, true, "Execution failed (script_timeout): Script deadline exceeded\nRequest ID: abc",
		"Dispatched calls (not rolled back):\n"+receipts)
	r.Restore("application/json", body, func(c []ScriptCall) map[string]any { got = c; return nil })
	want[0].Params = nil
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("calls %+v", got)
	}

	// Its syntax errors point into its own first line, as they did.
	body = answer(7, true, `Execution failed (script_error): {"stack":"    at eval.js:4:`+itoa(r.shift+29)+`\n"}`)
	if parts, _ := texts(t, r.Restore("application/json", body, func([]ScriptCall) map[string]any { return nil })); !strings.Contains(parts[0], `eval.js:4:29\n`) {
		t.Fatalf("texts %q", parts)
	}
}

func TestRestoreReadsEventStreams(t *testing.T) {
	_, r := Record(execute("return 1"), nil)
	body := "event: message\ndata: " + string(answer(7, false, `{"`+r.key()+`":[],"value":"hi"}`)) + "\n\n"
	out := r.Restore("text/event-stream", []byte(body), func([]ScriptCall) map[string]any { return map[string]any{"k": true} })
	lines := strings.Split(string(out), "\n")
	if lines[0] != "event: message" || !strings.HasPrefix(lines[1], "data: ") {
		t.Fatalf("%s", out)
	}
	parts, meta := texts(t, []byte(strings.TrimPrefix(lines[1], "data: ")))
	if parts[0] != "hi" || meta["k"] != true {
		t.Fatalf("%q %v", parts, meta)
	}
}

func itoa(n int) string { b, _ := json.Marshal(n); return string(b) }
