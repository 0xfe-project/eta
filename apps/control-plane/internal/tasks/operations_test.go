package tasks

import (
	"encoding/json"
	"reflect"
	"testing"

	"github.com/akarachen/axp/apps/control-plane/internal/relay"
)

// What an execute script's native calls show of the places it made, as
// Paseo and Herdr answer them (Herdr's from herdr 0.8.2 itself).

func call(device, instance, method, execution, params, result string, fault *relay.Fault) relay.ScriptCall {
	c := relay.ScriptCall{DeviceID: device, InstanceID: instance, Method: method, Execution: execution, Error: fault}
	if params != "" {
		c.Params = json.RawMessage(params)
	}
	if result != "" {
		c.Result = json.RawMessage(result)
	}
	return c
}

func TestOperationsFromAScriptsCalls(t *testing.T) {
	devices := map[string]computerRuntime{"dp": {"办公室 Mac", "paseo"}, "dh": {"办公室 Mac", "herdr"}}
	herdrWorktree := `{"result":{"type":"worktree_created","workspace":{"workspace_id":"w3","label":"wt97",` +
		`"worktree":{"checkout_path":"/h/.herdr/worktrees/repo/feat-x","repo_name":"repo","repo_root":"/tmp/repo"}},` +
		`"worktree":{"branch":"feat/x","path":"/h/.herdr/worktrees/repo/feat-x","open_workspace_id":"w3"},` +
		`"root_pane":{"cwd":"/h/.herdr/worktrees/repo/feat-x","pane_id":"w3:p1"}}}`
	calls := []relay.ScriptCall{
		// Read calls are no operations.
		call("dp", "paseo", "paseo.workspaces.list", "accepted", "", "", nil),
		call("dp", "paseo", "paseo.workspaces.create", "accepted",
			`{"source":{"kind":"worktree","projectId":"p1","action":"branch-off","branchName":"feat/x","baseBranch":"main"},"title":"修复登录"}`,
			`{"workspace":{"id":"wks_1","name":"修复登录","projectDisplayName":"axp","projectRootPath":"/home/u/axp",`+
				`"workspaceDirectory":"/home/u/.paseo/worktrees/axp/feat-x","gitRuntime":{"currentBranch":"feat/x"}},"error":null}`, nil),
		// Paseo answers a creation it could not make without the place.
		call("dp", "paseo", "paseo.workspaces.create", "accepted", `{"source":{"kind":"directory","path":"/home/u/new"}}`,
			`{"workspace":null,"error":"Directory does not exist","errorCode":"not_found"}`, nil),
		call("dp", "paseo", "paseo.workspaces.create", "accepted", `{"source":{"kind":"directory","path":"/home/u/p","projectId":"p2"}}`,
			`{"workspace":null,"error":null,"creation":{"phase":"accepted"}}`, nil),
		call("dp", "paseo", "paseo.workspaces.create", "unknown", `{"source":{"kind":"directory","path":"/home/u/slow"}}`, "",
			&relay.Fault{Code: "native_error", Message: "Paseo creation failed: timed out"}),
		// Stopped by the relay: no parameters, settled as it saw.
		call("dp", "paseo", "paseo.workspaces.create", "accepted", "", "", nil),
		call("dh", "herdr", "worktree.create", "accepted", `{"workspaceId":"w2","branch":"feat/x","label":"wt97"}`, herdrWorktree, nil),
		call("dh", "herdr", "worktree.create", "rejected", `{"workspaceId":"w2","branch":"feat/x"}`, "",
			&relay.Fault{Code: "native_error", Message: "herdr failed",
				Native: json.RawMessage(`{"code":"worktree_create_failed","message":"Preparing worktree\nfatal: '/h/feat-x' already exists"}`)}),
		call("dh", "herdr", "workspace.create", "accepted", `{"cwd":"/tmp/repo","label":"proj97"}`,
			`{"result":{"type":"workspace_created","workspace":{"workspace_id":"w2","label":"proj97"},"root_pane":{"cwd":"/tmp/repo"}}}`, nil),
		// Still running when the script returned.
		call("dh", "herdr", "worktree.open", "", `{"workspaceId":"w2","branch":"main"}`, "", nil),
		// Herdr's method names on a runtime that is not Herdr are not its.
		call("dp", "paseo", "workspace.create", "accepted", `{"cwd":"/x"}`, "", nil),
		call("elsewhere", "codex", "worktree.create", "accepted", `{}`, "", nil),
		// A Herdr outside AXP, by its instance.
		call("elsewhere", "herdr", "workspace.create", "rejected", `{"cwd":"/y"}`, "", &relay.Fault{Code: "runtime_unavailable"}),
	}
	want := []Operation{
		{Action: "create_worktree", Status: "completed", Runtime: "paseo", Computer: "办公室 Mac", ID: "wks_1", Name: "修复登录",
			Project: "axp", Path: "/home/u/.paseo/worktrees/axp/feat-x", Branch: "feat/x", Base: "main"},
		{Action: "add_project", Status: "failed", Runtime: "paseo", Computer: "办公室 Mac", Path: "/home/u/new", Error: "Directory does not exist"},
		{Action: "create_workspace", Status: "accepted", Runtime: "paseo", Computer: "办公室 Mac", Path: "/home/u/p"},
		{Action: "add_project", Status: "unknown", Runtime: "paseo", Computer: "办公室 Mac", Path: "/home/u/slow",
			Error: "native_error: Paseo creation failed: timed out"},
		{Action: "create_workspace", Status: "accepted", Runtime: "paseo", Computer: "办公室 Mac"},
		{Action: "create_worktree", Status: "completed", Runtime: "herdr", Computer: "办公室 Mac", ID: "w3", Name: "wt97",
			Project: "repo", Path: "/h/.herdr/worktrees/repo/feat-x", Branch: "feat/x"},
		{Action: "create_worktree", Status: "failed", Runtime: "herdr", Computer: "办公室 Mac", Branch: "feat/x",
			Error: "worktree_create_failed: Preparing worktree · fatal: '/h/feat-x' already exists"},
		{Action: "create_workspace", Status: "completed", Runtime: "herdr", Computer: "办公室 Mac", ID: "w2", Name: "proj97", Path: "/tmp/repo"},
		{Action: "open_worktree", Status: "unknown", Runtime: "herdr", Computer: "办公室 Mac", Branch: "main"},
		{Action: "create_workspace", Status: "failed", Runtime: "herdr", Path: "/y", Error: "runtime_unavailable"},
	}
	got := operations(calls, devices)
	if len(got) != len(want) {
		t.Fatalf("got %d operations: %+v", len(got), got)
	}
	for i := range want {
		if !reflect.DeepEqual(got[i], want[i]) {
			t.Errorf("%d: got %+v\nwant %+v", i, got[i], want[i])
		}
	}
	if ops := operations([]relay.ScriptCall{call("dp", "paseo", "paseo.agents.list", "accepted", "", "", nil)}, devices); len(ops) != 0 {
		t.Fatalf("got %+v", ops)
	}
}
