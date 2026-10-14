package relay

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestToolOutcomeReadsJSONAndEvents(t *testing.T) {
	text := `{\"execution\":\"unknown\",\"error\":{\"code\":\"timeout\",\"message\":\"no answer\"}}`
	body := `{"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"` + text + `"}]}}`
	for _, c := range []struct{ contentType, data string }{
		{"application/json", body},
		{"text/event-stream", "event: message\ndata: " + body + "\n\n"},
	} {
		out, err := toolOutcome(c.contentType, []byte(c.data))
		if err != nil {
			t.Fatal(err)
		}
		if out.Execution != "unknown" || out.Error == nil || out.Error.Code != "timeout" {
			t.Fatalf("%s: %+v", c.contentType, out)
		}
	}
	if _, err := toolOutcome("application/json", []byte(`{"error":{"message":"nope"}}`)); err == nil {
		t.Fatal("an MCP error is not an outcome")
	}
}

// A script that fails leaves its call's fate unknown.
func TestToolOutcomeOfAFailedScriptIsUnknown(t *testing.T) {
	body := `{"jsonrpc":"2.0","id":1,"result":{"isError":true,"content":[{"type":"text","text":"Execution failed (script_timeout): late"}]}}`
	out, err := toolOutcome("application/json", []byte(body))
	if err != nil {
		t.Fatal(err)
	}
	if out.Execution != "unknown" || out.Error == nil || out.Error.Code != "script_error" {
		t.Fatalf("%+v", out)
	}
}

func TestVersionIsTheRelaysHealthVersion(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/remote/relay/health" || r.Host != "axp.test" {
			http.NotFound(w, r)
			return
		}
		_, _ = w.Write([]byte(`{"service":"agenvo","version":"0.2.0"}`))
	}))
	defer srv.Close()
	c, err := New(srv.URL, "https://axp.test/remote/relay", "secret", nil)
	if err != nil {
		t.Fatal(err)
	}
	if v, err := c.Version(context.Background()); err != nil || v != "0.2.0" {
		t.Fatalf("version %q, %v", v, err)
	}
}
