package api

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
)

// The agenvo plugin's MCP server: the agenvo relay's own MCP tools (search
// and execute), which reach the native methods of the runtimes on the
// user's remote computers. Agents use them as agenvo defines them; this
// only forwards with the control plane's grant, which the agent never
// sees, so nobody configures the relay twice. The runtime gateway
// authenticates the runtime and checks the plugin (apps/gateway/runtime.caddy,
// /agenvo).
//
// What it adds:
//   - only the methods tools need pass: events/* would have the relay post
//     to callback URLs the agent names, and nothing in its container could
//     receive them;
//   - a tool result over agenvoResultLimit is replaced by an error saying so,
//     never cut short: the agent asks again for less.

// agenvoResultLimit is one tool result's limit, the same as one native
// call's frame: what agents read stays in a page they can take in.
const agenvoResultLimit = 64 << 10

var agenvoMethods = map[string]bool{"initialize": true, "ping": true, "tools/list": true, "tools/call": true}

func agenvoMCP(d *Deps) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			w.Header().Set("Allow", http.MethodPost)
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, agenvoResultLimit))
		if err != nil {
			http.Error(w, "request too large", http.StatusRequestEntityTooLarge)
			return
		}
		var msg struct {
			ID     json.RawMessage `json:"id"`
			Method string          `json:"method"`
		}
		if err := json.Unmarshal(body, &msg); err != nil {
			rpcError(w, nil, -32700, "not one JSON-RPC message")
			return
		}
		if !agenvoMethods[msg.Method] && !strings.HasPrefix(msg.Method, "notifications/") {
			rpcError(w, msg.ID, -32601, msg.Method+" is not available through AXP (only the search and execute tools are)")
			return
		}
		if d.Tasks == nil || d.Tasks.Relay == nil {
			rpcError(w, msg.ID, -32603, "remote computers are not set up in AXP (no relay)")
			return
		}
		answer, err := d.Tasks.Relay.MCP(r.Context(), body, r.Header)
		if err != nil {
			slog.WarnContext(r.Context(), "agenvo MCP request failed", "agent", r.Header.Get("X-AXP-Agent-Id"),
				"method", msg.Method, "error", err)
			rpcError(w, msg.ID, -32603, "the relay could not be reached: "+err.Error()+
				". If this was an execute, its writes may or may not have happened: check native state before repeating them")
			return
		}
		data := answer.Body
		if msg.Method == "tools/call" && answer.Status < 300 {
			data = limitResults(answer.Header.Get("Content-Type"), data)
		}
		for _, name := range []string{"Content-Type", "Mcp-Session-Id"} {
			if v := answer.Header.Get(name); v != "" {
				w.Header().Set(name, v)
			}
		}
		w.WriteHeader(answer.Status)
		_, _ = w.Write(data)
	})
}

func rpcError(w http.ResponseWriter, id json.RawMessage, code int, message string) {
	if len(id) == 0 {
		id = json.RawMessage("null")
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"jsonrpc": "2.0", "id": id, "error": map[string]any{"code": code, "message": message},
	})
}

// limitResults applies the limit to a tools/call answer, JSON or events.
func limitResults(contentType string, data []byte) []byte {
	if !strings.Contains(contentType, "text/event-stream") {
		return limitResult(data)
	}
	lines := bytes.Split(data, []byte("\n"))
	for i, line := range lines {
		if rest, ok := bytes.CutPrefix(line, []byte("data:")); ok {
			lines[i] = append([]byte("data: "), limitResult(bytes.TrimSpace(rest))...)
		}
	}
	return bytes.Join(lines, []byte("\n"))
}

// limitResult replaces a tool result whose text is over the limit.
func limitResult(msg []byte) []byte {
	var rpc struct {
		JSONRPC string          `json:"jsonrpc"`
		ID      json.RawMessage `json:"id"`
		Result  *struct {
			IsError bool `json:"isError"`
			Content []struct {
				Text string `json:"text"`
			} `json:"content"`
		} `json:"result"`
	}
	if json.Unmarshal(msg, &rpc) != nil || rpc.Result == nil {
		return msg
	}
	size := 0
	for _, c := range rpc.Result.Content {
		size += len(c.Text)
	}
	if size <= agenvoResultLimit {
		return msg
	}
	text := fmt.Sprintf("result_too_large: AXP did not deliver this result: it is %d bytes, over the %d-byte limit "+
		"for one tool result. Nothing was cut or skipped, and the script did run: any writes it made happened, so check "+
		"native state before repeating them. Return less (fewer fields, a smaller page or limit, IDs instead of "+
		"records) and read the rest with further calls.", size, agenvoResultLimit)
	if rpc.Result.IsError {
		text += " The script itself also failed."
	}
	out, err := json.Marshal(map[string]any{
		"jsonrpc": rpc.JSONRPC, "id": rpc.ID,
		"result": map[string]any{"isError": true, "content": []map[string]string{{"type": "text", "text": text}}},
	})
	if err != nil {
		return msg
	}
	return out
}
