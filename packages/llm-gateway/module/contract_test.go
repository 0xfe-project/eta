package module

import (
	"bufio"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/0xfe-project/eta/packages/llm-gateway/gateway"
	"github.com/0xfe-project/eta/packages/llm-gateway/gateway/connectors"
	"github.com/0xfe-project/eta/packages/llm-gateway/gateway/cpa"
	"github.com/router-for-me/CLIProxyAPI/v8/sdk/config"
)

func fakeJWT(claims map[string]any) string {
	enc := func(v any) string {
		raw, _ := json.Marshal(v)
		return base64.RawURLEncoding.EncodeToString(raw)
	}
	return enc(map[string]string{"alg": "none"}) + "." + enc(claims) + ".sig"
}

// testKey is the access key the fixture's module is opened with.
const testKey = "test-access-key-0123456789"

// client sends every request with the key, as the host does.
var client = &http.Client{Transport: keyed{http.DefaultTransport}}

type keyed struct{ next http.RoundTripper }

func (k keyed) RoundTrip(r *http.Request) (*http.Response, error) {
	if r.Header.Get("Authorization") == "" {
		r = r.Clone(r.Context())
		r.Header.Set("Authorization", "Bearer "+testKey)
	}
	return k.next.RoundTrip(r)
}

// fixture is a running Module behind its listener. CPA's state is
// process-wide, so the tests share one.
type fixture struct {
	m        *Module
	srv      *httptest.Server
	stateDir string
}

var shared *fixture

func TestMain(m *testing.M) {
	dir, err := os.MkdirTemp("", "llm-module-")
	if err != nil {
		panic(err)
	}
	module, err := Open(Options{StateDir: dir, AccessKey: testKey, Logger: slog.New(slog.NewTextHandler(io.Discard, nil))})
	if err != nil {
		panic(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- module.Run(ctx) }()
	select {
	case <-module.Ready():
	case err := <-done:
		panic(fmt.Sprint("module stopped: ", err))
	case <-time.After(30 * time.Second):
		panic("module never got ready")
	}
	shared = &fixture{m: module, stateDir: dir, srv: httptest.NewServer(module.Handler())}
	code := m.Run()
	shared.srv.Close()
	cancel()
	// Stopping ends Run without an error.
	if err := <-done; err != nil {
		fmt.Fprintln(os.Stderr, "module stopped with", err)
		code = 1
	}
	os.RemoveAll(dir)
	os.Exit(code)
}

// TestCPAContract guards the CPA surface the module depends on: the
// management API accepts a codex credential in CPA's file format, the core
// auth manager lists it, and its models reach the registry, the catalog and
// /v1/models. It must pass on every CPA upgrade.
func TestCPAContract(t *testing.T) {
	f := shared
	ctx := context.Background()
	mgmt := f.m.proxy.Management()
	idToken := fakeJWT(map[string]any{
		"email": "dev@example.com",
		"https://api.openai.com/auth": map[string]string{
			"chatgpt_account_id": "acct-1", "chatgpt_plan_type": "plus",
		},
	})
	cred, name, err := connectors.CodexCredential(idToken, "access", "refresh", 3600, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if err := gateway.Manage(ctx, mgmt, cpa.ManagementURL("/auth-files?name="+url.QueryEscape(name)), http.MethodPost, cred, nil); err != nil {
		t.Fatalf("upload credential: %v", err)
	}
	// It is a file in the state directory, as before the module moved.
	if _, err := os.Stat(f.stateDir + "/auths/" + name); err != nil {
		t.Fatalf("credential file: %v", err)
	}

	var conn gateway.Connection
	waitFor(t, func() bool {
		var conns []gateway.Connection
		getJSON(t, f.srv.URL+"/api/llm/v1/connections", &conns)
		for _, c := range conns {
			if c.Connector == "codex" {
				conn = c
				return true
			}
		}
		return false
	})
	if conn.Label != "dev@example.com" || conn.Plan != "plus" || conn.State != gateway.StateActive {
		t.Fatalf("connection = %+v", conn)
	}

	var models []gateway.Model
	waitFor(t, func() bool {
		getJSON(t, f.srv.URL+"/api/llm/v1/models", &models)
		return len(models) > 0
	})
	for _, m := range models {
		if m.Connector != "codex" || !m.Available {
			t.Fatalf("model = %+v", m)
		}
	}
	// /v1 and the account API serve only the host, which holds the key.
	for _, path := range []string{"/v1/models", "/api/llm/v1/models"} {
		for _, auth := range []string{"", "Bearer wrong-key-wrong-key-0123"} {
			req, _ := http.NewRequest(http.MethodGet, f.srv.URL+path, nil)
			if auth != "" {
				req.Header.Set("Authorization", auth)
			}
			res, err := http.DefaultClient.Do(req)
			if err != nil || res.StatusCode != http.StatusUnauthorized {
				t.Fatalf("GET %s with %q: %v %v", path, auth, res, err)
			}
			res.Body.Close()
		}
	}
	res := v1(t, f, "GET", "/v1/models", "")
	var list struct {
		Data []struct{ ID string } `json:"data"`
	}
	_ = json.NewDecoder(res.Body).Decode(&list)
	if len(list.Data) == 0 {
		t.Fatal("/v1/models is empty after adding a codex credential")
	}

	// Disable, then delete through the browser's API.
	patch, _ := http.NewRequest(http.MethodPatch, f.srv.URL+"/api/llm/v1/connections/"+url.PathEscape(conn.ID), strings.NewReader(`{"enabled":false}`))
	if res, err := client.Do(patch); err != nil || res.StatusCode != http.StatusOK {
		t.Fatalf("disable: %v %v", res, err)
	}
	waitFor(t, func() bool {
		for _, m := range f.m.service.Models() {
			if m.Available {
				return false
			}
		}
		return true
	})
	del, _ := http.NewRequest(http.MethodDelete, f.srv.URL+"/api/llm/v1/connections/"+url.PathEscape(conn.ID), nil)
	if res, err := client.Do(del); err != nil || res.StatusCode != http.StatusNoContent {
		t.Fatalf("delete: %v %v", res, err)
	}
	waitFor(t, func() bool { return len(f.m.service.Connections()) == 0 })
	for _, m := range f.m.service.Models() {
		if m.Available || m.Status != gateway.ModelUnavailable || m.Reason == nil || m.Reason.Code != gateway.CodeNoConnection {
			t.Fatalf("model after delete = %+v", m)
		}
	}
	if _, err := os.Stat(f.stateDir + "/auths/" + name); !os.IsNotExist(err) {
		t.Fatalf("credential file after delete: %v", err)
	}
}

// upstream is a fake Codex backend: what it answers depends on the prompt.
type upstream struct {
	*httptest.Server
	// Requests it got, and streams whose client went away.
	requests, cancelled atomic.Int32
}

func newUpstream(t *testing.T) *upstream {
	u := &upstream{}
	u.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		u.requests.Add(1)
		raw, _ := io.ReadAll(r.Body)
		prompt := string(raw)
		switch {
		case strings.Contains(prompt, "fail-500"):
			http.Error(w, `{"error":{"message":"boom"}}`, http.StatusInternalServerError)
			return
		case strings.Contains(prompt, "fail-429"):
			w.Header().Set("Retry-After", "1")
			http.Error(w, `{"error":{"type":"usage_limit_reached","message":"slow down"}}`, http.StatusTooManyRequests)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		flusher := w.(http.Flusher)
		send := func(event string, data any) {
			raw, _ := json.Marshal(data)
			fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event, raw)
			flusher.Flush()
		}
		resp := map[string]any{"id": "resp_1", "object": "response", "created_at": 1, "status": "in_progress", "model": "gpt-test", "output": []any{}}
		send("response.created", map[string]any{"type": "response.created", "response": resp})
		item := map[string]any{"type": "message", "id": "msg_1", "role": "assistant", "status": "in_progress", "content": []any{}}
		send("response.output_item.added", map[string]any{"type": "response.output_item.added", "output_index": 0, "item": item})
		send("response.content_part.added", map[string]any{"type": "response.content_part.added", "item_id": "msg_1", "output_index": 0, "content_index": 0, "part": map[string]any{"type": "output_text", "text": ""}})
		words := []string{"Hello", " from", " the", " fake"}
		if strings.Contains(prompt, "slow") {
			// Streams until the client goes away.
			for i := 0; ; i++ {
				select {
				case <-r.Context().Done():
					u.cancelled.Add(1)
					return
				case <-time.After(20 * time.Millisecond):
				}
				send("response.output_text.delta", map[string]any{"type": "response.output_text.delta", "item_id": "msg_1", "output_index": 0, "content_index": 0, "delta": fmt.Sprint(" ", i)})
			}
		}
		for _, word := range words {
			send("response.output_text.delta", map[string]any{"type": "response.output_text.delta", "item_id": "msg_1", "output_index": 0, "content_index": 0, "delta": word})
		}
		text := strings.Join(words, "")
		send("response.output_text.done", map[string]any{"type": "response.output_text.done", "item_id": "msg_1", "output_index": 0, "content_index": 0, "text": text})
		done := map[string]any{"type": "message", "id": "msg_1", "role": "assistant", "status": "completed", "content": []any{map[string]any{"type": "output_text", "text": text, "annotations": []any{}}}}
		send("response.output_item.done", map[string]any{"type": "response.output_item.done", "output_index": 0, "item": done})
		resp["status"], resp["output"] = "completed", []any{done}
		resp["usage"] = map[string]any{"input_tokens": 5, "output_tokens": 4, "total_tokens": 9}
		send("response.completed", map[string]any{"type": "response.completed", "response": resp})
	}))
	t.Cleanup(u.Close)
	return u
}

// TestInference sends real requests through the listener to a
// fake upstream: the OpenAI-compatible API streaming and not, a client
// going away mid-stream, and upstream failures, which stay the request's
// and the account's, never the module's.
func TestInference(t *testing.T) {
	f := shared
	ctx := context.Background()
	up := newUpstream(t)
	// A Codex API key whose base URL is the fake upstream, through CPA's
	// management API (the generated config is rewritten on every start).
	body, _ := json.Marshal([]map[string]any{{
		"api-key": "test-key", "base-url": up.URL,
		"models": []map[string]string{{"name": "gpt-test", "alias": "gpt-test"}},
	}})
	if err := gateway.Manage(ctx, f.m.proxy.Management(), cpa.ManagementURL("/codex-api-key"), http.MethodPut, body, nil); err != nil {
		t.Fatalf("add API key: %v", err)
	}
	waitFor(t, func() bool {
		res := v1(t, f, "GET", "/v1/models", "")
		raw, _ := io.ReadAll(res.Body)
		return strings.Contains(string(raw), "gpt-test")
	})

	t.Run("non-streaming chat completion", func(t *testing.T) {
		res := v1(t, f, "POST", "/v1/chat/completions",
			`{"model":"gpt-test","messages":[{"role":"user","content":"hi"}]}`)
		raw, _ := io.ReadAll(res.Body)
		if res.StatusCode != http.StatusOK || !strings.Contains(string(raw), "Hello from the fake") {
			t.Fatalf("%d %s", res.StatusCode, raw)
		}
	})

	t.Run("streaming responses", func(t *testing.T) {
		res := v1(t, f, "POST", "/v1/responses",
			`{"model":"gpt-test","stream":true,"input":[{"role":"user","content":[{"type":"input_text","text":"hi"}]}]}`)
		if res.StatusCode != http.StatusOK || !strings.HasPrefix(res.Header.Get("Content-Type"), "text/event-stream") {
			raw, _ := io.ReadAll(res.Body)
			t.Fatalf("%d %s %s", res.StatusCode, res.Header.Get("Content-Type"), raw)
		}
		var deltas, completed int
		scanner := bufio.NewScanner(res.Body)
		for scanner.Scan() {
			line := scanner.Text()
			if strings.Contains(line, `"response.output_text.delta"`) {
				deltas++
			}
			if strings.Contains(line, `"response.completed"`) {
				completed++
			}
		}
		if deltas < 4 || completed != 1 {
			t.Fatalf("deltas %d, completed %d", deltas, completed)
		}
	})

	t.Run("client going away cancels the upstream", func(t *testing.T) {
		before := up.cancelled.Load()
		reqCtx, cancel := context.WithCancel(ctx)
		req, _ := http.NewRequestWithContext(reqCtx, "POST", f.srv.URL+"/v1/responses",
			strings.NewReader(`{"model":"gpt-test","stream":true,"input":[{"role":"user","content":[{"type":"input_text","text":"slow"}]}]}`))
		req.Header.Set("Authorization", "Bearer "+testKey)
		req.Header.Set("Content-Type", "application/json")
		res, err := client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		// Read a few deltas as they come (the stream is not buffered),
		// then hang up.
		reader := bufio.NewReader(res.Body)
		start := time.Now()
		for deltas := 0; deltas < 3; {
			line, err := reader.ReadString('\n')
			if err != nil {
				t.Fatalf("stream ended: %v", err)
			}
			if strings.Contains(line, "output_text.delta") {
				deltas++
			}
		}
		if time.Since(start) > 5*time.Second {
			t.Fatalf("deltas took %s: buffered?", time.Since(start))
		}
		cancel()
		res.Body.Close()
		waitFor(t, func() bool { return up.cancelled.Load() > before })
	})

	t.Run("upstream failures stay the request's", func(t *testing.T) {
		for _, prompt := range []string{"fail-500", "fail-429"} {
			res := v1(t, f, "POST", "/v1/chat/completions",
				`{"model":"gpt-test","messages":[{"role":"user","content":"`+prompt+`"}]}`)
			raw, _ := io.ReadAll(res.Body)
			if res.StatusCode < 400 {
				t.Fatalf("%s: %d %s", prompt, res.StatusCode, raw)
			}
			t.Logf("%s → %d %s", prompt, res.StatusCode, strings.TrimSpace(string(raw)))
		}
		// The module keeps serving: its catalog and the browser's API answer.
		if len(f.m.service.Models()) == 0 {
			t.Fatal("catalog empty after upstream failures")
		}
		var conns []gateway.Connection
		getJSON(t, f.srv.URL+"/api/llm/v1/connections", &conns)
	})
}

func v1(t *testing.T, f *fixture, method, path, body string) *http.Response {
	t.Helper()
	req, _ := http.NewRequest(method, f.srv.URL+path, strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+testKey)
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	res, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { res.Body.Close() })
	return res
}

func getJSON(t *testing.T, url string, out any) {
	t.Helper()
	res, err := client.Get(url)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("GET %s: %d", url, res.StatusCode)
	}
	if err := json.NewDecoder(res.Body).Decode(out); err != nil {
		t.Fatal(err)
	}
}

func waitFor(t *testing.T, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatal("condition not met in time")
		}
		time.Sleep(50 * time.Millisecond)
	}
}

// TestGeminiAPIKey adds a Google AI Studio key through the browser's API:
// it is checked with Google (a fake here) and kept in providers.json, its
// models reach the catalog, it is disabled, found invalid and removed like
// any account, and the config generated on the next start still has it.
func TestGeminiAPIKey(t *testing.T) {
	f := shared
	ctx := context.Background()
	const key = "AIza-test-key-1234"
	var accepted atomic.Bool
	accepted.Store(true)
	google := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1beta/models" || r.Header.Get("x-goog-api-key") != key || !accepted.Load() {
			http.Error(w, `{"error":{"code":400,"status":"INVALID_ARGUMENT","details":[{"reason":"API_KEY_INVALID"}]}}`, http.StatusBadRequest)
			return
		}
		_, _ = w.Write([]byte(`{"models":[{"name":"models/gemini-2.5-flash"}]}`))
	}))
	defer google.Close()
	f.m.gemini.API = google.URL

	submit := func(apiKey string) (int, string) {
		var sess gateway.LoginSession
		postJSON(t, f.srv.URL+"/api/llm/v1/logins", `{"connector":"gemini"}`, http.StatusCreated, &sess)
		body, _ := json.Marshal(map[string]string{"api_key": apiKey})
		res, err := client.Post(f.srv.URL+"/api/llm/v1/logins/"+sess.ID+"/input", "application/json", strings.NewReader(string(body)))
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		raw, _ := io.ReadAll(res.Body)
		return res.StatusCode, string(raw)
	}
	if status, body := submit("AIza-wrong-key"); status != http.StatusFailedDependency || !strings.Contains(body, "invalid_api_key") {
		t.Fatalf("wrong key: %d %s", status, body)
	}
	if status, body := submit("  "); status != http.StatusFailedDependency || !strings.Contains(body, `"api_key_required"`) {
		t.Fatalf("empty key: %d %s", status, body)
	}
	if status, body := submit(key); status != http.StatusOK || !strings.Contains(body, `"succeeded"`) {
		t.Fatalf("key: %d %s", status, body)
	}
	if status, body := submit(key); status != http.StatusFailedDependency || !strings.Contains(body, "duplicate_api_key") {
		t.Fatalf("same key again: %d %s", status, body)
	}
	providers := f.stateDir + "/providers.json"
	if info, err := os.Stat(providers); err != nil ||
		(runtime.GOOS != "windows" && info.Mode().Perm() != 0o600) {
		t.Fatalf("providers.json: %v %v", info, err)
	}

	gemini := func() (gateway.Connection, bool) {
		for _, c := range f.m.service.Connections() {
			if c.Connector == "gemini" {
				return c, true
			}
		}
		return gateway.Connection{}, false
	}
	geminiModels := func(available bool) bool {
		n := 0
		for _, m := range f.m.service.Models() {
			if m.Connector == "gemini" {
				if m.Available != available {
					return false
				}
				n++
			}
		}
		return n > 0
	}
	var conn gateway.Connection
	waitFor(t, func() bool {
		var ok bool
		conn, ok = gemini()
		return ok && geminiModels(true)
	})
	if conn.Label != "…1234" || conn.State != gateway.StateActive {
		t.Fatalf("connection = %+v", conn)
	}
	setEnabled := func(enabled bool) {
		t.Helper()
		patch, _ := http.NewRequest(http.MethodPatch, f.srv.URL+"/api/llm/v1/connections/"+url.PathEscape(conn.ID), strings.NewReader(fmt.Sprintf(`{"enabled":%t}`, enabled)))
		if res, err := client.Do(patch); err != nil || res.StatusCode != http.StatusOK {
			t.Fatalf("enabled=%t: %v %v", enabled, res, err)
		}
	}

	// Disabled: it stays, serving nothing, also after a restart.
	setEnabled(false)
	waitFor(t, func() bool {
		c, ok := gemini()
		return ok && c.State == gateway.StateDisabled && geminiModels(false)
	})
	restarted := t.TempDir()
	raw, _ := os.ReadFile(providers)
	if err := os.WriteFile(restarted+"/providers.json", raw, 0o600); err != nil {
		t.Fatal(err)
	}
	cfgPath, err := cpa.WriteConfig(restarted, "secret", nil)
	if err != nil {
		t.Fatal(err)
	}
	cfg, err := config.LoadConfig(cfgPath)
	if err != nil || len(cfg.GeminiKey) != 1 || cfg.GeminiKey[0].APIKey != key ||
		len(cfg.GeminiKey[0].ExcludedModels) != 1 || cfg.GeminiKey[0].ExcludedModels[0] != "*" {
		t.Fatalf("config after a restart: %+v %v", cfg, err)
	}

	setEnabled(true)
	waitFor(t, func() bool {
		c, ok := gemini()
		if ok {
			conn = c
		}
		return ok && c.State == gateway.StateActive && geminiModels(true)
	})

	// A key Google stops accepting needs the user, once checked.
	accepted.Store(false)
	var status gateway.Status
	postJSON(t, f.srv.URL+"/api/llm/v1/refresh", `{}`, http.StatusOK, &status)
	conn, _ = gemini()
	if conn.State != gateway.StateNeedsLogin || conn.Error == nil || conn.Error.Code != gateway.CodeInvalidAPIKey {
		t.Fatalf("connection with a rejected key = %+v %+v", conn, conn.Error)
	}
	accepted.Store(true)

	del, _ := http.NewRequest(http.MethodDelete, f.srv.URL+"/api/llm/v1/connections/"+url.PathEscape(conn.ID), nil)
	if res, err := client.Do(del); err != nil || res.StatusCode != http.StatusNoContent {
		t.Fatalf("delete: %v %v", res, err)
	}
	waitFor(t, func() bool { _, ok := gemini(); return !ok && geminiModels(false) })
	if raw, _ := os.ReadFile(providers); strings.Contains(string(raw), key) {
		t.Fatalf("providers.json after delete: %s", raw)
	}
	var listed map[string][]any
	if err := gateway.Manage(ctx, f.m.proxy.Management(), cpa.ManagementURL("/gemini-api-key"), http.MethodGet, nil, &listed); err != nil || len(listed["gemini-api-key"]) != 0 {
		t.Fatalf("CPA's keys after delete: %v %v", listed, err)
	}
}

func postJSON(t *testing.T, url, body string, want int, out any) {
	t.Helper()
	res, err := client.Post(url, "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != want {
		raw, _ := io.ReadAll(res.Body)
		t.Fatalf("POST %s: %d %s", url, res.StatusCode, raw)
	}
	if err := json.NewDecoder(res.Body).Decode(out); err != nil {
		t.Fatal(err)
	}
}
