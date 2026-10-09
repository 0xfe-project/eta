package relay

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
)

// A runtime call is one request to the relay's administrator API, as its
// public origin; the outcome is the body.
func TestCallGoesThroughTheAdministratorAPI(t *testing.T) {
	var got struct {
		auth, host, path string
		body             map[string]any
	}
	answer := `{"execution":"accepted","result":{"ok":true}}`
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got.auth, got.host, got.path = r.Header.Get("Authorization"), r.Host, r.URL.Path
		_ = json.NewDecoder(r.Body).Decode(&got.body)
		_, _ = w.Write([]byte(answer))
	}))
	defer srv.Close()
	c, err := New(srv.URL, "https://relay.example", "admin-secret", "")
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	out, err := c.Call(ctx, "device-1", "paseo", "paseo.agents.get", map[string]any{"agentId": "a"})
	if err != nil || out.Execution != "accepted" || string(out.Result) != `{"ok":true}` {
		t.Fatalf("%+v %v", out, err)
	}
	if got.auth != "Bearer admin-secret" || got.host != "relay.example" || got.path != "/api/admin/call" {
		t.Fatalf("%+v", got)
	}
	if got.body["deviceId"] != "device-1" || got.body["instanceId"] != "paseo" || got.body["method"] != "paseo.agents.get" {
		t.Fatalf("body %v", got.body)
	}

	// A refused call is an error; an unknown outcome is not (it is checked
	// against the native state, never repeated).
	answer = `{"execution":"not_started","error":{"code":"device_offline","message":"offline"}}`
	var fault *Fault
	if _, err := c.Call(ctx, "device-1", "paseo", "paseo.agents.send", nil); !errors.As(err, &fault) || fault.Code != "device_offline" {
		t.Fatalf("refused: %v", err)
	}
	answer = `{"execution":"unknown","error":{"code":"execution_unknown","message":"no confirmation"}}`
	if out, err := c.Call(ctx, "device-1", "paseo", "paseo.agents.send", nil); err != nil || out.Execution != "unknown" {
		t.Fatalf("unknown: %+v %v", out, err)
	}
}
