package tasks

import (
	"encoding/json"
	"reflect"
	"testing"
)

// Paseo timeline items as paseo.agents.history answers them (Paseo 0.10,
// task #111's second run).
func TestPaseoEntries(t *testing.T) {
	hash := "a3e5d677c333b634bfd2bf46ca12f4e7de60708876871800da6a2d43b9cd96d6"
	cases := []struct {
		name, item string
		want       LogEntry
	}{
		{"an image an agent read",
			`{"type":"assistant_message","text":"![Image](file:///tmp/paseo-attachments-fd6BRI/` + hash + `.png)"}`,
			LogEntry{Kind: "image", Text: hash + ".png"}},
		{"a JPEG, by a Windows path",
			`{"type":"assistant_message","text":"![Image](C:\\Temp\\paseo-attachments-x\\` + hash + `.jpg)"}`,
			LogEntry{Kind: "image", Text: hash + ".jpg"}},
		{"an image the agent wrote itself stays a message",
			`{"type":"assistant_message","text":"![shot](https://example.com/a.png)"}`,
			LogEntry{Kind: "assistant", Text: "![shot](https://example.com/a.png)"}},
		{"an image among words stays a message",
			`{"type":"assistant_message","text":"see ![Image](file:///tmp/paseo-attachments-a/` + hash + `.png)"}`,
			LogEntry{Kind: "assistant", Text: "see ![Image](file:///tmp/paseo-attachments-a/" + hash + ".png)"}},
		{"a command's output",
			`{"type":"tool_call","name":"Bash","status":"completed","detail":{"type":"shell","command":"ls","output":"a\nb"}}`,
			LogEntry{Kind: "tool", Tool: "Bash", Command: "ls", Status: "completed", Text: "a\nb"}},
		{"a tool Paseo does not know, with an object for output",
			`{"type":"tool_call","name":"mcp","status":"completed","detail":{"type":"unknown","input":{},"output":{"ok":true}}}`,
			LogEntry{Kind: "tool", Tool: "mcp", Status: "completed", Text: `{"ok":true}`}},
		{"a read, without output",
			`{"type":"tool_call","name":"Read","status":"completed","detail":{"type":"read","filePath":"/a"}}`,
			LogEntry{Kind: "tool", Tool: "Read", Status: "completed"}},
	}
	for _, c := range cases {
		var e paseoEntry
		if err := json.Unmarshal([]byte(`{"item":`+c.item+`}`), &e); err != nil {
			t.Fatalf("%s: %v", c.name, err)
		}
		if got := e.entry(); !reflect.DeepEqual(got, c.want) {
			t.Errorf("%s: got %+v, want %+v", c.name, got, c.want)
		}
	}
}
