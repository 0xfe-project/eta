package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/akarachen/axp/apps/control-plane/internal/relay"
	"github.com/akarachen/axp/apps/control-plane/internal/tasks"
	"github.com/google/uuid"
)

// fakeRelay is the agenvo relay with a Paseo connector whose agents do what
// the test says.
type fakeRelay struct {
	mu       sync.Mutex
	pairings map[string]string // code -> device
	agents   map[string]*fakeAgent
	// Every runtime call, as "method".
	calls []string
}

type fakeAgent struct {
	cwd      string
	status   string // idle or running
	inputs   []string
	lastSent time.Time
	finished time.Time
	gone     bool
}

func newFakeRelay() *fakeRelay {
	return &fakeRelay{pairings: map[string]string{}, agents: map[string]*fakeAgent{}}
}

func (f *fakeRelay) Origin() string { return "https://relay.test" }

func (f *fakeRelay) State(context.Context) (*relay.State, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	s := &relay.State{}
	for _, device := range f.pairings {
		s.Devices = append(s.Devices, relay.Device{ID: device, Online: true, Instances: []relay.Instance{
			{InstanceID: "paseo", Kind: "paseo", Available: true, Approved: true},
		}})
	}
	return s, nil
}

func (f *fakeRelay) ApprovePairing(_ context.Context, code, _ string) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	device := "device-" + code
	f.pairings[code] = device
	return device, nil
}

func (f *fakeRelay) ApproveInstance(context.Context, string, string, string) error { return nil }
func (f *fakeRelay) RevokeDevice(context.Context, string) error                    { return nil }

func (f *fakeRelay) Call(_ context.Context, _, _, method string, params any) (*relay.Outcome, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, method)
	p := params.(map[string]any)
	result := func(v any) (*relay.Outcome, error) {
		data, _ := json.Marshal(v)
		return &relay.Outcome{Execution: "accepted", Result: data}, nil
	}
	switch method {
	case "paseo.agents.create":
		id := uuid.NewString()
		f.agents[id] = &fakeAgent{cwd: p["cwd"].(string), status: "idle"}
		return result(map[string]any{"agent": map[string]any{"id": id}})
	case "paseo.agents.send":
		a := f.agents[p["agentId"].(string)]
		a.inputs = append(a.inputs, p["text"].(string))
		a.status, a.lastSent = "running", time.Now()
		return result(map[string]any{"confirmation": "native_input_accepted"})
	case "paseo.agents.cancel":
		f.agents[p["agentId"].(string)].status = "idle"
		return result(map[string]any{"interruption": "requested"})
	case "paseo.agents.get":
		a := f.agents[p["agentId"].(string)]
		if a == nil || a.gone {
			return nil, &relay.Fault{Code: "not_found"}
		}
		out := map[string]any{"status": a.status, "lastUserMessageAt": a.lastSent.UTC().Format(time.RFC3339Nano)}
		if !a.finished.IsZero() {
			out["attentionReason"], out["attentionTimestamp"] = "finished", a.finished.UTC().Format(time.RFC3339Nano)
		}
		return result(out)
	case "paseo.agents.history":
		return result(map[string]any{"entries": []map[string]any{
			{"timestamp": "2026-10-08T12:00:00Z", "item": map[string]any{"type": "assistant_message", "text": "done"}},
			{"timestamp": "2026-10-08T12:00:01Z", "item": map[string]any{"type": "tool_call", "name": "Bash", "status": "completed",
				"detail": map[string]any{"command": "ls", "output": "hello.txt"}}},
		}})
	}
	return nil, &relay.Fault{Code: "method_not_found", Message: method}
}

// finish ends the agent's turn.
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
}

func newTaskEnv(t *testing.T) *taskEnv {
	e := newEnv(t)
	fake := newFakeRelay()
	service := &tasks.Service{Relay: fake}
	deps := &Deps{DB: e.db, Chat: e.chat, Tasks: service, PublicURL: "https://axp.test"}
	e.public, _ = Public(deps)
	e.internal, _ = Internal(deps)
	return &taskEnv{env: e, relay: fake, runner: &tasks.Runner{DB: e.db, Service: service}}
}

func (e *taskEnv) remote(token, method, path string, body any) response {
	headers := map[string]string{}
	if token != "" {
		headers["Authorization"] = "Bearer " + token
	}
	return do(e.t, e.public, method, "/remote/v1"+path, body, headers)
}

// computer adds a computer, enrolls it with Paseo paired, and is its id and
// token.
func (e *taskEnv) computer(name string) (string, string) {
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
	var enrolled tasks.Enrolled
	r = e.remote("", http.MethodPost, "/enroll", map[string]any{"code": code})
	if r.status != 200 {
		e.t.Fatalf("enroll: %d %s", r.status, r.body)
	}
	r.json(e.t, &enrolled)
	if s, _ := e.remote("", http.MethodPost, "/enroll", map[string]any{"code": code}).error(); s != 401 {
		e.t.Fatalf("an install code works twice: %d", s)
	}
	e.heartbeat(enrolled.Token, map[string]any{"kind": "paseo", "providers": []string{"claude", "codex"},
		"pairing": map[string]any{"code": "code-" + name, "fingerprint": "fp"}})
	var list tasks.Computers
	e.get("/computers").json(e.t, &list)
	if got := list.Computers[len(list.Computers)-1].Runtimes[0]; got.State != "pairing" || got.Fingerprint == nil {
		e.t.Fatalf("runtime %+v", got)
	}
	if r := e.post("/computers/"+install.Computer.ID+"/runtimes/paseo/approve", nil); r.status != 204 {
		e.t.Fatalf("approve: %d %s", r.status, r.body)
	}
	device := "device-code-" + name
	e.heartbeat(enrolled.Token, map[string]any{"kind": "paseo", "providers": []string{"claude", "codex"}, "device_id": device})
	e.get("/computers").json(e.t, &list)
	if got := list.Computers[len(list.Computers)-1].Runtimes[0]; got.State != "online" {
		e.t.Fatalf("runtime %+v", got)
	}
	return enrolled.ComputerID, enrolled.Token
}

func (e *taskEnv) heartbeat(token string, runtimes ...map[string]any) tasks.HeartbeatReply {
	e.t.Helper()
	r := e.remote(token, http.MethodPost, "/heartbeat", map[string]any{
		"hostname": "laptop", "os": "linux", "arch": "amd64", "workspace_root": "/home/u/axp/tasks",
		"cli": "/home/u/.local/share/axp/bin/axp", "runtimes": runtimes,
	})
	if r.status != 200 {
		e.t.Fatalf("heartbeat: %d %s", r.status, r.body)
	}
	var reply tasks.HeartbeatReply
	r.json(e.t, &reply)
	return reply
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

func (e *taskEnv) createRemote(computer string) tasks.TaskDetail {
	e.t.Helper()
	r := e.post("/tasks", map[string]any{
		"title": "Fix the login page", "description": "It breaks on Safari.", "repository": "https://github.com/acme/web.git",
		"assignee": map[string]any{"kind": "remote", "computer_id": computer, "runtime": "paseo", "provider": "claude"},
	})
	if r.status != 201 {
		e.t.Fatalf("create task: %d %s", r.status, r.body)
	}
	var t tasks.TaskDetail
	r.json(e.t, &t)
	return t
}

// start takes a fresh task's first run to running: the daemon prepares
// its workspace, the runner opens the agent and sends the brief.
func (e *taskEnv) start(token string, t tasks.TaskDetail) {
	e.t.Helper()
	e.runner.Tick(e.ctx)
	reply := e.heartbeat(token, map[string]any{"kind": "paseo", "providers": []string{"claude"}, "device_id": "x"})
	if len(reply.Prepare) != 1 || reply.Prepare[0].TaskID != t.ID {
		e.t.Fatalf("prepare %+v", reply.Prepare)
	}
	if r := e.remote(token, http.MethodPost, "/runs/"+reply.Prepare[0].RunID+"/prepared",
		map[string]any{"workspace": "/home/u/axp/tasks/" + t.ID}); r.status != 204 {
		e.t.Fatalf("prepared: %d %s", r.status, r.body)
	}
	e.runner.Tick(e.ctx)
}

// --- tests -------------------------------------------------------------------------

func TestRemoteTaskFromBriefToFollowUp(t *testing.T) {
	e := newTaskEnv(t)
	computer, token := e.computer("laptop")
	task := e.createRemote(computer)
	expect(t, task.Number, int64(1))
	expect(t, *task.Repository, "acme/web")
	expect(t, task.Assignee.Kind, "remote")
	expect(t, task.Runs[0].Status, "queued")

	e.start(token, task)
	_, agent := e.relay.only(t)
	expect(t, agent.cwd, "/home/u/axp/tasks/"+task.ID)
	if len(agent.inputs) != 1 || !strings.Contains(agent.inputs[0], "`/home/u/.local/share/axp/bin/axp`") ||
		!strings.Contains(agent.inputs[0], "任务 #1：Fix the login page") || !strings.Contains(agent.inputs[0], "axp repo checkout acme/web") {
		t.Fatalf("brief %q", agent.inputs)
	}
	task = e.task("1")
	expect(t, task.Status, "in_progress")
	expect(t, task.Runs[0].Status, "running")

	// The agent works as the computer: checkout, reply, status, deliverable.
	for _, w := range []struct {
		path string
		body map[string]any
	}{
		{"/checkouts", map[string]any{"repository": "acme/web", "branch": "axp/1", "base_commit": "0123456789abcdef", "path": "/x"}},
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
	expect(t, kinds(task), "created,assignee,run_queued,run_started,status,checkout,comment,status,deliverable,run_completed")

	// The run's transcript comes from the agent.
	var log RunLog
	e.get("/tasks/"+task.ID+"/runs/"+task.Runs[0].ID+"/log").json(t, &log)
	expect(t, len(log.Entries), 2)
	expect(t, log.Entries[1].Command, "ls")

	// A comment goes to the same agent as a follow-up.
	if r := e.post("/tasks/"+task.ID+"/comments", map[string]any{"body": "Also check Firefox."}); r.status != 201 {
		t.Fatalf("comment: %d %s", r.status, r.body)
	}
	e.runner.Tick(e.ctx) // queued -> starting, without preparing again
	e.runner.Tick(e.ctx)
	_, agent = e.relay.only(t)
	if len(agent.inputs) != 2 || !strings.Contains(agent.inputs[1], "Also check Firefox.") {
		t.Fatalf("follow-up %q", agent.inputs)
	}
	expect(t, e.task("1").Runs[1].Status, "running")
}

func TestRemoteAgentThatDoesNotReplyIsRemindedOnceThenFails(t *testing.T) {
	e := newTaskEnv(t)
	computer, token := e.computer("laptop")
	task := e.createRemote(computer)
	e.start(token, task)
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
	computer, token := e.computer("laptop")
	task := e.createRemote(computer)
	e.start(token, task)
	run := e.task("1").Runs[0]
	if r := e.post("/tasks/1/runs/"+run.ID+"/interrupt", nil); r.status != 200 {
		t.Fatalf("interrupt: %d %s", r.status, r.body)
	}
	e.runner.Tick(e.ctx)
	expect(t, e.task("1").Runs[0].Status, "cancelled")
	if !strings.Contains(strings.Join(e.relay.calls, ","), "paseo.agents.cancel") {
		t.Fatalf("calls %v", e.relay.calls)
	}
}

func TestReassigningStopsTheRemoteAgent(t *testing.T) {
	e := newTaskEnv(t)
	computer, _ := e.computer("laptop")
	e.createRemote(computer)
	r := e.patch("/tasks/1", map[string]any{"assignee": map[string]any{"kind": "user"}})
	if r.status != 200 {
		t.Fatalf("reassign: %d %s", r.status, r.body)
	}
	task := e.task("1")
	expect(t, task.Runs[0].Status, "cancelled")
	expect(t, task.Assignee.Kind, "user")
	// Comments now reach nobody.
	e.post("/tasks/1/comments", map[string]any{"body": "I'll do it."})
	expect(t, len(e.task("1").Runs), 1)
}

func TestComputersSeeOnlyTheirTasks(t *testing.T) {
	e := newTaskEnv(t)
	laptop, _ := e.computer("laptop")
	_, other := e.computer("desktop")
	task := e.createRemote(laptop)
	if s, code := e.remote(other, http.MethodPost, "/tasks/"+task.ID+"/comments", map[string]any{"body": "hi"}).error(); s != 403 {
		t.Fatalf("%d %s", s, code)
	}
	if s, _ := e.remote("nope", http.MethodGet, "/tasks/"+task.ID, nil).error(); s != 401 {
		t.Fatalf("bad token: %d", s)
	}
	// An assignee must be a paired runtime's provider.
	r := e.post("/tasks", map[string]any{"title": "x", "assignee": map[string]any{
		"kind": "remote", "computer_id": laptop, "runtime": "herdr", "provider": "claude"}})
	if s, _ := r.error(); s != 422 {
		t.Fatalf("unpaired runtime accepted: %d", s)
	}
}

func TestBacklogTasksWaitUntilTakenUp(t *testing.T) {
	e := newTaskEnv(t)
	computer, _ := e.computer("laptop")
	r := e.post("/tasks", map[string]any{"title": "Later", "status": "backlog",
		"assignee": map[string]any{"kind": "remote", "computer_id": computer, "runtime": "paseo", "provider": "codex"}})
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
	body := map[string]any{"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": map[string]any{"name": tool, "arguments": args}}
	r := do(e.t, e.internal, http.MethodPost, "/tasks/mcp", body, map[string]string{
		"X-AXP-Agent-Id": agentID, "Accept": "application/json, text/event-stream",
	})
	if r.status != 200 {
		e.t.Fatalf("mcp: %d %s", r.status, r.body)
	}
	var out struct {
		Result struct {
			IsError bool `json:"isError"`
			Content []struct {
				Text string `json:"text"`
			} `json:"content"`
		} `json:"result"`
	}
	r.json(e.t, &out)
	if out.Result.IsError {
		e.t.Fatalf("%s: %s", tool, out.Result.Content[0].Text)
	}
	var v map[string]any
	_ = json.Unmarshal([]byte(out.Result.Content[0].Text), &v)
	return v
}

func TestAgentsUseTheBoard(t *testing.T) {
	e := newTaskEnv(t)
	agent := e.createAgent("helper")
	created := e.mcpCall(agent.ID, "create_task", map[string]any{
		"title": "Proofread the report", "assignee": map[string]any{"kind": "user"},
	})
	expect(t, fmt.Sprint(created["number"]), "1")
	e.mcpCall(agent.ID, "comment_task", map[string]any{"task": "1", "body": "Two typos on page 3."})
	task := e.task("1")
	expect(t, task.CreatedBy.Kind, "agent")
	expect(t, *task.CreatedBy.AgentName, "helper")
	expect(t, task.Activity[len(task.Activity)-1].Actor.Kind, "agent")
	list := e.mcpCall(agent.ID, "list_tasks", map[string]any{})
	expect(t, len(list["tasks"].([]any)), 1)
}
