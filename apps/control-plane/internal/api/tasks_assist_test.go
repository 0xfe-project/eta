package api

import (
	"net/http"
	"net/url"
	"slices"
	"strings"
	"testing"

	"github.com/akarachen/axp/apps/control-plane/internal/tasks"
)

// remoteIn is a CLI call from dir, as the CLI sends it.
func (e *taskEnv) remoteIn(token, dir, method, path string, body any) response {
	return do(e.t, e.public, method, "/remote/v1"+path, body, map[string]string{
		"Authorization": "Bearer " + token, "X-Working-Dir": url.PathEscape(dir),
	})
}

// agentIn is the Paseo agent working in dir.
func (f *fakeRelay) agentIn(t *testing.T, dir string) (string, *fakeAgent) {
	t.Helper()
	f.mu.Lock()
	defer f.mu.Unlock()
	for id, a := range f.agents {
		if a.cwd == dir {
			return id, a
		}
	}
	t.Fatalf("no agent in %s", dir)
	return "", nil
}

// otherAgent is the one Paseo agent not in dir.
func (f *fakeRelay) otherAgent(t *testing.T, dir string) (string, *fakeAgent) {
	t.Helper()
	f.mu.Lock()
	defer f.mu.Unlock()
	for id, a := range f.agents {
		if a.cwd != dir {
			return id, a
		}
	}
	t.Fatalf("no agent outside %s", dir)
	return "", nil
}

func runsOf(task tasks.TaskDetail, assist bool) []tasks.TaskRun {
	var out []tasks.TaskRun
	for _, r := range task.Runs {
		if r.Assist == assist {
			out = append(out, r)
		}
	}
	return out
}

const headSHA = "0123456789abcdef0123456789abcdef01234567"

// Claude works on the task; Codex on the same computer reviews its pull
// request beside it, in a worktree of its own, at the head the user saw.
// The task's status, assignee and Claude's run stay as they are, and
// nothing Codex says reaches Claude.
func TestAnotherAgentReviewsBesideTheAssignee(t *testing.T) {
	e := newTaskEnv(t)
	computer, token := e.computer("laptop", "paseo")
	task := e.create(remoteAssignee(computer, "paseo", newWorktree))
	e.runner.Tick(e.ctx)
	mainID, main := e.relay.only(t)
	mainDir := main.cwd
	pr := "https://github.com/acme/web/pull/7"
	if r := e.remoteIn(token, mainDir, http.MethodPost, "/tasks/"+task.ID+"/deliverables",
		map[string]any{"kind": "pull_request", "url": pr}); r.status != 204 {
		t.Fatalf("deliverable: %d %s", r.status, r.body)
	}

	ask := map[string]any{"runtime": "paseo", "provider": "codex", "request": "Review the PR for Safari regressions.",
		"pull": map[string]any{"url": pr, "head_sha": headSHA}}
	r := e.post("/tasks/"+task.ID+"/assists", ask, "assist-1")
	if r.status != 201 {
		t.Fatalf("assist: %d %s", r.status, r.body)
	}
	// The same request again is the same assist.
	if r := e.post("/tasks/"+task.ID+"/assists", ask, "assist-1"); r.status != 201 {
		t.Fatalf("assist again: %d %s", r.status, r.body)
	}
	task = e.task("1")
	expect(t, len(runsOf(task, true)), 1)
	asked := task.Activity[len(task.Activity)-1]
	expect(t, asked.Kind, "assist")
	expect(t, *asked.Body, "Review the PR for Safari regressions.")
	expect(t, asked.Data["provider"], any("codex"))

	// It starts beside Claude's running turn.
	e.runner.Tick(e.ctx)
	e.runner.Tick(e.ctx)
	expect(t, len(e.relay.agents), 2)
	_, codex := e.relay.otherAgent(t, mainDir)
	if codex.cwd == mainDir || !strings.Contains(codex.cwd, "axp-1-assist-") {
		t.Fatalf("assist works in %q", codex.cwd)
	}
	expect(t, e.relay.sources[len(e.relay.sources)-1]["projectId"], any("prj_web"))
	brief := codex.inputs[0]
	for _, want := range []string{"Review the PR for Safari regressions.", "已确认", pr, headSHA, "git checkout --detach " + headSHA,
		"任务 #1：Fix the login page", "不是这次的要求", "主执行者", "不要用 `axp task status`"} {
		if !strings.Contains(brief, want) {
			t.Fatalf("assist brief lacks %q: %s", want, brief)
		}
	}
	task = e.task("1")
	expect(t, task.Status, "in_progress")
	expect(t, task.Assignee.Provider != nil && *task.Assignee.Provider == "claude", true)
	expect(t, *task.RunStatus, "running")
	expect(t, runsOf(task, false)[0].Status, "running")
	expect(t, runsOf(task, true)[0].Status, "running")
	expect(t, len(main.inputs), 1)

	// Codex replies from its worktree, as itself; it cannot set the status.
	if r := e.remoteIn(token, codex.cwd, http.MethodPost, "/tasks/"+task.ID+"/comments",
		map[string]any{"body": "LGTM except the Safari flex gap."}); r.status != 204 {
		t.Fatalf("assist comment: %d %s", r.status, r.body)
	}
	if s, code := e.remoteIn(token, codex.cwd, http.MethodPost, "/tasks/"+task.ID+"/status",
		map[string]any{"status": "in_review"}).error(); s != 403 || code != "ASSISTING" {
		t.Fatalf("assist status: %d %s", s, code)
	}
	codexID, _ := e.relay.agentIn(t, codex.cwd)
	e.relay.finish(codexID)
	e.runner.Tick(e.ctx)
	task = e.task("1")
	assist := runsOf(task, true)[0]
	expect(t, assist.Status, "completed")
	reply := task.Activity[len(task.Activity)-1]
	for _, a := range task.Activity {
		if a.Kind == "comment" {
			reply = a
		}
	}
	expect(t, *reply.RunID, assist.ID)
	expect(t, reply.Data["provider"], any("codex"))
	expect(t, reply.Data["assist"], any(true))

	// Claude's turn is not ended by Codex's reply, nor sent it.
	expect(t, runsOf(task, false)[0].Status, "running")
	expect(t, task.Status, "in_progress")
	expect(t, len(main.inputs), 1)
	e.relay.finish(mainID)
	e.runner.Tick(e.ctx)
	if run := runsOf(e.task("1"), false)[0]; !run.Nudged {
		t.Fatalf("Claude's turn ended by Codex's reply: %+v", run)
	}

	// Asked about its answer, the same Codex agent continues.
	e.post("/tasks/"+task.ID+"/assists", map[string]any{"runtime": "paseo", "provider": "codex", "request": "Which line?"})
	e.runner.Tick(e.ctx)
	e.runner.Tick(e.ctx)
	expect(t, len(e.relay.agents), 2)
	if len(codex.inputs) != 2 || !strings.Contains(codex.inputs[1], "Which line?") || !strings.Contains(codex.inputs[1], "没有指定要看的 PR") {
		t.Fatalf("assist follow-up %q", codex.inputs)
	}

	// A comment of the user's still goes to Claude only.
	e.remoteIn(token, mainDir, http.MethodPost, "/tasks/"+task.ID+"/comments", map[string]any{"body": "Working on it."})
	e.relay.finish(mainID)
	e.runner.Tick(e.ctx)
	e.post("/tasks/"+task.ID+"/comments", map[string]any{"body": "Please fix what Codex found."})
	e.runner.Tick(e.ctx)
	e.runner.Tick(e.ctx)
	if len(main.inputs) != 3 || !strings.Contains(main.inputs[2], "Please fix what Codex found.") {
		t.Fatalf("Claude's inputs %q", main.inputs)
	}
	expect(t, len(codex.inputs), 2)

	// Done: the assist's worktree is archived with the task's.
	e.patch("/tasks/1", map[string]any{"status": "done"})
	e.runner.Tick(e.ctx)
	archived := 0
	for _, c := range e.relay.calls {
		if c == "paseo.workspaces.archive" {
			archived++
		}
	}
	expect(t, archived, 2)
}

// An assist stops, fails and waits for its computer on its own; the
// assignee's run goes on.
func TestAnAssistStopsAndFailsOnItsOwn(t *testing.T) {
	e := newTaskEnv(t)
	computer, _ := e.computer("laptop", "paseo")
	e.create(remoteAssignee(computer, "paseo", map[string]any{"kind": "workspace", "workspace_id": "wks_main"}))
	e.runner.Tick(e.ctx)
	ask := map[string]any{"runtime": "paseo", "provider": "codex", "request": "Run the tests."}
	e.post("/tasks/1/assists", ask)
	e.runner.Tick(e.ctx)
	e.runner.Tick(e.ctx)
	// From an existing workspace, the assist branches off its project.
	_, codex := e.relay.otherAgent(t, "/home/u/web")
	if !strings.Contains(codex.cwd, "axp-1-assist-") {
		t.Fatalf("assist works in %q", codex.cwd)
	}

	// The computer goes offline: the assist waits, then carries on.
	e.relay.failing = "device_offline"
	e.runner.Tick(e.ctx)
	e.relay.failing = ""
	expect(t, runsOf(e.task("1"), true)[0].Status, "running")

	// Stopped, the assist ends; the assignee's run does not.
	assist := runsOf(e.task("1"), true)[0]
	if r := e.post("/tasks/1/runs/"+assist.ID+"/interrupt", nil); r.status != 200 {
		t.Fatalf("interrupt: %d %s", r.status, r.body)
	}
	e.runner.Tick(e.ctx)
	task := e.task("1")
	expect(t, runsOf(task, true)[0].Status, "cancelled")
	expect(t, runsOf(task, false)[0].Status, "running")
	expect(t, task.Status, "in_progress")

	// One that cannot open fails alone.
	e.relay.mu.Lock()
	e.relay.workspaces["wks_main"].archived = true
	e.relay.mu.Unlock()
	e.post("/tasks/1/assists", map[string]any{"runtime": "paseo", "provider": "claude", "request": "Look again."})
	e.runner.Tick(e.ctx)
	e.runner.Tick(e.ctx)
	task = e.task("1")
	failed := runsOf(task, true)[1]
	expect(t, failed.Status, "failed")
	if failed.Error == nil || !strings.Contains(*failed.Error, "协助") {
		t.Fatalf("error %v", failed.Error)
	}
	expect(t, runsOf(task, false)[0].Status, "running")
	expect(t, task.Status, "in_progress")
}

func TestAssistingNeedsTheTasksComputerAndAnAgentThere(t *testing.T) {
	e := newTaskEnv(t)
	computer, _ := e.computer("laptop", "paseo")
	e.post("/tasks", map[string]any{"title": "Mine", "assignee": map[string]any{"kind": "user"}})
	ask := map[string]any{"runtime": "paseo", "provider": "codex", "request": "Review it."}
	if s, code := e.post("/tasks/1/assists", ask).error(); s != 409 || code != "TASK_NOT_REMOTE" {
		t.Fatalf("not remote: %d %s", s, code)
	}
	e.create(remoteAssignee(computer, "paseo", newWorktree))
	if s, _ := e.post("/tasks/2/assists", map[string]any{"runtime": "herdr", "provider": "codex", "request": "x"}).error(); s != 422 {
		t.Fatalf("a runtime the computer lacks: %d", s)
	}
	if s, _ := e.post("/tasks/2/assists", map[string]any{"runtime": "paseo", "provider": "codex", "request": "x",
		"pull": map[string]any{"url": "https://github.com/acme/other/pull/1"}}).error(); s != 422 {
		t.Fatalf("a pull request the task did not deliver: %d", s)
	}
	e.patch("/tasks/2", map[string]any{"status": "done"})
	if s, code := e.post("/tasks/2/assists", ask).error(); s != 409 || code != "TASK_FINISHED" {
		t.Fatalf("done: %d %s", s, code)
	}
}

// In Herdr the assist gets a worktree and tab of its own, off the
// workspace the assignee works in.
func TestHerdrAssistsInAWorktreeOfItsOwn(t *testing.T) {
	e := newTaskEnv(t)
	computer, _ := e.computer("desktop", "herdr")
	task := e.create(remoteAssignee(computer, "herdr", map[string]any{"kind": "workspace", "workspace_id": "w1", "session": "work"}))
	e.runner.Tick(e.ctx)
	e.post("/tasks/1/assists", map[string]any{"runtime": "herdr", "provider": "codex", "request": "Review it."})
	e.runner.Tick(e.ctx)
	e.runner.Tick(e.ctx)
	workspaces := []string{}
	for _, tab := range e.relay.tabs {
		workspaces = append(workspaces, tab.workspace)
		expect(t, tab.env["AXP_TASK_ID"], any(task.ID))
	}
	slices.Sort(workspaces)
	if !slices.Equal(workspaces, []string{"w1", "w2"}) || !slices.Contains(e.relay.calls, "worktree.create") {
		t.Fatalf("tabs in %v, calls %v", workspaces, e.relay.calls)
	}
	task = e.task("1")
	expect(t, runsOf(task, true)[0].Status, "running")
	expect(t, runsOf(task, false)[0].Status, "running")
}
