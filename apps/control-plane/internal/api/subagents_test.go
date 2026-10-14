package api

import (
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

// A Paseo agent idle while its provider subagents run has not ended its
// turn: its run stays running, it is not reminded, and the task's next run
// waits. The run ends as before once they have all ended.

func sub(id, parent, status string) map[string]any {
	s := map[string]any{"id": id, "status": status, "parentSubagentId": nil}
	if parent != "" {
		s["parentSubagentId"] = parent
	}
	return s
}

func (f *fakeRelay) setSubagents(id string, subs ...map[string]any) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.agents[id].subagents = subs
}

func (f *fakeRelay) setStatus(id, status string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.agents[id].status = status
}

func (f *fakeRelay) inputs(id string) []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.agents[id].inputs...)
}

// subagentEnv is a task whose run was sent to a Paseo agent, with the
// runner's clock in the test's hands.
type subagentEnv struct {
	*taskEnv
	agent, token string
	now          time.Time
}

func newSubagentEnv(t *testing.T) *subagentEnv {
	e := &subagentEnv{taskEnv: newTaskEnv(t), now: time.Now()}
	e.runner.Now = func() time.Time { return e.now }
	computer, token := e.computer("laptop", "paseo")
	e.create(remoteAssignee(computer, "paseo", newWorktree))
	e.runner.Tick(e.ctx)
	e.agent, _ = e.relay.only(t)
	e.token = token
	return e
}

func (e *subagentEnv) tick(d time.Duration) {
	e.now = e.now.Add(d)
	e.runner.Tick(e.ctx)
}

func (e *subagentEnv) comment(body string) {
	e.t.Helper()
	if r := e.remote(e.token, http.MethodPost, "/tasks/"+e.task("1").ID+"/comments", map[string]any{"body": body}); r.status != 204 {
		e.t.Fatalf("comment: %d %s", r.status, r.body)
	}
}

// running checks the task's first run is still running, unreminded, its
// agent sent only the brief, and the task list shows it at work.
func (e *subagentEnv) running(t *testing.T) {
	t.Helper()
	task := e.task("1")
	run := task.Runs[0]
	if run.Status != "running" || run.Nudged {
		t.Fatalf("run %s nudged %v: %s", run.Status, run.Nudged, kinds(task))
	}
	if strings.Contains(kinds(task), "run_completed") || len(e.relay.inputs(e.agent)) != 1 {
		t.Fatalf("ended early: %s, inputs %q", kinds(task), e.relay.inputs(e.agent))
	}
	var list struct {
		Tasks []struct {
			RunStatus *string `json:"run_status"`
		} `json:"tasks"`
	}
	e.get("/tasks").json(t, &list)
	if len(list.Tasks) != 1 || list.Tasks[0].RunStatus == nil || *list.Tasks[0].RunStatus != "running" {
		t.Fatalf("task list %+v", list.Tasks)
	}
}

func TestAnIdlePaseoAgentWithRunningSubagentsIsStillAtWork(t *testing.T) {
	e := newSubagentEnv(t)
	e.comment("Started two reviewers; waiting for them.")
	// One finished, one running with a nested one of its own, listed twice.
	e.relay.setSubagents(e.agent, sub("a", "", "completed"), sub("b", "", "running"),
		sub("c", "b", "running"), sub("c", "b", "running"))
	e.relay.finish(e.agent)
	e.tick(time.Second)
	e.running(t)
	e.tick(time.Hour)
	e.running(t)

	// The nested one still runs after its parent subagent ended.
	e.relay.setSubagents(e.agent, sub("a", "", "completed"), sub("b", "", "completed"), sub("c", "b", "running"))
	e.tick(time.Minute)
	e.running(t)

	// All ended: a moment for the agent to take up their results, then the
	// turn ends as it would have. It commented, so the run completes; the
	// task is not moved on for it.
	e.relay.setSubagents(e.agent, sub("a", "", "completed"), sub("b", "", "failed"), sub("c", "b", "canceled"))
	e.tick(time.Second)
	e.running(t)
	e.tick(20 * time.Second)
	task := e.task("1")
	expect(t, task.Runs[0].Status, "completed")
	expect(t, task.Status, "in_progress")
}

func TestTheNextRunWaitsForAnAgentsSubagents(t *testing.T) {
	e := newSubagentEnv(t)
	e.relay.setSubagents(e.agent, sub("a", "", "running"))
	e.relay.finish(e.agent)
	e.tick(time.Second)
	// A comment queues the next run, which waits for this one.
	e.post("/tasks/"+e.task("1").ID+"/comments", map[string]any{"body": "Also check Firefox."})
	e.tick(time.Second)
	e.tick(time.Second)
	task := e.task("1")
	expect(t, task.Runs[0].Status, "running")
	expect(t, task.Runs[1].Status, "queued")
	expect(t, len(e.relay.inputs(e.agent)), 1)
}

// The agent woke up again after its run was over (as runs ended early
// before this check did): the next run is not sent into its work.
func TestARunIsNotSentToAnAgentStillAtWorkFromAnEndedRun(t *testing.T) {
	e := newSubagentEnv(t)
	e.comment("Done.")
	e.relay.finish(e.agent)
	e.tick(time.Second)
	expect(t, e.task("1").Runs[0].Status, "completed")

	e.relay.setSubagents(e.agent, sub("a", "", "running"))
	e.post("/tasks/"+e.task("1").ID+"/comments", map[string]any{"body": "Also check Firefox."})
	e.tick(time.Second)
	e.tick(time.Second)
	expect(t, e.task("1").Runs[1].Status, "starting")
	expect(t, len(e.relay.inputs(e.agent)), 1)

	e.relay.setSubagents(e.agent)
	e.relay.setStatus(e.agent, "running")
	e.tick(time.Second)
	expect(t, len(e.relay.inputs(e.agent)), 1)

	e.relay.setStatus(e.agent, "idle")
	e.tick(time.Second)
	expect(t, e.task("1").Runs[1].Status, "running")
	if in := e.relay.inputs(e.agent); len(in) != 2 || !strings.Contains(in[1], "Also check Firefox.") {
		t.Fatalf("inputs %q", in)
	}
}

// No subagents of its own: another agent's in the same workspace do not
// count, and the turn ends at once as before.
func TestOnlyTheRunsOwnAgentsSubagentsCount(t *testing.T) {
	e := newSubagentEnv(t)
	e.relay.mu.Lock()
	e.relay.agents[uuid.NewString()] = &fakeAgent{workspace: e.relay.agents[e.agent].workspace, status: "idle",
		subagents: []map[string]any{sub("x", "", "running")}}
	e.relay.mu.Unlock()
	e.relay.setSubagents(e.agent, sub("a", "", "completed"))
	e.relay.finish(e.agent)
	e.tick(time.Second)
	run := e.task("1").Runs[0]
	expect(t, run.Status, "running")
	expect(t, run.Nudged, true)
}

// A subagent Paseo never saw end holds the turn for a while, not forever.
func TestAStaleRunningSubagentHoldsTheTurnForAWhile(t *testing.T) {
	e := newSubagentEnv(t)
	e.relay.setSubagents(e.agent, sub("a", "", "running"))
	e.relay.finish(e.agent)
	e.tick(time.Second)
	e.running(t)
	e.tick(119 * time.Minute)
	e.running(t)
	e.tick(2 * time.Minute)
	expect(t, e.task("1").Runs[0].Nudged, true)
}

func TestSubagentsThatCannotBeRead(t *testing.T) {
	// A connector before paseo.agents.subagents, or a Paseo daemon that does
	// not track subagents: the turn ends as it did before.
	for _, code := range []string{"unsupported_method", "unsupported_capability"} {
		t.Run(code, func(t *testing.T) {
			e := newSubagentEnv(t)
			e.relay.subagentsFailing = code
			e.relay.finish(e.agent)
			e.tick(time.Second)
			expect(t, e.task("1").Runs[0].Nudged, true)
		})
	}
	// A failed read is not "none": the turn is held, for a while.
	t.Run("failed", func(t *testing.T) {
		e := newSubagentEnv(t)
		e.relay.subagentsFailing = "native_error"
		e.relay.finish(e.agent)
		e.tick(time.Second)
		e.running(t)
		e.tick(9 * time.Minute)
		e.running(t)
		e.tick(2 * time.Minute)
		expect(t, e.task("1").Runs[0].Nudged, true)
	})
	t.Run("failed then running", func(t *testing.T) {
		e := newSubagentEnv(t)
		e.relay.subagentsFailing = "native_error"
		e.relay.finish(e.agent)
		e.tick(time.Second)
		e.tick(9 * time.Minute)
		e.relay.subagentsFailing = ""
		e.relay.setSubagents(e.agent, sub("a", "", "running"))
		e.tick(5 * time.Minute)
		e.running(t)
	})
}

// The agent's own error or a stop ends the run whatever its subagents do.
func TestAnErrorOrAStopEndsTheRunDespiteSubagents(t *testing.T) {
	t.Run("error", func(t *testing.T) {
		e := newSubagentEnv(t)
		e.relay.setSubagents(e.agent, sub("a", "", "running"))
		e.relay.finish(e.agent)
		e.tick(time.Second)
		e.relay.setStatus(e.agent, "error")
		e.tick(time.Second)
		expect(t, e.task("1").Runs[0].Status, "failed")
	})
	t.Run("stop", func(t *testing.T) {
		e := newSubagentEnv(t)
		e.relay.setSubagents(e.agent, sub("a", "", "running"))
		e.relay.finish(e.agent)
		e.tick(time.Second)
		run := e.task("1").Runs[0]
		if r := e.post("/tasks/1/runs/"+run.ID+"/interrupt", nil); r.status != 200 {
			t.Fatalf("interrupt: %d %s", r.status, r.body)
		}
		e.tick(time.Second)
		expect(t, e.task("1").Runs[0].Status, "cancelled")
	})
}

// A review asked for after the assignee's run does not start while that
// run's agent is idle but its subagents still run.
func TestAnAssistWaitsForTheAssigneesSubagents(t *testing.T) {
	e := newSubagentEnv(t)
	task := e.task("1")
	e.assist(task.ID, map[string]any{"runtime": "paseo", "provider": "codex", "request": "Run the tests.", "after_run": "current"})
	e.comment("Started a subagent for the tests.")
	e.relay.setSubagents(e.agent, sub("a", "", "running"))
	e.relay.finish(e.agent)
	e.tick(time.Second)
	e.tick(time.Minute)
	e.running(t)
	task = e.task("1")
	expect(t, task.Assists[0].State, "waiting")
	expect(t, len(runsOf(task, true)), 0)
	expect(t, len(e.relay.agents), 1)

	e.relay.setSubagents(e.agent, sub("a", "", "completed"))
	e.tick(time.Second)
	e.tick(20 * time.Second)
	e.tick(time.Second)
	task = e.task("1")
	expect(t, runsOf(task, false)[0].Status, "completed")
	expect(t, task.Assists[0].State, "started")
	expect(t, len(e.relay.agents), 2)
}
