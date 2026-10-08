package relay

import "testing"

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
