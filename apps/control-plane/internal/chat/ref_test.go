package chat

import (
	"encoding/json"
	"reflect"
	"testing"
)

func TestActivityRefKeepsOnlyWholeRefs(t *testing.T) {
	cases := []struct {
		name string
		raw  any
		want ActivityRef
	}{
		{"task", map[string]any{"kind": "task", "id": "t1", "number": 12.0, "title": "Ship", "status": "todo"},
			ActivityRef{Kind: "task", ID: "t1", Number: 12, Title: "Ship", Status: "todo"}},
		{"routine", map[string]any{"kind": "routine", "id": "r1", "title": "Daily"},
			ActivityRef{Kind: "routine", ID: "r1", Title: "Daily"}},
		{"pull request", map[string]any{"kind": "pull_request", "number": 3.0, "title": "Fix", "url": "https://github.com/o/r/pull/3"},
			ActivityRef{Kind: "pull_request", Number: 3, Title: "Fix", URL: "https://github.com/o/r/pull/3"}},
		{"none", nil, ActivityRef{}},
		{"unknown kind", map[string]any{"kind": "memory", "id": "m1"}, ActivityRef{}},
		{"task without id", map[string]any{"kind": "task", "number": 12.0}, ActivityRef{}},
		{"unsafe url", map[string]any{"kind": "pull_request", "number": 3.0, "url": "javascript:alert(1)"}, ActivityRef{}},
		{"pull request elsewhere", map[string]any{"kind": "pull_request", "number": 3.0, "url": "https://evil.example/o/r/pull/3"}, ActivityRef{}},
		{"not a pull request page", map[string]any{"kind": "pull_request", "number": 3.0, "url": "https://github.com/o/r/issues/3"}, ActivityRef{}},
		{"issue draft", map[string]any{"kind": "issue_draft", "title": "Bug", "number": 9.0, "id": "x",
			"url": "https://github.com/o/r/issues/new?title=Bug"},
			ActivityRef{Kind: "issue_draft", Title: "Bug", URL: "https://github.com/o/r/issues/new?title=Bug"}},
		{"issue draft with its body", map[string]any{"kind": "issue_draft", "title": "Bug", "body": "长正文",
			"url": "https://github.com/o/r/issues/new?title=Bug"},
			ActivityRef{Kind: "issue_draft", Title: "Bug", Body: "长正文", URL: "https://github.com/o/r/issues/new?title=Bug"}},
		{"issue draft elsewhere", map[string]any{"kind": "issue_draft", "title": "Bug", "url": "https://github.com.evil.example/o/r/issues/new"}, ActivityRef{}},
		{"issue draft as someone", map[string]any{"kind": "issue_draft", "title": "Bug", "url": "https://u:p@github.com/o/r/issues/new"}, ActivityRef{}},
		{"issue draft without title", map[string]any{"kind": "issue_draft", "url": "https://github.com/o/r/issues/new"}, ActivityRef{}},
		{"artifact", map[string]any{"kind": "artifact", "id": "0b7e2b1c-58f8-4a3c-9d3c-1f0e2a9b6c11", "number": 2.0, "title": "报告"},
			ActivityRef{Kind: "artifact", ID: "0b7e2b1c-58f8-4a3c-9d3c-1f0e2a9b6c11", Number: 2, Title: "报告"}},
		{"artifact without version", map[string]any{"kind": "artifact", "id": "0b7e2b1c-58f8-4a3c-9d3c-1f0e2a9b6c11"}, ActivityRef{}},
		{"artifact with a bad id", map[string]any{"kind": "artifact", "id": "../x", "number": 1.0}, ActivityRef{}},
		{"fractional number", map[string]any{"kind": "task", "id": "t1", "number": 1.5}, ActivityRef{Kind: "task", ID: "t1"}},
	}
	for _, c := range cases {
		if got := activityRef(c.raw); got != c.want {
			t.Errorf("%s: got %+v, want %+v", c.name, got, c.want)
		}
	}
}

func TestActivityBlockRoundTripsItsRef(t *testing.T) {
	block := Block{ID: "a-1", Type: "activity", Label: "调用工具", Status: "completed",
		Ref: ActivityRef{Kind: "task", ID: "t1", Number: 12, Title: "Ship"}}
	data, err := json.Marshal(block)
	if err != nil {
		t.Fatal(err)
	}
	var back Block
	if err := json.Unmarshal(data, &back); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(back, block) {
		t.Fatalf("got %+v, want %+v", back, block)
	}
	// Blocks without one, such as history from before refs, carry none.
	data, _ = json.Marshal(Block{ID: "a-2", Type: "activity", Status: "completed"})
	var raw map[string]any
	_ = json.Unmarshal(data, &raw)
	if _, ok := raw["ref"]; ok {
		t.Fatalf("ref in %s", data)
	}
}

func TestActivityOperationsKeepOnlyWholeOnes(t *testing.T) {
	raw := []any{
		map[string]any{"action": "create_worktree", "status": "completed", "runtime": "paseo", "computer": "办公室 Mac",
			"id": "wks_1", "name": "feat-x", "path": "/repo/.paseo/feat-x", "branch": "feat/x", "base": "main"},
		map[string]any{"action": "add_project", "status": "unknown", "runtime": "paseo", "error": "timeout"},
		map[string]any{"action": "delete_everything", "status": "completed", "runtime": "paseo"},
		map[string]any{"action": "create_workspace", "status": "done", "runtime": "herdr"},
		map[string]any{"action": "create_workspace", "status": "failed", "runtime": "codex"},
		"not an operation",
	}
	want := []ActivityOperation{
		{Action: "create_worktree", Status: "completed", Runtime: "paseo", Computer: "办公室 Mac",
			ID: "wks_1", Name: "feat-x", Path: "/repo/.paseo/feat-x", Branch: "feat/x", Base: "main"},
		{Action: "add_project", Status: "unknown", Runtime: "paseo", Error: "timeout"},
	}
	if got := activityOperations(raw); !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v, want %+v", got, want)
	}
	if got := activityOperations(nil); got != nil {
		t.Fatalf("got %+v from nothing", got)
	}

	// They round-trip, and blocks without any (older history, other tools) carry none.
	block := Block{ID: "a-1", Type: "activity", Label: "调用工具", Status: "failed", Operations: want}
	data, _ := json.Marshal(block)
	var back Block
	if err := json.Unmarshal(data, &back); err != nil || !reflect.DeepEqual(back, block) {
		t.Fatalf("got %+v (%v), want %+v", back, err, block)
	}
	data, _ = json.Marshal(Block{ID: "a-2", Type: "activity", Status: "completed"})
	var fields map[string]any
	_ = json.Unmarshal(data, &fields)
	if _, ok := fields["operations"]; ok {
		t.Fatalf("operations in %s", data)
	}
}
