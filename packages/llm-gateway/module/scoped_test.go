package module

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"

	"github.com/0xfe-project/eta/packages/llm-gateway/gateway"
	"github.com/0xfe-project/eta/packages/llm-gateway/gateway/cpa"
)

// send makes one request with exactly this Authorization header (the shared
// client would add the host key to a request that has none).
func send(t *testing.T, method, rawURL, auth, body string) (int, string) {
	t.Helper()
	req, _ := http.NewRequest(method, rawURL, strings.NewReader(body))
	if auth != "" {
		req.Header.Set("Authorization", auth)
	}
	req.Header.Set("Content-Type", "application/json")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(res.Body)
	return res.StatusCode, string(raw)
}

// TestScopedKeys: a key derived from the host's for one scope opens /v1 and
// nothing else, a forged or altered one does not, and revoking the scope ends
// it while other scopes go on.
func TestScopedKeys(t *testing.T) {
	f := shared
	good := cpa.ScopedKey(testKey, "agent-1")
	other := cpa.ScopedKey(testKey, "agent-2")
	if good == "" || good == other || strings.Contains(good, testKey) {
		t.Fatalf("keys: %q %q", good, other)
	}
	if cpa.ScopedKey(testKey, "bad.scope") != "" || cpa.ScopedKey(testKey, "") != "" {
		t.Fatal("a scope that is not a plain id got a key")
	}
	models := f.srv.URL + "/v1/models"
	for name, auth := range map[string]string{
		"missing":       "",
		"wrong":         "Bearer wrong-key-wrong-key-0123",
		"other host":    "Bearer " + cpa.ScopedKey("another-host-key-0123456789", "agent-1"),
		"altered scope": "Bearer " + strings.Replace(good, "agent-1", "agent-3", 1),
		"altered mac":   "Bearer " + good[:len(good)-1] + "0",
		"prefix only":   "Bearer etak.agent-1.",
		"not a bearer":  good,
		"scope as key":  "Bearer agent-1",
	} {
		if status, _ := send(t, http.MethodGet, models, auth, ""); status != http.StatusUnauthorized {
			t.Errorf("%s: /v1/models = %d, want 401", name, status)
		}
	}
	if status, _ := send(t, http.MethodGet, models, "Bearer "+good, ""); status != http.StatusOK {
		t.Fatalf("scoped key on /v1/models = %d", status)
	}
	// The account API and revocation are the host's alone.
	for _, path := range []string{"/api/llm/v1/models", "/api/llm/ready"} {
		if status, _ := send(t, http.MethodGet, f.srv.URL+path, "Bearer "+good, ""); status != http.StatusUnauthorized {
			t.Errorf("scoped key on %s = %d, want 401", path, status)
		}
	}
	if status, _ := send(t, http.MethodDelete, f.srv.URL+"/api/llm/v1/keys/agent-2", "Bearer "+good, ""); status != http.StatusUnauthorized {
		t.Fatalf("a scoped key revoked a scope: %d", status)
	}
	if status, _ := send(t, http.MethodGet, models, "Bearer "+other, ""); status != http.StatusOK {
		t.Fatalf("other scope before revoke = %d", status)
	}

	if status, _ := send(t, http.MethodDelete, f.srv.URL+"/api/llm/v1/keys/agent-1", "Bearer "+testKey, ""); status != http.StatusNoContent {
		t.Fatalf("revoke = %d", status)
	}
	if status, _ := send(t, http.MethodGet, models, "Bearer "+good, ""); status != http.StatusUnauthorized {
		t.Fatalf("revoked key = %d, want 401", status)
	}
	if status, _ := send(t, http.MethodGet, models, "Bearer "+other, ""); status != http.StatusOK {
		t.Fatalf("other scope after revoke = %d", status)
	}
	if status, _ := send(t, http.MethodGet, models, "Bearer "+testKey, ""); status != http.StatusOK {
		t.Fatalf("host key after revoke = %d", status)
	}
}

// TestGrokAPIThroughGateway: what grok-api calls (images and edits, videos
// and their polling, web and X search through /responses) is served by /v1
// from the xAI account with an agent's scoped key, and the upstream sees the
// account's token, never the agent's key.
func TestGrokAPIThroughGateway(t *testing.T) {
	f := shared
	var mu sync.Mutex
	seen := map[string]string{}
	fake := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		mu.Lock()
		seen[r.Method+" "+r.URL.Path] = r.Header.Get("Authorization")
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		switch {
		case strings.HasPrefix(r.URL.Path, "/images/"):
			_, _ = w.Write([]byte(`{"data":[{"url":"https://example.test/a.jpg"}]}`))
		case r.URL.Path == "/videos/generations":
			_, _ = w.Write([]byte(`{"request_id":"vid-1"}`))
		case r.URL.Path == "/videos/vid-1":
			_, _ = w.Write([]byte(`{"status":"done","video":{"url":"https://example.test/v.mp4"}}`))
		case r.URL.Path == "/responses":
			// CPA asks xAI for a stream whatever the client asked for.
			w.Header().Set("Content-Type", "text/event-stream")
			done := `{"type":"message","id":"m1","role":"assistant","status":"completed","content":[{"type":"output_text","text":"found it","annotations":[]}]}`
			for _, event := range []string{
				`{"type":"response.created","response":{"id":"resp_1","object":"response","status":"in_progress","model":"grok-4.6","output":[]}}`,
				`{"type":"response.output_item.done","output_index":0,"item":` + done + `}`,
				`{"type":"response.completed","response":{"id":"resp_1","object":"response","status":"completed","model":"grok-4.6","output":[` + done + `],"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}`,
			} {
				var kind struct{ Type string }
				_ = json.Unmarshal([]byte(event), &kind)
				_, _ = fmt.Fprintf(w, "event: %s\ndata: %s\n\n", kind.Type, event)
			}
		default:
			t.Logf("fake xAI: unexpected %s %s %s", r.Method, r.URL.Path, body)
			http.NotFound(w, r)
		}
	}))
	defer fake.Close()

	credential := `{"type":"xai","email":"grok@example.com","access_token":"xai-account-token","refresh_token":"r","expired":"2099-01-01T00:00:00Z","base_url":"` + fake.URL + `","auth_kind":"api"}`
	err := gateway.Manage(context.Background(), f.m.proxy.Management(), cpa.ManagementURL("/auth-files?name="+url.QueryEscape("xai-grok.json")), http.MethodPost, []byte(credential), nil)
	if err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool {
		for _, m := range f.m.service.Models() {
			if m.Connector == "xai" && m.Available {
				return true
			}
		}
		return false
	})

	key := "Bearer " + cpa.ScopedKey(testKey, "agent-grok")
	call := func(method, path, body string) string {
		t.Helper()
		status, got := send(t, method, f.srv.URL+path, key, body)
		if status != http.StatusOK {
			t.Fatalf("%s %s = %d %s", method, path, status, got)
		}
		return got
	}
	if got := call("POST", "/v1/images/generations", `{"model":"grok-imagine-image-2.0","prompt":"a rover"}`); !strings.Contains(got, "a.jpg") {
		t.Fatalf("image: %s", got)
	}
	if got := call("POST", "/v1/images/edits", `{"model":"grok-imagine-image-2.0","prompt":"darker","image":{"url":"https://example.test/a.jpg","type":"image_url"}}`); !strings.Contains(got, "a.jpg") {
		t.Fatalf("image edit: %s", got)
	}
	if got := call("POST", "/v1/videos/generations", `{"model":"grok-imagine-video-1.5","prompt":"a rover"}`); !strings.Contains(got, "vid-1") {
		t.Fatalf("video: %s", got)
	}
	if got := call("GET", "/v1/videos/vid-1", ""); !strings.Contains(got, "v.mp4") {
		t.Fatalf("video poll: %s", got)
	}
	if got := call("POST", "/v1/responses", `{"model":"grok-4.6","input":"news?","tools":[{"type":"web_search"}]}`); !strings.Contains(got, "found it") {
		t.Fatalf("search: %s", got)
	}

	mu.Lock()
	defer mu.Unlock()
	for _, route := range []string{"POST /images/generations", "POST /images/edits", "POST /videos/generations", "GET /videos/vid-1", "POST /responses"} {
		if seen[route] != "Bearer xai-account-token" {
			t.Errorf("upstream %s saw %q, want the account's token", route, seen[route])
		}
	}
}
