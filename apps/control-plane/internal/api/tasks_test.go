package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/akarachen/axp/apps/control-plane/internal/relay"
	"github.com/akarachen/axp/apps/control-plane/internal/tasks"
	"github.com/google/uuid"
)

// fakeRelay is the agenvo relay with Paseo and Herdr connectors whose
// native state the test controls.
type fakeRelay struct {
	mu       sync.Mutex
	pairings []relay.Pairing
	devices  map[string]bool // approved device -> online
	// Paseo
	workspaces map[string]*fakeWorkspace
	agents     map[string]*fakeAgent
	// Herdr
	tabs        map[string]*fakeTab
	herdrAgents map[string]*fakeHerdrAgent
	dirty       map[string]bool // Herdr worktree workspace -> uncommitted changes
	// A connector before agenvo 0.2, whose sessions carry a generation.
	oldHerdr bool
	// Connector versions by device; the version AXP serves otherwise.
	versions map[string]string
	// Every runtime call, as "method".
	calls []string
	// The refs in Paseo projects' repositories, when set: a base branch not
	// among them fails workspace creation as Paseo does (unknown, with the
	// reason). Every create's source.
	refs    map[string]bool
	sources []map[string]any
	// When set, every runtime call fails with this relay error code.
	failing string
	// When set, listing Paseo subagents fails with this relay error code.
	subagentsFailing string
	// Every agent's Paseo timeline, oldest first (two entries by default),
	// in epoch "e1" unless set.
	history      []map[string]any
	historyEpoch string
	// History reads asked for, as their "limit".
	historyReads []int
	// Called with each runtime call's method before it is answered.
	before func(method string)
	// Answers the agenvo plugin's MCP requests.
	mcp func(body []byte, header http.Header) (*relay.Answer, error)
}

// readHistory answers like Paseo, reading entries that start before a cursor,
// and like the connector, refusing answers over 62 KiB.
func (f *fakeRelay) readHistory(p map[string]any) (*relay.Outcome, error) {
	epoch := f.historyEpoch
	if epoch == "" {
		epoch = "e1"
	}
	history := f.history
	if history == nil {
		history = []map[string]any{
			{"timestamp": "2026-10-08T12:00:00Z", "item": map[string]any{"type": "assistant_message", "text": "done"}},
			{"timestamp": "2026-10-08T12:00:01Z", "item": map[string]any{"type": "tool_call", "name": "Bash", "status": "completed",
				"detail": map[string]any{"command": "ls", "output": "hello.txt"}}},
		}
	}
	limit := p["limit"].(int)
	f.historyReads = append(f.historyReads, limit)
	end, stale := len(history)+1, false
	if p["cursor"] != nil {
		var c struct {
			Epoch string
			Seq   int
		}
		data, _ := json.Marshal(p["cursor"])
		_ = json.Unmarshal(data, &c)
		if c.Epoch != epoch {
			stale = true
		} else {
			end = c.Seq
		}
	}
	// Entry i (0-based) starts at seq i+1.
	var entries []map[string]any
	start := max(0, min(end-1, len(history))-limit)
	for i := start; i < min(end-1, len(history)); i++ {
		entries = append(entries, history[i])
	}
	out := map[string]any{"entries": entries, "epoch": epoch, "staleCursor": stale, "reset": stale, "hasOlder": start > 0}
	if len(entries) > 0 {
		out["startCursor"] = map[string]any{"epoch": epoch, "seq": start + 1}
	}
	data, _ := json.Marshal(out)
	if len(data) >= 62*1024 {
		fault := &relay.Fault{Code: "result_too_large", Message: "Native result exceeds 64 KiB."}
		return &relay.Outcome{Execution: "accepted", Error: fault}, fault
	}
	return &relay.Outcome{Execution: "accepted", Result: data}, nil
}

type fakeWorkspace struct {
	id, name, dir, project string
	worktree, archived     bool
}

type fakeAgent struct {
	cwd, workspace string
	status         string // idle or running
	inputs         []string
	lastSent       time.Time
	finished       time.Time
	archived       bool
	// Its provider subagents as Paseo lists them: id, parentSubagentId and
	// status.
	subagents []map[string]any
}

type fakeTab struct {
	workspace string
	env       map[string]any
	closed    bool
}

type fakeHerdrAgent struct {
	pane      string
	status    string // blocked (trust question), idle, working
	launching bool
	args      []string
	inputs    []string
	keys      [][]string
}

func newFakeRelay() *fakeRelay {
	return &fakeRelay{
		devices: map[string]bool{}, workspaces: map[string]*fakeWorkspace{
			"wks_main": {id: "wks_main", name: "web", dir: "/home/u/web", project: "prj_web"},
		},
		agents: map[string]*fakeAgent{}, tabs: map[string]*fakeTab{}, herdrAgents: map[string]*fakeHerdrAgent{},
		dirty: map[string]bool{},
	}
}

func (f *fakeRelay) BaseURL() string { return "https://axp.test/remote/relay" }

func (f *fakeRelay) Version(context.Context) (string, error) { return servedVersion, nil }

func (f *fakeRelay) pair(label string) { f.pairAs(label, "code-"+label, "fp-"+label) }

// pairAs is a device asking to pair under label, with its code and digest.
func (f *fakeRelay) pairAs(label, code, digest string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.pairings = append(f.pairings, relay.Pairing{Code: code, Digest: digest, Label: label})
}

func (f *fakeRelay) State(context.Context) (*relay.State, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	s := &relay.State{Pairings: slices.Clone(f.pairings)}
	for device, online := range f.devices {
		kind := device[strings.LastIndex(device, ":")+1:]
		version, ok := f.versions[device]
		if !ok {
			version = servedVersion
		}
		s.Devices = append(s.Devices, relay.Device{ID: device, Online: online, Instances: []relay.Instance{
			{InstanceID: kind, Kind: kind, Available: true, Approved: true, ConnectorVersion: version},
		}})
	}
	return s, nil
}

func (f *fakeRelay) ApprovePairing(_ context.Context, code, digest string) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for i, p := range f.pairings {
		if p.Code == code && p.Digest == digest {
			f.pairings = slices.Delete(f.pairings, i, i+1)
			device := "device-" + strings.TrimPrefix(p.Label, "axp:")
			f.devices[device] = true
			return device, nil
		}
	}
	return "", &relay.Fault{Code: "not_found"}
}

func (f *fakeRelay) ApproveInstance(context.Context, string, string, string) error { return nil }
func (f *fakeRelay) RevokeDevice(context.Context, string) error                    { return nil }

func (f *fakeRelay) MCP(_ context.Context, body []byte, header http.Header) (*relay.Answer, error) {
	return f.mcp(body, header)
}

func (f *fakeRelay) Call(_ context.Context, _, _, method string, params any) (*relay.Outcome, error) {
	if f.before != nil {
		f.before(method)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, method)
	if f.failing != "" {
		fault := &relay.Fault{Code: f.failing, Message: f.failing}
		return &relay.Outcome{Execution: "not_started", Error: fault}, fault
	}
	p := params.(map[string]any)
	result := func(v any) (*relay.Outcome, error) {
		data, _ := json.Marshal(v)
		return &relay.Outcome{Execution: "accepted", Result: data}, nil
	}
	str := func(k string) string { s, _ := p[k].(string); return s }
	switch method {
	// --- Paseo
	case "paseo.workspaces.list":
		entries := []map[string]any{}
		for _, w := range f.workspaces {
			if w.archived {
				continue
			}
			kind := "local_checkout"
			if w.worktree {
				kind = "worktree"
			}
			entries = append(entries, map[string]any{
				"id": w.id, "name": w.name, "projectId": w.project, "projectDisplayName": "web", "projectRootPath": "/home/u/web",
				"projectKind": "git", "workspaceDirectory": w.dir, "workspaceKind": kind,
				"gitRuntime": map[string]any{"currentBranch": "main", "isDirty": false},
			})
		}
		return result(map[string]any{"entries": entries, "emptyProjects": []map[string]any{
			{"projectId": "prj_api", "projectDisplayName": "api", "projectRootPath": "/home/u/api", "projectKind": "git"},
		}})
	case "paseo.workspaces.create":
		source := p["source"].(map[string]any)
		f.sources = append(f.sources, source)
		if base, ok := source["baseBranch"].(string); ok && f.refs != nil && !paseoResolves(f.refs, base) {
			return &relay.Outcome{Execution: "unknown", Error: &relay.Fault{Code: "native_error", Message: "Base branch not found: " + base,
				Native: json.RawMessage(`{"creation":{"phase":"failed","failedStage":"workspace","outcomeUnknown":true,"workspaceId":"wks_candidate"}}`)}}, nil
		}
		id := "wks_" + uuid.NewString()[:8]
		branch := source["branchName"].(string)
		f.workspaces[id] = &fakeWorkspace{id: id, name: str("title"), project: source["projectId"].(string),
			dir: "/home/u/.paseo/worktrees/x/" + strings.ReplaceAll(branch, "/", "-"), worktree: true}
		return result(map[string]any{"workspace": map[string]any{"id": id, "workspaceDirectory": f.workspaces[id].dir}})
	case "paseo.workspaces.archive":
		f.workspaces[str("workspaceId")].archived = true
		for _, a := range f.agents {
			if a.workspace == str("workspaceId") {
				a.archived = true
			}
		}
		return result(map[string]any{"archivedAt": time.Now()})
	case "paseo.agents.create":
		id := uuid.NewString()
		f.agents[id] = &fakeAgent{cwd: str("cwd"), workspace: str("workspaceId"), status: "idle"}
		return result(map[string]any{"agent": map[string]any{"id": id}})
	case "paseo.agents.send":
		a := f.agents[str("agentId")]
		a.inputs = append(a.inputs, str("text"))
		a.status, a.lastSent = "running", time.Now()
		return result(map[string]any{"confirmation": "native_input_accepted"})
	case "paseo.agents.cancel":
		f.agents[str("agentId")].status = "idle"
		return result(map[string]any{"interruption": "requested"})
	case "paseo.agents.archive":
		f.agents[str("agentId")].archived = true
		return result(map[string]any{})
	case "paseo.agents.get":
		a := f.agents[str("agentId")]
		if a == nil {
			return nil, &relay.Fault{Code: "not_found"}
		}
		out := map[string]any{"status": a.status, "lastUserMessageAt": a.lastSent.UTC().Format(time.RFC3339Nano)}
		if a.archived {
			out["archivedAt"] = time.Now()
		}
		if !a.finished.IsZero() {
			out["attentionReason"], out["attentionTimestamp"] = "finished", a.finished.UTC().Format(time.RFC3339Nano)
		}
		return result(out)
	case "paseo.agents.history":
		return f.readHistory(p)
	case "paseo.agents.subagents":
		if f.subagentsFailing != "" {
			fault := &relay.Fault{Code: f.subagentsFailing, Message: f.subagentsFailing}
			return &relay.Outcome{Execution: "not_started", Error: fault}, fault
		}
		a := f.agents[str("agentId")]
		if a == nil {
			return nil, &relay.Fault{Code: "not_found"}
		}
		subagents := []map[string]any{}
		for _, sub := range a.subagents {
			if str("status") == "" || sub["status"] == str("status") {
				subagents = append(subagents, sub)
			}
		}
		return result(map[string]any{"agentId": str("agentId"), "loaded": true, "nesting": true, "subagents": subagents})
	// --- Herdr
	case "session.list":
		if f.oldHerdr {
			return result(map[string]any{"items": []map[string]any{{"session": "work", "backendGeneration": strings.Repeat("a", 64)}}})
		}
		return result(map[string]any{"items": []map[string]any{{"session": "work", "endpointPresent": true}, {"session": "old", "available": false}}})
	case "workspace.list":
		return result(map[string]any{"result": map[string]any{"workspaces": []map[string]any{{"workspace_id": "w1", "label": "web"}}}})
	case "pane.list":
		return result(map[string]any{"result": map[string]any{"panes": []map[string]any{{"workspace_id": "w1", "cwd": "/home/u/web"}}}})
	case "worktree.create":
		return result(map[string]any{"result": map[string]any{"workspace": map[string]any{"workspace_id": "w2"}}})
	case "tab.create":
		id := fmt.Sprintf("%s:t%d", str("workspaceId"), len(f.tabs)+2)
		env := map[string]any{}
		for k, v := range p["env"].(map[string]string) {
			env[k] = v
		}
		f.tabs[id] = &fakeTab{workspace: str("workspaceId"), env: env}
		cwd := "/home/u/web"
		if str("workspaceId") == "w2" {
			cwd = "/home/u/.herdr/worktrees/web/feature"
		}
		return result(map[string]any{"result": map[string]any{
			"tab": map[string]any{"tab_id": id}, "root_pane": map[string]any{"pane_id": id + "p", "cwd": cwd},
		}})
	case "tab.close":
		f.tabs[str("tabId")].closed = true
		return result(map[string]any{})
	case "worktree.remove":
		if f.dirty[str("workspaceId")] {
			return nil, &relay.Fault{Code: "native_error", Message: "Herdr rejected the request",
				Native: json.RawMessage(`{"code":"dirty_worktree_requires_force"}`)}
		}
		return result(map[string]any{})
	case "agent.start":
		// Claude stops at its folder-trust question first.
		f.herdrAgents[str("name")] = &fakeHerdrAgent{pane: str("paneId"), status: "blocked", launching: true, args: anyStrings(p["args"])}
		return &relay.Outcome{Execution: "starting"}, nil
	case "agent.get":
		a := f.herdrAgents[str("name")]
		if a == nil {
			return nil, &relay.Fault{Code: "native_error", Native: json.RawMessage(`{"code":"agent_not_found"}`)}
		}
		return result(map[string]any{"result": map[string]any{"agent": map[string]any{"agent_status": a.status, "launch_pending": a.launching}}})
	case "pane.read":
		return result(map[string]any{"output": " Quick safety check: Is this a project you created or one you trust?\n ❯ No, exit\n   Yes, I trust this folder"})
	case "agent.send-keys":
		a := f.herdrAgents[str("name")]
		a.keys = append(a.keys, anyStrings(p["keys"]))
		if a.launching && slices.Equal(anyStrings(p["keys"]), []string{"down", "enter"}) {
			a.status, a.launching = "idle", false
		}
		return result(map[string]any{})
	case "agent.prompt":
		a := f.herdrAgents[str("name")]
		a.inputs = append(a.inputs, str("text"))
		a.status = "working"
		return result(map[string]any{})
	}
	return nil, &relay.Fault{Code: "unsupported_method", Message: method}
}

// paseoResolves is Paseo's lookup of a worktree's base (resolveBaseBranchForWorktree
// in @getpaseo/server 0.10): origin/<name> only as that remote-tracking ref,
// a bare name as the local branch, then origin's; never fetched.
func paseoResolves(refs map[string]bool, base string) bool {
	if strings.HasPrefix(base, "origin/") {
		return refs["refs/remotes/"+base]
	}
	return refs["refs/heads/"+base] || refs["refs/remotes/origin/"+base]
}

func anyStrings(v any) []string {
	switch v := v.(type) {
	case []string:
		return v
	case []any:
		out := []string{}
		for _, s := range v {
			out = append(out, fmt.Sprint(s))
		}
		return out
	}
	return nil
}

// finish ends a Paseo agent's turn.
func (f *fakeRelay) finish(id string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	a := f.agents[id]
	a.status, a.finished = "idle", time.Now().Add(time.Millisecond)
}

func (f *fakeRelay) only(t *testing.T) (string, *fakeAgent) {
	t.Helper()
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.agents) != 1 {
		t.Fatalf("%d native agents", len(f.agents))
	}
	for id, a := range f.agents {
		return id, a
	}
	return "", nil
}

// --- harness -----------------------------------------------------------------------

type taskEnv struct {
	*env
	relay  *fakeRelay
	runner *tasks.Runner
	// Pull requests' heads on GitHub, by URL; others cannot be read.
	heads map[string]string
}

// servedVersion is the relay's agenvo version, which connectors should run.
const servedVersion = "0.2.0"

func newTaskEnv(t *testing.T) *taskEnv {
	e := newEnv(t)
	fake := newFakeRelay()
	service := &tasks.Service{Relay: fake}
	deps := &Deps{DB: e.db, Chat: e.chat, Tasks: service, PublicURL: "https://axp.test"}
	e.public = Public(deps).Router
	e.internal = Internal(deps).Router
	te := &taskEnv{env: e, relay: fake, runner: &tasks.Runner{DB: e.db, Service: service}, heads: map[string]string{}}
	var mu sync.Mutex
	service.PullHead = func(_ context.Context, url string) (string, error) {
		mu.Lock()
		defer mu.Unlock()
		if head, ok := te.heads[url]; ok {
			return head, nil
		}
		return "", errors.New("GitHub App 没有安装到这个仓库")
	}
	return te
}

func (e *taskEnv) remote(token, method, path string, body any) response {
	headers := map[string]string{}
	if token != "" {
		headers["Authorization"] = "Bearer " + token
	}
	return do(e.t, e.public, method, "/remote/v1"+path, body, headers)
}

// computer adds a computer, enrolls it with its runtimes and approves their
// pairings; it is the computer's id and token.
func (e *taskEnv) computer(name string, kinds ...string) (string, string) {
	e.t.Helper()
	r := e.post("/computers", map[string]any{"name": name})
	if r.status != 201 {
		e.t.Fatalf("add computer: %d %s", r.status, r.body)
	}
	var install Install
	r.json(e.t, &install)
	if !strings.HasPrefix(install.Command, "curl -fsSL https://axp.test/remote/install.sh | sh -s -- axpe_") {
		e.t.Fatalf("install command %q", install.Command)
	}
	code := install.Command[strings.LastIndex(install.Command, " ")+1:]
	runtimes := []map[string]any{}
	for _, k := range kinds {
		runtimes = append(runtimes, map[string]any{"kind": k, "providers": []string{"claude", "codex"}})
	}
	report := map[string]any{"code": code, "hostname": "laptop", "os": "linux", "arch": "amd64",
		"cli": "/home/u/.local/share/axp/bin/axp", "runtimes": runtimes}
	var enrolled tasks.Enrolled
	r = e.remote("", http.MethodPost, "/enroll", report)
	if r.status != 200 {
		e.t.Fatalf("enroll: %d %s", r.status, r.body)
	}
	r.json(e.t, &enrolled)
	if s, _ := e.remote("", http.MethodPost, "/enroll", report).error(); s != 401 {
		e.t.Fatalf("an install code works twice: %d", s)
	}
	for _, k := range kinds {
		state := func() tasks.ComputerRuntime {
			var list tasks.Computers
			e.get("/computers").json(e.t, &list)
			for _, rt := range list.Computers[len(list.Computers)-1].Runtimes {
				if rt.Kind == k {
					return rt
				}
			}
			e.t.Fatalf("no %s", k)
			return tasks.ComputerRuntime{}
		}
		expect(e.t, state().State, "waiting")
		// Setup's connector pairs under the computer's label.
		e.relay.pair(tasks.PairingLabel(enrolled.ComputerID, k))
		fingerprint := "fp-" + tasks.PairingLabel(enrolled.ComputerID, k)
		if got := state(); got.State != "pairing" || !slices.Equal(got.Fingerprints, []string{fingerprint}) {
			e.t.Fatalf("runtime %+v", got)
		}
		if r := e.post("/computers/"+install.Computer.ID+"/runtimes/"+k+"/approve", map[string]any{"fingerprint": fingerprint}); r.status != 204 {
			e.t.Fatalf("approve: %d %s", r.status, r.body)
		}
		expect(e.t, state().State, "online")
	}
	return enrolled.ComputerID, enrolled.Token
}

// enroll adds a computer and enrolls it with Paseo, unpaired; it is the
// computer's id.
func (e *taskEnv) enroll(name string) string {
	e.t.Helper()
	var install Install
	e.post("/computers", map[string]any{"name": name}).json(e.t, &install)
	code := install.Command[strings.LastIndex(install.Command, " ")+1:]
	r := e.remote("", http.MethodPost, "/enroll", map[string]any{"code": code, "hostname": "laptop", "os": "linux",
		"arch": "amd64", "runtimes": []map[string]any{{"kind": "paseo", "providers": []string{"claude"}}}})
	if r.status != 200 {
		e.t.Fatalf("enroll: %d %s", r.status, r.body)
	}
	return install.Computer.ID
}

func (e *taskEnv) task(ref string) tasks.TaskDetail {
	e.t.Helper()
	var t tasks.TaskDetail
	r := e.get("/tasks/" + ref)
	if r.status != 200 {
		e.t.Fatalf("task: %d %s", r.status, r.body)
	}
	r.json(e.t, &t)
	return t
}

func kinds(t tasks.TaskDetail) string {
	var out []string
	for _, a := range t.Activity {
		out = append(out, a.Kind)
	}
	return strings.Join(out, ",")
}

func remoteAssignee(computer, runtime string, place map[string]any) map[string]any {
	return map[string]any{"kind": "remote", "computer_id": computer, "runtime": runtime, "provider": "claude", "place": place}
}

var newWorktree = map[string]any{"kind": "worktree", "from": "prj_web"}

func (e *taskEnv) create(assignee map[string]any) tasks.TaskDetail {
	e.t.Helper()
	r := e.post("/tasks", map[string]any{"title": "Fix the login page", "description": "It breaks on Safari.", "assignee": assignee})
	if r.status != 201 {
		e.t.Fatalf("create task: %d %s", r.status, r.body)
	}
	var t tasks.TaskDetail
	r.json(e.t, &t)
	return t
}

// --- tests -------------------------------------------------------------------------

func TestRemoteTaskInANewWorktreeFromBriefToDone(t *testing.T) {
	e := newTaskEnv(t)
	computer, token := e.computer("laptop", "paseo")

	// The places come from Paseo: its projects, empty ones too, and workspaces.
	var places tasks.Places
	e.get("/computers/"+computer+"/runtimes/paseo/places").json(t, &places)
	expect(t, len(places.Projects), 2)
	expect(t, places.Workspaces[0].Path, "/home/u/web")

	task := e.create(remoteAssignee(computer, "paseo", newWorktree))
	expect(t, task.Assignee.Place.Kind, "worktree")
	expect(t, task.Runs[0].Status, "queued")
	e.runner.Tick(e.ctx)

	// Paseo made the worktree, on the task's default branch.
	_, agent := e.relay.only(t)
	expect(t, agent.cwd, "/home/u/.paseo/worktrees/x/axp-1-fix-the-login-page")
	if len(agent.inputs) != 1 || !strings.Contains(agent.inputs[0], "`/home/u/.local/share/axp/bin/axp`") ||
		!strings.Contains(agent.inputs[0], "任务 #1：Fix the login page") ||
		!strings.Contains(agent.inputs[0], "It breaks on Safari.") || !strings.Contains(agent.inputs[0], "`axp` skill") {
		t.Fatalf("brief %q", agent.inputs)
	}
	// How to use axp is the skill's; the brief only names it.
	for _, manual := range []string{"axp gh", "--attach", "axp task status", "axp task show"} {
		if strings.Contains(agent.inputs[0], manual) {
			t.Fatalf("brief repeats the skill (%s): %q", manual, agent.inputs[0])
		}
	}
	task = e.task("1")
	expect(t, task.Status, "in_progress")
	expect(t, task.Runs[0].Status, "running")

	// The CLI finds its task from where it runs.
	var current CurrentTask
	e.remote(token, http.MethodGet, "/current-task?dir="+agent.cwd+"/src", nil).json(t, &current)
	expect(t, current.TaskID, task.ID)
	if s, _ := e.remote(token, http.MethodGet, "/current-task?dir=/home/u/other", nil).error(); s != 404 {
		t.Fatalf("a directory outside every place: %d", s)
	}

	for _, w := range []struct {
		path string
		body map[string]any
	}{
		{"/comments", map[string]any{"body": "Fixed the flexbox gap; PR opened."}},
		{"/status", map[string]any{"status": "in_review"}},
		{"/deliverables", map[string]any{"kind": "pull_request", "url": "https://github.com/acme/web/pull/7"}},
	} {
		if r := e.remote(token, http.MethodPost, "/tasks/"+task.ID+w.path, w.body); r.status != 204 {
			t.Fatalf("%s: %d %s", w.path, r.status, r.body)
		}
	}
	id, _ := e.relay.only(t)
	e.relay.finish(id)
	e.runner.Tick(e.ctx)
	task = e.task("#1")
	expect(t, task.Status, "in_review")
	expect(t, task.Runs[0].Status, "completed")

	var log RunLog
	e.get("/tasks/"+task.ID+"/runs/"+task.Runs[0].ID+"/log").json(t, &log)
	expect(t, log.Entries[1].Command, "ls")

	// A comment goes to the same agent as a follow-up.
	e.post("/tasks/"+task.ID+"/comments", map[string]any{"body": "Also check Firefox."})
	e.runner.Tick(e.ctx)
	e.runner.Tick(e.ctx)
	_, agent = e.relay.only(t)
	if len(agent.inputs) != 2 || !strings.Contains(agent.inputs[1], "Also check Firefox.") {
		t.Fatalf("follow-up %q", agent.inputs)
	}
	e.relay.finish(id)
	e.remote(token, http.MethodPost, "/tasks/"+task.ID+"/comments", map[string]any{"body": "Firefox is fine."})
	e.runner.Tick(e.ctx)

	// Done: the worktree workspace AXP opened is archived.
	e.patch("/tasks/1", map[string]any{"status": "done"})
	e.runner.Tick(e.ctx)
	task = e.task("1")
	last := task.Activity[len(task.Activity)-1]
	expect(t, last.Kind, "cleanup")
	if !strings.Contains(*last.Body, "worktree") {
		t.Fatalf("cleanup %q", *last.Body)
	}
	if !slices.Contains(e.relay.calls, "paseo.workspaces.archive") {
		t.Fatalf("calls %v", e.relay.calls)
	}
}

// toolCall is a Paseo history entry whose command printed size bytes.
func toolCall(command string, size int) map[string]any {
	return map[string]any{"timestamp": "2026-10-09T12:00:00Z", "item": map[string]any{"type": "tool_call", "name": "Bash",
		"status": "completed", "detail": map[string]any{"command": command, "output": strings.Repeat("x", size)}}}
}

// runLog starts a run on a Paseo computer and returns its log's path.
func (e *taskEnv) runLog(t *testing.T) string {
	computer, _ := e.computer("laptop", "paseo")
	task := e.create(remoteAssignee(computer, "paseo", newWorktree))
	e.runner.Tick(e.ctx)
	return "/tasks/" + task.ID + "/runs/" + e.task("1").Runs[0].ID + "/log"
}

func TestALongTranscriptIsReadInPagesSmallEnoughForTheRelay(t *testing.T) {
	e := newTaskEnv(t)
	path := e.runLog(t)
	// 120 commands of 5 KB each: 20 entries are about 100 KB, over 64 KiB.
	for i := range 120 {
		e.relay.history = append(e.relay.history, toolCall(fmt.Sprint(i+1), 5000))
	}

	var commands []string
	var latest RunLog
	for before := ""; ; {
		var page RunLog
		e.get(path, "before", before).json(t, &page)
		if before == "" {
			latest = page
		}
		var these []string
		for _, entry := range page.Entries {
			these = append(these, entry.Command)
		}
		commands = append(these, commands...)
		if page.Older == "" {
			break
		}
		before = page.Older
	}
	// The latest page is oldest first and ends with the last command;
	// together the pages hold every command once, in order.
	expect(t, latest.Entries[len(latest.Entries)-1].Command, "120")
	expect(t, len(commands), 120)
	for i, command := range commands {
		expect(t, command, fmt.Sprint(i+1))
	}
	// Each page took the largest read that fit, halving from 20.
	expect(t, fmt.Sprint(e.relay.historyReads[:2]), "[20 10]")
	// A read that fails is only that: the run goes on.
	expect(t, e.task("1").Runs[0].Status, "running")
}

func TestAnEntryTooLargeForTheRelayIsAnErrorAndTheNewerOnesStillRead(t *testing.T) {
	e := newTaskEnv(t)
	path := e.runLog(t)
	for i := range 6 {
		size := 10
		if i == 2 {
			size = 70 * 1024
		}
		e.relay.history = append(e.relay.history, toolCall(fmt.Sprint(i+1), size))
	}
	var commands []string
	before := ""
	for {
		r := e.get(path, "before", before)
		if r.status != 200 {
			if status, code := r.error(); status != 424 || code != "REMOTE_LOG_TOO_LARGE" {
				t.Fatalf("%d %s", status, code)
			}
			break
		}
		var page RunLog
		r.json(t, &page)
		for _, entry := range page.Entries {
			commands = append(commands, entry.Command)
		}
		if page.Older == "" {
			t.Fatal("read past the large entry")
		}
		before = page.Older
	}
	// Everything after the large entry was read.
	slices.Sort(commands)
	expect(t, strings.Join(commands, " "), "4 5 6")
	expect(t, e.task("1").Runs[0].Status, "running")
}

func TestAnOlderPageOfARebuiltTimelineIsRefused(t *testing.T) {
	e := newTaskEnv(t)
	path := e.runLog(t)
	for i := range 60 {
		e.relay.history = append(e.relay.history, toolCall(fmt.Sprint(i+1), 10))
	}
	var page RunLog
	e.get(path).json(t, &page)
	if page.Older == "" {
		t.Fatal("no older entries")
	}
	e.relay.historyEpoch = "e2"
	if status, code := e.get(path, "before", page.Older).error(); status != 409 || code != "LOG_RESET" {
		t.Fatalf("%d %s", status, code)
	}
	if status, _ := e.get(path, "before", "nonsense").error(); status != 422 {
		t.Fatalf("a bad cursor: %d", status)
	}
}

func TestAnOfflineComputerIsLoggedOnceAndCleanedUpLater(t *testing.T) {
	var logs bytes.Buffer
	defer slog.SetDefault(slog.Default())
	slog.SetDefault(slog.New(slog.NewTextHandler(&logs, nil)))
	count := func(msg string) int { return strings.Count(logs.String(), msg) }

	e := newTaskEnv(t)
	computer, _ := e.computer("laptop", "paseo")
	e.create(remoteAssignee(computer, "paseo", newWorktree))
	e.runner.Tick(e.ctx)
	id, _ := e.relay.only(t)
	e.relay.failing = "device_offline"
	for range 3 {
		e.runner.Tick(e.ctx)
	}
	if n := count("Cannot look at a remote agent"); n != 1 {
		t.Fatalf("watch logged %d times: %s", n, logs.String())
	}

	// Back online, the run ends (reminded, then failed for not replying).
	e.relay.failing = ""
	e.relay.finish(id)
	e.runner.Tick(e.ctx)
	e.relay.finish(id)
	e.runner.Tick(e.ctx)
	if status := e.task("1").Runs[0].Status; status == "running" {
		t.Fatalf("run still %s", status)
	}

	e.patch("/tasks/1", map[string]any{"status": "done"})
	e.relay.failing = "device_offline"
	for range 3 {
		e.runner.Tick(e.ctx)
	}
	if n := count("Cannot clean up a remote session"); n != 1 {
		t.Fatalf("cleanup logged %d times: %s", n, logs.String())
	}
	e.relay.failing = ""
	e.runner.Tick(e.ctx)
	last := e.task("1").Activity
	expect(t, last[len(last)-1].Kind, "cleanup")
}

func TestAnExistingWorkspaceKeepsItsWorkspaceWhenDone(t *testing.T) {
	e := newTaskEnv(t)
	computer, _ := e.computer("laptop", "paseo")
	e.create(remoteAssignee(computer, "paseo", map[string]any{"kind": "workspace", "workspace_id": "wks_main"}))
	e.runner.Tick(e.ctx)
	_, agent := e.relay.only(t)
	expect(t, agent.cwd, "/home/u/web")
	e.patch("/tasks/1", map[string]any{"status": "done"})
	e.runner.Tick(e.ctx)
	// Only the agent AXP started is archived; the user's workspace stays.
	if slices.Contains(e.relay.calls, "paseo.workspaces.archive") || !slices.Contains(e.relay.calls, "paseo.agents.archive") {
		t.Fatalf("calls %v", e.relay.calls)
	}
	expect(t, e.relay.workspaces["wks_main"].archived, false)
}

func TestHerdrRunsInATabOfANewWorktree(t *testing.T) {
	e := newTaskEnv(t)
	computer, _ := e.computer("desktop", "herdr")
	var places tasks.Places
	e.get("/computers/"+computer+"/runtimes/herdr/places").json(t, &places)
	expect(t, places.Workspaces[0].Path, "/home/u/web")
	expect(t, *places.Workspaces[0].Session, "work")

	task := e.create(remoteAssignee(computer, "herdr", map[string]any{"kind": "worktree", "from": "w1", "session": "work", "branch": "feature"}))
	e.runner.Tick(e.ctx)
	if len(e.relay.tabs) != 1 {
		t.Fatalf("tabs %v", e.relay.tabs)
	}
	for _, tab := range e.relay.tabs {
		expect(t, tab.workspace, "w2")
		expect(t, tab.env["AXP_TASK_ID"], any(task.ID))
	}
	for _, a := range e.relay.herdrAgents {
		// Started with full access; Claude's folder-trust question was
		// answered, then the brief sent.
		if !slices.Contains(a.args, "--dangerously-skip-permissions") || len(a.keys) != 1 || len(a.inputs) != 1 {
			t.Fatalf("agent %+v", a)
		}
	}
	expect(t, e.task("1").Runs[0].Status, "running")

	// Uncommitted work keeps the worktree.
	e.relay.dirty["w2"] = true
	e.patch("/tasks/1", map[string]any{"status": "done"})
	e.runner.Tick(e.ctx)
	last := e.task("1").Activity
	if body := *last[len(last)-1].Body; !strings.Contains(body, "未提交") {
		t.Fatalf("cleanup %q", body)
	}
}

// A Herdr connector from before agenvo 0.2 is told to update rather than
// called with arguments it rejects.
func TestOldHerdrConnectorNeedsAnUpdate(t *testing.T) {
	e := newTaskEnv(t)
	computer, _ := e.computer("desktop", "herdr")
	e.relay.oldHerdr = true
	r := e.get("/computers/" + computer + "/runtimes/herdr/places")
	if r.status < 400 || !strings.Contains(string(r.body), "「更新」") {
		t.Fatalf("%d %s", r.status, r.body)
	}
}

// A computer whose connector runs another agenvo version than AXP serves is
// marked for an update; its update command is a new install command, which
// enrolls the same computer again and keeps its pairings.
func TestOutdatedConnectorIsUpdatedWithANewInstallCommand(t *testing.T) {
	e := newTaskEnv(t)
	computer, _ := e.computer("laptop", "paseo")
	device := "device-" + computer + ":paseo"
	e.relay.versions = map[string]string{device: "0.1.0"}
	var list tasks.Computers
	e.get("/computers").json(t, &list)
	rt := list.Computers[0].Runtimes[0]
	if !rt.NeedsUpdate || rt.ConnectorVersion == nil || *rt.ConnectorVersion != "0.1.0" || *list.ConnectorVersion != servedVersion {
		t.Fatalf("%+v %v", rt, list.ConnectorVersion)
	}

	r := e.post("/computers/"+computer+"/install", nil)
	if r.status != 200 {
		t.Fatalf("update command: %d %s", r.status, r.body)
	}
	var install Install
	r.json(t, &install)
	code := install.Command[strings.LastIndex(install.Command, " ")+1:]
	var enrolled tasks.Enrolled
	e.remote("", http.MethodPost, "/enroll", map[string]any{"code": code, "hostname": "laptop", "os": "linux", "arch": "amd64",
		"runtimes": []map[string]any{{"kind": "paseo", "providers": []string{"claude"}}}}).json(t, &enrolled)
	expect(t, enrolled.ComputerID, computer)
	expect(t, enrolled.RelayURL, "https://axp.test/remote/relay")
	expect(t, enrolled.ConnectorVersion, servedVersion)

	delete(e.relay.versions, device) // setup installed the relay's version
	e.get("/computers").json(t, &list)
	rt = list.Computers[0].Runtimes[0]
	expect(t, rt.State, "online")
	expect(t, rt.NeedsUpdate, false)
}

func TestRemoteAgentThatDoesNotReplyIsRemindedOnceThenFails(t *testing.T) {
	e := newTaskEnv(t)
	computer, _ := e.computer("laptop", "paseo")
	e.create(remoteAssignee(computer, "paseo", newWorktree))
	e.runner.Tick(e.ctx)
	id, _ := e.relay.only(t)

	e.relay.finish(id)
	e.runner.Tick(e.ctx)
	_, agent := e.relay.only(t)
	if len(agent.inputs) != 2 || !strings.Contains(agent.inputs[1], "axp task comment") {
		t.Fatalf("no reminder: %q", agent.inputs)
	}
	run := e.task("1").Runs[0]
	expect(t, run.Status, "running")
	expect(t, run.Nudged, true)

	e.relay.finish(id)
	e.runner.Tick(e.ctx)
	run = e.task("1").Runs[0]
	expect(t, run.Status, "failed")
	if run.Error == nil || !strings.Contains(*run.Error, "axp task comment") {
		t.Fatalf("error %v", run.Error)
	}
}

func TestInterruptingARun(t *testing.T) {
	e := newTaskEnv(t)
	computer, _ := e.computer("laptop", "paseo")
	e.create(remoteAssignee(computer, "paseo", newWorktree))
	e.runner.Tick(e.ctx)
	run := e.task("1").Runs[0]
	if r := e.post("/tasks/1/runs/"+run.ID+"/interrupt", nil); r.status != 200 {
		t.Fatalf("interrupt: %d %s", r.status, r.body)
	}
	e.runner.Tick(e.ctx)
	expect(t, e.task("1").Runs[0].Status, "cancelled")
	if !slices.Contains(e.relay.calls, "paseo.agents.cancel") {
		t.Fatalf("calls %v", e.relay.calls)
	}
}

// Two devices ask to pair under one computer's label (setup run again, or
// someone else using the label): both are shown, and only the one whose
// fingerprint the user compared is approved.
func TestApprovingAPairingTakesTheComparedFingerprint(t *testing.T) {
	e := newTaskEnv(t)
	computer := e.enroll("laptop")
	label := tasks.PairingLabel(computer, "paseo")
	e.relay.pairAs(label, "code-a", "fp-a")
	e.relay.pairAs(label, "code-b", "fp-b")
	var list tasks.Computers
	e.get("/computers").json(t, &list)
	runtime := list.Computers[0].Runtimes[0]
	expect(t, runtime.State, "pairing")
	expect(t, strings.Join(runtime.Fingerprints, ","), "fp-a,fp-b")

	approve := func(body any) response {
		return e.post("/computers/"+computer+"/runtimes/paseo/approve", body)
	}
	expect(t, approve(nil).status, 400)
	expect(t, approve(map[string]any{"fingerprint": ""}).status, 422)
	expectError(t, approve(map[string]any{"fingerprint": "fp-c"}), 409, "FINGERPRINT_MISMATCH")
	expect(t, approve(map[string]any{"fingerprint": "fp-b"}).status, 204)
	state, _ := e.relay.State(e.ctx)
	if len(state.Pairings) != 1 || state.Pairings[0].Digest != "fp-a" {
		t.Fatalf("approved the wrong pairing: %+v", state.Pairings)
	}
	expect(t, scalar[string](e.env, "SELECT device_id FROM computer_runtime"), "device-"+strings.TrimPrefix(label, "axp:"))
}

// Stopped while its place was being opened: the remote agent is never sent
// the prompt, and what was opened for it is cleaned up.
func TestARunStoppedWhileItsPlaceOpensIsNeverSent(t *testing.T) {
	e := newTaskEnv(t)
	computer, _ := e.computer("laptop", "paseo")
	e.create(remoteAssignee(computer, "paseo", newWorktree))
	run := e.task("1").Runs[0]
	e.relay.before = func(method string) {
		if method == "paseo.agents.create" {
			if r := e.post("/tasks/1/runs/"+run.ID+"/interrupt", nil); r.status != 200 {
				t.Errorf("interrupt: %d %s", r.status, r.body)
			}
		}
	}
	e.runner.Tick(e.ctx)
	e.relay.before = nil
	expect(t, e.task("1").Runs[0].Status, "cancelled")
	if slices.Contains(e.relay.calls, "paseo.agents.send") {
		t.Fatalf("a cancelled run was sent its prompt: %v", e.relay.calls)
	}
	expect(t, scalar[bool](e.env, "SELECT closed_at IS NOT NULL FROM task_session"), true)
	if !slices.Contains(e.relay.calls, "paseo.workspaces.archive") {
		t.Fatalf("the worktree opened for it stays: %v", e.relay.calls)
	}
}

// The runner is stopped (a deploy) while it opens a place: the start still
// finishes and is recorded, so the next runner does not open another.
func TestAStartFinishesWhenTheRunnerIsStopped(t *testing.T) {
	e := newTaskEnv(t)
	computer, _ := e.computer("laptop", "paseo")
	e.create(remoteAssignee(computer, "paseo", newWorktree))
	ctx, stop := context.WithCancel(e.ctx)
	e.relay.before = func(method string) {
		if method == "paseo.workspaces.create" {
			stop()
		}
	}
	e.runner.Tick(ctx)
	e.relay.before = nil
	expect(t, e.task("1").Runs[0].Status, "running")
	e.runner.Tick(e.ctx)
	opened := 0
	for _, call := range e.relay.calls {
		if call == "paseo.workspaces.create" || call == "paseo.agents.create" {
			opened++
		}
	}
	expect(t, opened, 2) // one worktree, one agent
	_, agent := e.relay.only(t)
	expect(t, len(agent.inputs), 1)
}

// A runner that died while opening a place (no record of what it opened)
// fails the run rather than open a second place.
func TestARunInterruptedWhileOpeningFailsInsteadOfOpeningAgain(t *testing.T) {
	e := newTaskEnv(t)
	computer, _ := e.computer("laptop", "paseo")
	e.create(remoteAssignee(computer, "paseo", newWorktree))
	e.exec("UPDATE task_run SET status = 'starting', opening_at = now()")
	e.runner.Tick(e.ctx)
	run := e.task("1").Runs[0]
	expect(t, run.Status, "failed")
	if run.Error == nil || !strings.Contains(*run.Error, "中断") {
		t.Fatalf("error %v", run.Error)
	}
	for _, call := range e.relay.calls {
		if strings.HasSuffix(call, ".create") {
			t.Fatalf("opened again: %v", e.relay.calls)
		}
	}
}

// Paseo reports a base branch it cannot find as an unknown outcome (#63:
// a branch only on the remote, not fetched on that computer yet). The run
// fails once with Paseo's reason and how to fix it, and nothing is opened
// again.
func TestAnUnknownOpeningKeepsTheRuntimesReason(t *testing.T) {
	e := newTaskEnv(t)
	computer, _ := e.computer("laptop", "paseo")
	e.relay.refs = map[string]bool{"refs/heads/main": true}
	place := map[string]any{"kind": "worktree", "from": "prj_web", "branch": "fix/61", "base": "refactor/kernel-plugins"}
	e.create(remoteAssignee(computer, "paseo", place))
	e.runner.Tick(e.ctx)
	e.runner.Tick(e.ctx)
	run := e.task("1").Runs[0]
	expect(t, run.Status, "failed")
	if run.Error == nil {
		t.Fatal("no error")
	}
	for _, want := range []string{"Base branch not found: refactor/kernel-plugins", "不会自动重试", "git fetch origin refactor/kernel-plugins"} {
		if !strings.Contains(*run.Error, want) {
			t.Fatalf("error %q, want %q", *run.Error, want)
		}
	}
	// One attempt, with the base as given (never main instead), and no agent.
	expect(t, len(e.relay.sources), 1)
	expect(t, e.relay.sources[0]["baseBranch"], any("refactor/kernel-plugins"))
	for _, call := range e.relay.calls {
		if call == "paseo.agents.create" {
			t.Fatalf("started an agent: %v", e.relay.calls)
		}
	}
}

// Once the remote branch is fetched there, the same base opens the worktree,
// bare or as origin/<name>.
func TestAFetchedRemoteBaseBranchOpensTheWorktree(t *testing.T) {
	for _, base := range []string{"refactor/kernel-plugins", "origin/refactor/kernel-plugins"} {
		t.Run(base, func(t *testing.T) {
			e := newTaskEnv(t)
			computer, _ := e.computer("laptop", "paseo")
			e.relay.refs = map[string]bool{"refs/heads/main": true, "refs/remotes/origin/refactor/kernel-plugins": true}
			e.create(remoteAssignee(computer, "paseo", map[string]any{"kind": "worktree", "from": "prj_web", "branch": "fix/61", "base": base}))
			e.runner.Tick(e.ctx)
			expect(t, e.task("1").Runs[0].Status, "running")
			expect(t, e.relay.sources[0]["baseBranch"], any(base))
		})
	}
}

func TestReassigningStopsTheRemoteAgent(t *testing.T) {
	e := newTaskEnv(t)
	computer, _ := e.computer("laptop", "paseo")
	e.create(remoteAssignee(computer, "paseo", newWorktree))
	r := e.patch("/tasks/1", map[string]any{"assignee": map[string]any{"kind": "user"}})
	if r.status != 200 {
		t.Fatalf("reassign: %d %s", r.status, r.body)
	}
	task := e.task("1")
	expect(t, task.Runs[0].Status, "cancelled")
	expect(t, task.Assignee.Kind, "user")
	e.post("/tasks/1/comments", map[string]any{"body": "I'll do it."})
	expect(t, len(e.task("1").Runs), 1)
}

func TestAssigningNeedsAPairedRuntimeAndAPlace(t *testing.T) {
	e := newTaskEnv(t)
	laptop, _ := e.computer("laptop", "paseo")
	_, other := e.computer("desktop", "paseo")
	task := e.create(remoteAssignee(laptop, "paseo", newWorktree))
	if s, code := e.remote(other, http.MethodPost, "/tasks/"+task.ID+"/comments", map[string]any{"body": "hi"}).error(); s != 403 {
		t.Fatalf("%d %s", s, code)
	}
	if s, _ := e.remote("nope", http.MethodGet, "/tasks/"+task.ID, nil).error(); s != 401 {
		t.Fatalf("bad token: %d", s)
	}
	for _, assignee := range []map[string]any{
		remoteAssignee(laptop, "herdr", newWorktree),                        // not paired
		remoteAssignee(laptop, "paseo", nil),                                // no place
		remoteAssignee(laptop, "paseo", map[string]any{"kind": "worktree"}), // from what?
	} {
		if s, _ := e.post("/tasks", map[string]any{"title": "x", "assignee": assignee}).error(); s != 422 {
			t.Fatalf("%v accepted: %d", assignee, s)
		}
	}
}

func TestBacklogTasksWaitUntilTakenUp(t *testing.T) {
	e := newTaskEnv(t)
	computer, _ := e.computer("laptop", "paseo")
	r := e.post("/tasks", map[string]any{"title": "Later", "status": "backlog", "assignee": remoteAssignee(computer, "paseo", newWorktree)})
	if r.status != 201 {
		t.Fatalf("%d %s", r.status, r.body)
	}
	expect(t, len(e.task("1").Runs), 0)
	e.patch("/tasks/1", map[string]any{"status": "todo"})
	expect(t, len(e.task("1").Runs), 1)
}

// mcpCall calls the tasks plugin's tool as the agent.
func (e *taskEnv) mcpCall(agentID, tool string, args map[string]any) map[string]any {
	e.t.Helper()
	v, _ := e.mcpResult(agentID, tool, args)
	return v
}

// mcpResult is a tool's structured output and its result's _meta.
func (e *taskEnv) mcpResult(agentID, tool string, args map[string]any) (out, meta map[string]any) {
	e.t.Helper()
	body := map[string]any{"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": map[string]any{"name": tool, "arguments": args}}
	r := do(e.t, e.internal, http.MethodPost, "/tasks/mcp", body, map[string]string{
		"X-AXP-Agent-Id": agentID, "Accept": "application/json, text/event-stream",
	})
	if r.status != 200 {
		e.t.Fatalf("mcp: %d %s", r.status, r.body)
	}
	var res struct {
		Result struct {
			IsError bool `json:"isError"`
			Content []struct {
				Text string `json:"text"`
			} `json:"content"`
			Meta map[string]any `json:"_meta"`
		} `json:"result"`
	}
	r.json(e.t, &res)
	if res.Result.IsError {
		e.t.Fatalf("%s: %s", tool, res.Result.Content[0].Text)
	}
	_ = json.Unmarshal([]byte(res.Result.Content[0].Text), &out)
	return out, res.Result.Meta
}

func TestAgentsUseTheBoard(t *testing.T) {
	e := newTaskEnv(t)
	computer, _ := e.computer("laptop", "paseo")
	agent := e.createAgent("helper")
	places := e.mcpCall(agent.ID, "list_places", map[string]any{"computer_id": computer, "runtime": "paseo"})
	expect(t, len(places["projects"].([]any)), 2)
	created := e.mcpCall(agent.ID, "create_task", map[string]any{
		"title": "Proofread the report", "assignee": map[string]any{"kind": "user"},
	})
	expect(t, fmt.Sprint(created["number"]), "1")
	_, meta := e.mcpResult(agent.ID, "comment_task", map[string]any{"task": "1", "body": "Two typos on page 3."})
	// The transcript links the call to the task it touched.
	expect(t, fmt.Sprint(meta["axp/ref"]), fmt.Sprintf("map[id:%s kind:task number:1 status:todo title:Proofread the report]", created["id"]))
	task := e.task("1")
	expect(t, task.CreatedBy.Kind, "agent")
	expect(t, *task.CreatedBy.AgentName, "helper")
	expect(t, task.Activity[len(task.Activity)-1].Actor.Kind, "agent")
	list, meta := e.mcpResult(agent.ID, "list_tasks", map[string]any{})
	expect(t, len(list["tasks"].([]any)), 1)
	expect(t, meta["axp/ref"], nil)
}

func TestRemoteDownloadsAreTheBinariesAndConnectors(t *testing.T) {
	for name, ok := range map[string]bool{
		"axp-linux-amd64":                     true,
		"axp-darwin-arm64":                    true,
		"agenvo-paseo-0.2.0+5ec6084157f7.tgz": true,
		"agenvo-herdr-0.2.0.tgz":              true,
		"agenvo-server-0.2.0.tgz":             false,
		"agenvo-paseo-../x.tgz":               false,
		"axp-windows-amd64":                   false,
	} {
		if downloadable.MatchString(name) != ok {
			t.Errorf("%s: %v", name, !ok)
		}
	}
}
