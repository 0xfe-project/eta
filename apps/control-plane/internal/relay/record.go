package relay

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

// What an agent's execute script did, for its transcript (the agenvo plugin,
// docs/architecture/chat-runtime.md). The relay answers a script with what it
// returns and nothing else, and names the calls it made only when it fails,
// without their parameters. So the control plane, which forwards the
// script, has it record its own native calls as they go: `call` is wrapped,
// never repeated, and each call's target, method and outcome are kept, with
// parameters and result for the methods asked for. The script returns them
// beside its own value, or adds them to its error; Restore takes them back
// out, so the agent gets the answer the script alone would have given.

// ScriptCall is one native call a script made.
type ScriptCall struct {
	DeviceID   string `json:"d"`
	InstanceID string `json:"i"`
	Method     string `json:"m"`
	// Parameters and result, for the methods detailed.
	Params json.RawMessage `json:"p,omitempty"`
	Result json.RawMessage `json:"r,omitempty"`
	// Empty while it had not settled when the script ended.
	Execution string `json:"x,omitempty"`
	Error     *Fault `json:"e,omitempty"`
	// Refused before it reached the relay (a bad target, say).
	Refused bool `json:"s,omitempty"`
}

// Recording is an execute call that records its native calls.
type Recording struct {
	id    json.RawMessage
	nonce string
	// How far the script's first line moved right.
	shift int
}

// detailedLimit is how many calls keep their parameters and result.
const detailedLimit = 20

// Record rewrites body, when it is a call of the execute tool, so that its
// script records its native calls, with parameters and result for the
// methods in detailed. It returns body as it is otherwise.
func Record(body []byte, detailed []string) ([]byte, *Recording) {
	var rpc map[string]json.RawMessage
	var params, args map[string]json.RawMessage
	var method, name, code string
	if json.Unmarshal(body, &rpc) != nil || json.Unmarshal(rpc["method"], &method) != nil || method != "tools/call" ||
		json.Unmarshal(rpc["params"], &params) != nil || json.Unmarshal(params["name"], &name) != nil || name != "execute" ||
		json.Unmarshal(params["arguments"], &args) != nil || json.Unmarshal(args["code"], &code) != nil {
		return body, nil
	}
	nonce := make([]byte, 8)
	_, _ = rand.Read(nonce)
	r := &Recording{id: rpc["id"], nonce: hex.EncodeToString(nonce)}
	prefix, suffix := r.script(detailed)
	r.shift = len(prefix)
	args["code"], _ = json.Marshal(prefix + code + suffix)
	params["arguments"], _ = json.Marshal(args)
	rpc["params"], _ = json.Marshal(params)
	out, err := json.Marshal(rpc)
	if err != nil {
		return body, nil
	}
	return out, r
}

func (r *Recording) key() string    { return "axp:" + r.nonce }
func (r *Recording) marker() string { return "\n[axp:" + r.nonce + "] " }

// script is what goes around a script's code to record its calls. The
// code stays on its first line, so the relay's line numbers hold (Restore
// moves its columns back), and in a function of its own, so it may declare
// anything, `call` too. What it returns or throws reaches the relay as
// before; a function or symbol is returned bare, as the relay refuses it
// the same way.
func (r *Recording) script(detailed []string) (string, string) {
	methods, _ := json.Marshal(detailed)
	key, _ := json.Marshal(r.key())
	marker, _ := json.Marshal(r.marker())
	v := "__axp" + r.nonce
	prefix := fmt.Sprintf(`const %[1]sCall = call, %[1]sCalls = [], %[1]sDetailed = new Set(%[2]s); let %[1]sKept = 0, %[1]sValue; try { %[1]sValue = await (async (call) => (async () => { `,
		v, methods)
	return prefix, fmt.Sprintf(`
})())(async (target, method, params) => {
  const pending = %[1]sCall(target, method, params), c = { m: method };
  try {
    c.d = target.deviceId; c.i = target.instanceId;
    if (%[1]sDetailed.has(method) && %[1]sKept < %[4]d) { c.p = JSON.parse(JSON.stringify(params === undefined ? {} : params)); %[1]sKept++; }
  } catch {}
  %[1]sCalls.push(c);
  let o;
  try { o = await pending; } catch (e) { c.s = true; throw e; }
  try {
    c.x = o.execution;
    if (o.error) c.e = { code: o.error.code, message: o.error.message, native: o.error.native };
    if ("p" in c) c.r = o.result;
  } catch {}
  return o;
}); } catch (e) { throw { toString: () => String(e) + %[3]s + JSON.stringify(%[1]sCalls) }; }
if (typeof %[1]sValue === "function" || typeof %[1]sValue === "symbol") return %[1]sValue;
return { %[2]s: %[1]sCalls, value: %[1]sValue === undefined ? null : %[1]sValue };`,
		v, key, marker, detailedLimit)
}

// Restore is the relay's answer (JSON, or server-sent events) without the
// record, and with meta(calls) as its result's _meta when that is not nil.
// An answer it cannot read is returned as it is.
func (r *Recording) Restore(contentType string, body []byte, meta func([]ScriptCall) map[string]any) []byte {
	if !strings.Contains(contentType, "text/event-stream") {
		if out, ok := r.restore(body, meta); ok {
			return out
		}
		return body
	}
	lines := bytes.Split(body, []byte("\n"))
	for i, line := range lines {
		rest, ok := bytes.CutPrefix(line, []byte("data:"))
		if !ok {
			continue
		}
		if out, ok := r.restore(bytes.TrimSpace(rest), meta); ok {
			lines[i] = append([]byte("data: "), out...)
		}
	}
	return bytes.Join(lines, []byte("\n"))
}

type content = map[string]json.RawMessage

func (r *Recording) restore(data []byte, meta func([]ScriptCall) map[string]any) ([]byte, bool) {
	var rpc, result map[string]json.RawMessage
	var parts []content
	if json.Unmarshal(data, &rpc) != nil || !bytes.Equal(rpc["id"], r.id) ||
		json.Unmarshal(rpc["result"], &result) != nil || json.Unmarshal(result["content"], &parts) != nil {
		return nil, false
	}
	var failed bool
	_ = json.Unmarshal(result["isError"], &failed)
	var calls []ScriptCall
	var ok bool
	if failed {
		calls, ok = r.takeFromError(parts)
	} else {
		calls, ok = r.takeFromValue(parts)
	}
	if !ok {
		return nil, false
	}
	result["content"], _ = json.Marshal(parts)
	if m := meta(calls); m != nil {
		var existing map[string]any
		_ = json.Unmarshal(result["_meta"], &existing)
		if existing == nil {
			existing = map[string]any{}
		}
		for k, v := range m {
			existing[k] = v
		}
		result["_meta"] = marshal(existing)
	}
	rpc["result"] = marshal(result)
	return marshal(rpc), true
}

// takeFromValue puts back the script's own value as the relay gives it: a
// string as it is, anything else as JSON.
func (r *Recording) takeFromValue(parts []content) ([]ScriptCall, bool) {
	if len(parts) == 0 {
		return nil, false
	}
	var text string
	var record map[string]json.RawMessage
	if json.Unmarshal(parts[0]["text"], &text) != nil || json.Unmarshal([]byte(text), &record) != nil || len(record) != 2 {
		return nil, false
	}
	value, ok := record["value"]
	var calls []ScriptCall
	if !ok || json.Unmarshal(record[r.key()], &calls) != nil {
		return nil, false
	}
	var s string
	if value[0] == '"' && json.Unmarshal(value, &s) == nil {
		parts[0]["text"] = marshal(s)
	} else {
		parts[0]["text"] = marshal(string(value))
	}
	return dispatched(calls), true
}

// takeFromError takes the record out of the script's error, when it threw
// one, and settles each call as the relay last saw it (its list of
// dispatched calls, in the same order). A script the relay stopped (past its
// deadline, say) recorded nothing: its calls are the relay's alone.
func (r *Recording) takeFromError(parts []content) ([]ScriptCall, bool) {
	var calls []ScriptCall
	var receipts []struct {
		DeviceID   string `json:"deviceId"`
		InstanceID string `json:"instanceId"`
		Method     string `json:"method"`
		Execution  string `json:"execution"`
		Error      *Fault `json:"error"`
	}
	recorded := false
	for _, part := range parts {
		var text string
		if json.Unmarshal(part["text"], &text) != nil {
			continue
		}
		if at := strings.Index(text, r.marker()); at >= 0 {
			rest := text[at+len(r.marker()):]
			end := strings.Index(rest, "\n")
			if end < 0 {
				end = len(rest)
			}
			if json.Unmarshal([]byte(rest[:end]), &calls) == nil {
				recorded = true
			}
			part["text"] = marshal(text[:at] + rest[end:])
		} else if strings.HasPrefix(text, "Execution failed (") {
			part["text"] = marshal(firstLine.ReplaceAllStringFunc(text, r.unshift))
		} else if list, ok := strings.CutPrefix(text, "Dispatched calls "); ok {
			if _, list, ok = strings.Cut(list, "\n"); ok {
				_ = json.Unmarshal([]byte(list), &receipts)
			}
		}
	}
	calls = dispatched(calls)
	if !recorded || len(calls) != len(receipts) && len(receipts) > 0 {
		calls = make([]ScriptCall, 0, len(receipts))
		for _, receipt := range receipts {
			calls = append(calls, ScriptCall{DeviceID: receipt.DeviceID, InstanceID: receipt.InstanceID, Method: receipt.Method})
		}
	}
	for i, receipt := range receipts {
		if calls[i].Execution != receipt.Execution {
			calls[i].Execution, calls[i].Error = receipt.Execution, receipt.Error
		}
	}
	return calls, true
}

// firstLine is a place on the script's first line in the relay's errors
// (the prelude puts it on the fourth).
var firstLine = regexp.MustCompile(`eval\.js:4:[0-9]+`)

func (r *Recording) unshift(place string) string {
	column, _ := strconv.Atoi(place[len("eval.js:4:"):])
	if column <= r.shift {
		return place
	}
	return "eval.js:4:" + strconv.Itoa(column-r.shift)
}

// dispatched are the calls that reached the relay.
func dispatched(calls []ScriptCall) []ScriptCall {
	out := calls[:0]
	for _, c := range calls {
		if !c.Refused {
			out = append(out, c)
		}
	}
	return out
}

// marshal is v as JSON, its HTML characters as they are.
func marshal(v any) json.RawMessage {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(v)
	return bytes.TrimRight(buf.Bytes(), "\n")
}
