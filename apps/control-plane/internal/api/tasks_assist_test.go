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

// mcpError is a tool call's error, which the agent sees.
func (e *taskEnv) mcpError(agentID, tool string, args map[string]any) (string, bool) {
	e.t.Helper()
	body := map[string]any{"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": map[string]any{"name": tool, "arguments": args}}
	r := do(e.t, e.internal, http.MethodPost, "/tasks/mcp", body, map[string]string{
		"X-AXP-Agent-Id": agentID, "Accept": "application/json, text/event-stream",
	})
	var res struct {
		Result struct {
			IsError bool `json:"isError"`
			Content []struct {
				Text string `json:"text"`
			} `json:"content"`
		} `json:"result"`
	}
	r.json(e.t, &res)
	if !res.Result.IsError || len(res.Result.Content) == 0 {
		return "", false
	}
	return res.Result.Content[0].Text, true
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

func (e *taskEnv) ticks(n int) {
	for range n {
		e.runner.Tick(e.ctx)
	}
}

func (e *taskEnv) assist(task string, body map[string]any) tasks.TaskDetail {
	e.t.Helper()
	r := e.post("/tasks/"+task+"/assists", body)
	if r.status != 201 {
		e.t.Fatalf("assist: %d %s", r.status, r.body)
	}
	var t tasks.TaskDetail
	r.json(e.t, &t)
	return t
}

// reply is the agent in dir commenting and ending its turn.
func (e *taskEnv) reply(token, dir, taskID, body string) {
	e.t.Helper()
	if r := e.remoteIn(token, dir, http.MethodPost, "/tasks/"+taskID+"/comments", map[string]any{"body": body}); r.status != 204 {
		e.t.Fatalf("comment: %d %s", r.status, r.body)
	}
	id, _ := e.relay.agentIn(e.t, dir)
	e.relay.finish(id)
}

func (e *taskEnv) review(token, dir, taskID, verdict, feedback string) response {
	return e.remoteIn(token, dir, http.MethodPost, "/tasks/"+taskID+"/review", map[string]any{"verdict": verdict, "feedback": feedback})
}

const (
	headSHA  = "0123456789abcdef0123456789abcdef01234567"
	headSHA2 = "89abcdef0123456789abcdef0123456789abcdef"
	pullURL  = "https://github.com/acme/web/pull/7"
)

// claudeAtWork is a task Claude works on in a new worktree, running, and
// the computer's token and Claude's directory.
func (e *taskEnv) claudeAtWork() (tasks.TaskDetail, string, string) {
	e.t.Helper()
	computer, token := e.computer("laptop", "paseo")
	task := e.create(remoteAssignee(computer, "paseo", newWorktree))
	e.ticks(1)
	_, main := e.relay.only(e.t)
	return task, token, main.cwd
}

func (e *taskEnv) deliver(token, dir, taskID string) {
	e.t.Helper()
	if r := e.remoteIn(token, dir, http.MethodPost, "/tasks/"+taskID+"/deliverables",
		map[string]any{"kind": "pull_request", "url": pullURL}); r.status != 204 {
		e.t.Fatalf("deliverable: %d %s", r.status, r.body)
	}
}

// Claude works on the task; Codex on the same computer reviews its pull
// request beside it, in a worktree of its own, at the head GitHub has. The
// task's status, assignee and Claude's run stay as they are, and nothing
// Codex says reaches Claude.
func TestAnotherAgentReviewsBesideTheAssignee(t *testing.T) {
	e := newTaskEnv(t)
	task, token, mainDir := e.claudeAtWork()
	mainID, main := e.relay.agentIn(t, mainDir)
	e.deliver(token, mainDir, task.ID)
	e.heads[pullURL] = headSHA

	ask := map[string]any{"runtime": "paseo", "provider": "codex", "request": "Review the PR for Safari regressions.", "key": "assist-1"}
	e.assist(task.ID, ask)
	// The same key again is the same request.
	task = e.assist(task.ID, ask)
	expect(t, len(task.Assists), 1)
	expect(t, task.Assists[0].State, "waiting")
	asked := task.Activity[len(task.Activity)-1]
	expect(t, asked.Kind, "assist")
	expect(t, *asked.Body, "Review the PR for Safari regressions.")
	expect(t, asked.Data["agent"].(map[string]any)["provider"], any("codex"))

	// It starts beside Claude's running turn, pinned at the PR's head.
	e.ticks(2)
	expect(t, len(e.relay.agents), 2)
	_, codex := e.relay.otherAgent(t, mainDir)
	if !strings.Contains(codex.cwd, "axp-1-assist-") {
		t.Fatalf("assist works in %q", codex.cwd)
	}
	expect(t, e.relay.sources[len(e.relay.sources)-1]["projectId"], any("prj_web"))
	brief := codex.inputs[0]
	for _, want := range []string{"Review the PR for Safari regressions.", "已确认", pullURL, "git checkout --detach " + headSHA,
		"任务 #1：Fix the login page", "不是这次的要求", "主执行者", "不要用 `axp task status`", "axp task review"} {
		if !strings.Contains(brief, want) {
			t.Fatalf("assist brief lacks %q: %s", want, brief)
		}
	}
	task = e.task("1")
	expect(t, task.Assists[0].State, "started")
	expect(t, *task.Assists[0].HeadSHA, headSHA)
	expect(t, task.Status, "in_progress")
	expect(t, *task.Assignee.Provider, "claude")
	expect(t, *task.RunStatus, "running")
	expect(t, runsOf(task, true)[0].Status, "running")
	expect(t, len(main.inputs), 1)

	// Codex replies from its worktree, as itself; it cannot set the status.
	e.reply(token, codex.cwd, task.ID, "LGTM except the Safari flex gap.")
	if s, code := e.remoteIn(token, codex.cwd, http.MethodPost, "/tasks/"+task.ID+"/status",
		map[string]any{"status": "in_review"}).error(); s != 403 || code != "ASSISTING" {
		t.Fatalf("assist status: %d %s", s, code)
	}
	e.ticks(1)
	task = e.task("1")
	assist := runsOf(task, true)[0]
	expect(t, assist.Status, "completed")
	var reply tasks.TaskActivity
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
	expect(t, len(main.inputs), 1)
	e.relay.finish(mainID)
	e.ticks(1)
	if run := runsOf(e.task("1"), false)[0]; !run.Nudged {
		t.Fatalf("Claude's turn ended by Codex's reply: %+v", run)
	}

	// Asked about its answer, the same Codex agent continues.
	e.assist(task.ID, map[string]any{"runtime": "paseo", "provider": "codex", "request": "Which line?"})
	e.ticks(2)
	expect(t, len(e.relay.agents), 2)
	if len(codex.inputs) != 2 || !strings.Contains(codex.inputs[1], "Which line?") {
		t.Fatalf("assist follow-up %q", codex.inputs)
	}

	// A comment of the user's still goes to Claude only.
	e.reply(token, mainDir, task.ID, "Working on it.")
	e.ticks(1)
	e.post("/tasks/"+task.ID+"/comments", map[string]any{"body": "Please fix what Codex found."})
	e.ticks(2)
	if len(main.inputs) != 3 || !strings.Contains(main.inputs[2], "Please fix what Codex found.") {
		t.Fatalf("Claude's inputs %q", main.inputs)
	}
	expect(t, len(codex.inputs), 2)

	// Done: the assist's worktree is archived with the task's.
	e.patch("/tasks/1", map[string]any{"status": "done"})
	e.ticks(1)
	archived := 0
	for _, c := range e.relay.calls {
		if c == "paseo.workspaces.archive" {
			archived++
		}
	}
	expect(t, archived, 2)
}

// A review asked for while Claude works waits for that run's delivery and
// the PR's head; one asked for after the run ended starts too. Requests
// start in the order asked, each a run and a brief of its own.
func TestAReviewWaitsForTheDeliveryItDependsOn(t *testing.T) {
	e := newTaskEnv(t)
	task, token, mainDir := e.claudeAtWork()
	e.assist(task.ID, map[string]any{"runtime": "paseo", "provider": "codex", "request": "Review it.", "after_run": "current"})
	e.ticks(2)
	task = e.task("1")
	expect(t, task.Assists[0].State, "waiting")
	expect(t, *task.Assists[0].Reason, "等主执行者这一轮完成并交付。")
	expect(t, len(e.relay.agents), 1)

	e.deliver(token, mainDir, task.ID)
	e.reply(token, mainDir, task.ID, "Done, PR opened.")
	e.ticks(2)
	// Delivered, but GitHub does not answer with the head yet.
	task = e.task("1")
	expect(t, runsOf(task, false)[0].Status, "completed")
	expect(t, task.Assists[0].State, "waiting")
	if !strings.Contains(*task.Assists[0].Reason, "读不到 PR 的 head") {
		t.Fatalf("reason %q", *task.Assists[0].Reason)
	}
	// A second request, made after the run ended, queues behind the first.
	e.assist(task.ID, map[string]any{"runtime": "paseo", "provider": "claude", "request": "Run the tests.", "after_run": "current"})
	e.heads[pullURL] = headSHA
	e.ticks(2)
	task = e.task("1")
	expect(t, task.Assists[0].State, "started")
	expect(t, task.Assists[1].State, "started")
	assists := runsOf(task, true)
	expect(t, assists[0].Status, "running")
	expect(t, assists[1].Status, "queued")
	_, codex := e.relay.otherAgent(t, mainDir)
	if len(codex.inputs) != 1 || !strings.Contains(codex.inputs[0], "Review it.") || strings.Contains(codex.inputs[0], "Run the tests.") {
		t.Fatalf("codex %q", codex.inputs)
	}
	e.reply(token, codex.cwd, task.ID, "Reviewed.")
	e.ticks(2)
	assists = runsOf(e.task("1"), true)
	expect(t, assists[0].Status, "completed")
	expect(t, assists[1].Status, "running")
	expect(t, len(e.relay.agents), 3)
	// The task's status is the assignee's.
	expect(t, e.task("1").Status, "in_progress")
}

// A delivery that failed or was stopped never starts the review; why is kept.
func TestAFailedDeliveryBlocksTheReview(t *testing.T) {
	e := newTaskEnv(t)
	task, _, mainDir := e.claudeAtWork()
	e.assist(task.ID, map[string]any{"runtime": "paseo", "provider": "codex", "request": "Review it.", "after_run": "current",
		"loop": map[string]any{}})
	mainID, _ := e.relay.agentIn(t, mainDir)
	// No reply: reminded once, then failed.
	e.relay.finish(mainID)
	e.ticks(1)
	e.relay.finish(mainID)
	e.ticks(2)
	task = e.task("1")
	expect(t, runsOf(task, false)[0].Status, "failed")
	expect(t, task.Assists[0].State, "blocked")
	if !strings.Contains(*task.Assists[0].Reason, "失败") {
		t.Fatalf("reason %q", *task.Assists[0].Reason)
	}
	expect(t, task.Loops[0].State, "blocked")
	expect(t, len(e.relay.agents), 1)

	// Stopped likewise.
	e.post("/tasks/1/comments", map[string]any{"body": "Try again."})
	e.ticks(2)
	run := runsOf(e.task("1"), false)[1]
	e.assist(task.ID, map[string]any{"runtime": "paseo", "provider": "claude", "request": "Test it.", "after_run": run.ID})
	e.post("/tasks/1/runs/"+run.ID+"/interrupt", nil)
	e.ticks(2)
	task = e.task("1")
	expect(t, task.Assists[1].State, "blocked")
	if !strings.Contains(*task.Assists[1].Reason, "停止") {
		t.Fatalf("reason %q", *task.Assists[1].Reason)
	}
}

// Without a pull request, a request starts once the run it waits for is
// done, and is told so; a review loop's round is blocked instead.
func TestWithoutAPullRequestOnlyALoopWaitsForOne(t *testing.T) {
	e := newTaskEnv(t)
	task, token, mainDir := e.claudeAtWork()
	e.assist(task.ID, map[string]any{"runtime": "paseo", "provider": "codex", "request": "Run the tests.", "after_run": "current"})
	e.assist(task.ID, map[string]any{"runtime": "paseo", "provider": "claude", "request": "Review it.", "after_run": "current", "loop": map[string]any{}})
	e.reply(token, mainDir, task.ID, "Done, no PR needed.")
	e.ticks(3)
	task = e.task("1")
	expect(t, task.Assists[0].State, "started")
	expect(t, task.Assists[0].PullURL == nil, true)
	expect(t, task.Assists[1].State, "blocked")
	expect(t, task.Loops[0].State, "blocked")
	_, codex := e.relay.otherAgent(t, mainDir)
	if !strings.Contains(codex.inputs[0], "Run the tests.") || !strings.Contains(codex.inputs[0], "还没有交付 PR") {
		t.Fatalf("brief %q", codex.inputs[0])
	}
}

// Codex asks for changes; Claude gets them in its own session as a run of
// their own, and Codex reviews the new head; a pass ends the loop. A
// verdict counts once, and only the round the loop waits for moves it.
func TestAReviewLoopReworksUntilItPasses(t *testing.T) {
	e := newTaskEnv(t)
	task, token, mainDir := e.claudeAtWork()
	_, main := e.relay.agentIn(t, mainDir)
	e.assist(task.ID, map[string]any{"runtime": "paseo", "provider": "codex", "request": "Review it strictly.",
		"after_run": "current", "loop": map[string]any{}, "key": "loop-1"})
	e.deliver(token, mainDir, task.ID)
	e.reply(token, mainDir, task.ID, "PR opened.")
	e.heads[pullURL] = headSHA
	e.ticks(2)
	_, codex := e.relay.otherAgent(t, mainDir)
	if !strings.Contains(codex.inputs[0], "第 1 轮（最多 3 轮）") || !strings.Contains(codex.inputs[0], headSHA) {
		t.Fatalf("round 1 brief %q", codex.inputs[0])
	}

	// A plain comment moves nothing; the structured verdict does, once.
	e.remoteIn(token, codex.cwd, http.MethodPost, "/tasks/"+task.ID+"/comments", map[string]any{"body": "Looking…"})
	if r := e.review(token, codex.cwd, task.ID, "changes_requested", ""); r.status != 422 {
		t.Fatalf("changes without feedback: %d", r.status)
	}
	for range 2 {
		if r := e.review(token, codex.cwd, task.ID, "changes_requested", "Fix the flex gap in login.css:12."); r.status != 204 {
			t.Fatalf("review: %d %s", r.status, r.body)
		}
	}
	if s, code := e.review(token, codex.cwd, task.ID, "pass", "").error(); s != 409 || code != "VERDICT_GIVEN" {
		t.Fatalf("another verdict: %d %s", s, code)
	}
	// Only an assisting agent reports verdicts.
	if s, _ := e.review(token, mainDir, task.ID, "pass", "").error(); s != 403 {
		t.Fatalf("assignee's verdict: %d", s)
	}
	codexID, _ := e.relay.agentIn(t, codex.cwd)
	e.relay.finish(codexID)
	e.ticks(2)
	task = e.task("1")
	expect(t, task.Loops[0].Rounds, 1)
	expect(t, task.Loops[0].State, "active")
	expect(t, runsOf(task, true)[0].Status, "completed")
	// Claude's session gets the changes.
	expect(t, len(e.relay.agents), 2)
	if len(main.inputs) != 2 || !strings.Contains(main.inputs[1], "Fix the flex gap in login.css:12.") ||
		!strings.Contains(main.inputs[1], headSHA) || !strings.Contains(main.inputs[1], "第 2 轮") {
		t.Fatalf("rework %q", main.inputs)
	}
	expect(t, task.Assists[1].State, "waiting")
	expect(t, *task.Assists[1].Round, 2)
	expect(t, *task.Assists[1].AfterRunID, runsOf(task, false)[1].ID)
	expect(t, task.Status, "in_progress")

	// The new head is reviewed once Claude's rework is done.
	e.heads[pullURL] = headSHA2
	e.reply(token, mainDir, task.ID, "Fixed and pushed.")
	e.ticks(2)
	if len(codex.inputs) != 2 || !strings.Contains(codex.inputs[1], "第 2 轮") || !strings.Contains(codex.inputs[1], headSHA2) {
		t.Fatalf("round 2 brief %q", codex.inputs)
	}
	if r := e.review(token, codex.cwd, task.ID, "pass", "Looks right now."); r.status != 204 {
		t.Fatalf("pass: %d %s", r.status, r.body)
	}
	e.relay.finish(codexID)
	e.ticks(2)
	task = e.task("1")
	expect(t, task.Loops[0].State, "passed")
	expect(t, task.Loops[0].Rounds, 2)
	expect(t, len(runsOf(task, false)), 2)
	expect(t, len(main.inputs), 2)
	expect(t, *task.Assists[1].Verdict, "pass")
	expect(t, task.Status, "in_progress")
	// The timeline has both verdicts, as Codex.
	verdicts := []string{}
	for _, a := range task.Activity {
		if a.Kind == "review" {
			verdicts = append(verdicts, a.Data["verdict"].(string))
			expect(t, a.Data["provider"], any("codex"))
		}
	}
	expect(t, strings.Join(verdicts, ","), "changes_requested,pass")
}

// A loop stops at its budget and waits for the user, who alone may raise
// it; agents cannot start another loop to reset it.
func TestAReviewLoopStopsWhenItsRoundsAreSpent(t *testing.T) {
	e := newTaskEnv(t)
	task, token, mainDir := e.claudeAtWork()
	e.deliver(token, mainDir, task.ID)
	e.heads[pullURL] = headSHA
	// Agents ask for at most the default budget.
	if s, code := e.remoteIn(token, mainDir, http.MethodPost, "/tasks/"+task.ID+"/assists", map[string]any{
		"runtime": "paseo", "provider": "codex", "request": "Review it.", "loop": map[string]any{"max_rounds": 5},
	}).error(); s != 403 || code != "ROUNDS_USER_ONLY" {
		t.Fatalf("agent's budget: %d %s", s, code)
	}
	// Claude asks for the review itself, through the CLI.
	if r := e.remoteIn(token, mainDir, http.MethodPost, "/tasks/"+task.ID+"/assists", map[string]any{
		"runtime": "paseo", "provider": "codex", "request": "Review it.", "after_run": "current", "loop": map[string]any{"max_rounds": 1},
	}); r.status != 204 {
		t.Fatalf("CLI assist: %d %s", r.status, r.body)
	}
	task = e.task("1")
	asked := task.Activity[len(task.Activity)-1]
	expect(t, asked.Actor.Kind, "remote")
	expect(t, asked.Data["provider"], any("claude"))
	e.reply(token, mainDir, task.ID, "PR opened.")
	e.ticks(2)
	_, codex := e.relay.otherAgent(t, mainDir)
	e.review(token, codex.cwd, task.ID, "changes_requested", "Rename the helper.")
	e.ticks(2)
	task = e.task("1")
	expect(t, task.Loops[0].State, "exhausted")
	expect(t, len(runsOf(task, false)), 1)
	expect(t, len(task.Assists), 1)

	if s, code := e.remoteIn(token, mainDir, http.MethodPost, "/tasks/"+task.ID+"/assists", map[string]any{
		"runtime": "paseo", "provider": "codex", "request": "Review again.", "after_run": "current", "loop": map[string]any{},
	}).error(); s != 409 || code != "LOOP_OPEN" {
		t.Fatalf("a new loop: %d %s", s, code)
	}
	agent := e.createAgent("helper")
	if out, _ := e.mcpError(agent.ID, "assist_task", map[string]any{"task": "1", "runtime": "paseo", "provider": "codex",
		"request": "Review again.", "loop": map[string]any{}}); !strings.Contains(out, "没有结束的审查循环") {
		t.Fatalf("tool's new loop: %s", out)
	}

	// The user raises the budget: the last changes go to Claude.
	loop := task.Loops[0].ID
	if r := e.post("/tasks/1/loops/"+loop+"/resume", map[string]any{"max_rounds": 2}); r.status != 200 {
		t.Fatalf("resume: %d %s", r.status, r.body)
	}
	e.ticks(2)
	task = e.task("1")
	expect(t, task.Loops[0].State, "active")
	expect(t, task.Loops[0].MaxRounds, 2)
	_, main := e.relay.agentIn(t, mainDir)
	if !strings.Contains(main.inputs[len(main.inputs)-1], "Rename the helper.") {
		t.Fatalf("rework %q", main.inputs)
	}
	// Stopped, its waiting round is cancelled.
	if r := e.post("/tasks/1/loops/"+loop+"/stop", nil); r.status != 200 {
		t.Fatalf("stop: %d %s", r.status, r.body)
	}
	task = e.task("1")
	expect(t, task.Loops[0].State, "stopped")
	expect(t, task.Assists[1].State, "cancelled")
	// Stopped, an agent cannot start a fresh budget; the user can.
	if s, code := e.remoteIn(token, mainDir, http.MethodPost, "/tasks/"+task.ID+"/assists", map[string]any{
		"runtime": "paseo", "provider": "codex", "request": "Review again.", "after_run": "current", "loop": map[string]any{},
	}).error(); s != 409 || code != "LOOP_USER_ONLY" {
		t.Fatalf("an agent's new loop after a stop: %d %s", s, code)
	}
	e.assist(task.ID, map[string]any{"runtime": "paseo", "provider": "codex", "request": "Review again.", "after_run": "current", "loop": map[string]any{}})
	expect(t, len(e.task("1").Loops), 2)
}

// A review that ends without a verdict blocks its loop; a new runner (a
// restart) carries on from the database; finishing the task cancels what
// has not started.
func TestAReviewLoopBlocksAndRecovers(t *testing.T) {
	e := newTaskEnv(t)
	task, token, mainDir := e.claudeAtWork()
	e.deliver(token, mainDir, task.ID)
	e.assist(task.ID, map[string]any{"runtime": "paseo", "provider": "codex", "request": "Review it.", "after_run": "current", "loop": map[string]any{}})
	e.reply(token, mainDir, task.ID, "PR opened.")
	e.ticks(1)
	expect(t, e.task("1").Assists[0].State, "waiting")

	// The controller restarts; the new runner starts the review once GitHub answers.
	e.runner = &tasks.Runner{DB: e.db, Service: e.runner.Service}
	e.heads[pullURL] = headSHA
	e.ticks(2)
	task = e.task("1")
	expect(t, task.Assists[0].State, "started")
	review := runsOf(task, true)[0]
	e.post("/tasks/1/runs/"+review.ID+"/interrupt", nil)
	e.ticks(2)
	task = e.task("1")
	expect(t, task.Loops[0].State, "blocked")
	if !strings.Contains(*task.Loops[0].Reason, "第 1 轮审查被停止") {
		t.Fatalf("reason %q", *task.Loops[0].Reason)
	}
	// The user carries on: the latest delivery is reviewed again.
	if r := e.post("/tasks/1/loops/"+task.Loops[0].ID+"/resume", nil); r.status != 200 {
		t.Fatalf("resume: %d %s", r.status, r.body)
	}
	e.post("/tasks/1/comments", map[string]any{"body": "One more thing."})
	e.ticks(2)
	task = e.task("1")
	expect(t, task.Assists[1].State, "waiting")
	expect(t, *task.Assists[1].Reason, "等主执行者手头的运行结束。")
	e.patch("/tasks/1", map[string]any{"status": "done"})
	task = e.task("1")
	expect(t, task.Assists[1].State, "cancelled")
	expect(t, task.Loops[0].State, "stopped")
}

// The tasks tool asks for assistance as the web does, and names the task
// for the transcript's card.
func TestAgentsAskForAssistanceWithTheTool(t *testing.T) {
	e := newTaskEnv(t)
	task, token, mainDir := e.claudeAtWork()
	agent := e.createAgent("helper")
	args := map[string]any{"task": "1", "runtime": "paseo", "provider": "codex", "request": "Review once it is delivered.",
		"after_run": "current", "loop": map[string]any{}, "key": "tool-1"}
	out, meta := e.mcpResult(agent.ID, "assist_task", args)
	e.mcpResult(agent.ID, "assist_task", args)
	expect(t, meta["axp/ref"].(map[string]any)["number"], any(float64(1)))
	expect(t, len(out["assists"].([]any)), 1)
	expect(t, len(out["loops"].([]any)), 1)
	activity := e.task("1").Activity
	asked := activity[len(activity)-1]
	expect(t, asked.Actor.Kind, "agent")
	expect(t, *asked.Actor.AgentName, "helper")

	e.deliver(token, mainDir, task.ID)
	e.heads[pullURL] = headSHA
	e.reply(token, mainDir, task.ID, "Done.")
	e.ticks(2)
	got := e.mcpCall(agent.ID, "get_task", map[string]any{"task": "1"})
	first := got["assists"].([]any)[0].(map[string]any)
	expect(t, first["state"], any("started"))
	expect(t, first["head_sha"], any(headSHA))
	out = e.mcpCall(agent.ID, "cancel_assist", map[string]any{"task": "1", "assist": first["id"]})
	expect(t, out["loops"].([]any)[0].(map[string]any)["state"], any("stopped"))
	e.ticks(1)
	expect(t, runsOf(e.task("1"), true)[0].Status, "cancelled")
}

// An assist stops, fails and waits for its computer on its own; the
// assignee's run goes on. From an existing Paseo workspace, the assist
// branches off its project.
func TestAnAssistStopsAndFailsOnItsOwn(t *testing.T) {
	e := newTaskEnv(t)
	computer, _ := e.computer("laptop", "paseo")
	e.create(remoteAssignee(computer, "paseo", map[string]any{"kind": "workspace", "workspace_id": "wks_main"}))
	e.ticks(1)
	e.assist("1", map[string]any{"runtime": "paseo", "provider": "codex", "request": "Run the tests."})
	e.ticks(2)
	_, codex := e.relay.otherAgent(t, "/home/u/web")
	if !strings.Contains(codex.cwd, "axp-1-assist-") {
		t.Fatalf("assist works in %q", codex.cwd)
	}

	// The computer goes offline: the assist waits, then carries on.
	e.relay.failing = "device_offline"
	e.ticks(1)
	e.relay.failing = ""
	expect(t, runsOf(e.task("1"), true)[0].Status, "running")

	// Stopped, the assist ends; the assignee's run does not.
	assist := runsOf(e.task("1"), true)[0]
	if r := e.post("/tasks/1/runs/"+assist.ID+"/interrupt", nil); r.status != 200 {
		t.Fatalf("interrupt: %d %s", r.status, r.body)
	}
	e.ticks(1)
	task := e.task("1")
	expect(t, runsOf(task, true)[0].Status, "cancelled")
	expect(t, runsOf(task, false)[0].Status, "running")
	expect(t, task.Status, "in_progress")

	// One that cannot open fails alone.
	e.relay.mu.Lock()
	e.relay.workspaces["wks_main"].archived = true
	e.relay.mu.Unlock()
	e.assist("1", map[string]any{"runtime": "paseo", "provider": "claude", "request": "Look again."})
	e.ticks(2)
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
	for _, bad := range []map[string]any{
		{"runtime": "herdr", "provider": "codex", "request": "x"},
		// A review loop needs a delivered pull request, or a delivery to wait for.
		{"runtime": "paseo", "provider": "codex", "request": "x", "loop": map[string]any{}},
		{"runtime": "paseo", "provider": "codex", "request": "x", "after_run": "nonsense"},
		{"runtime": "paseo", "provider": "codex", "request": "x", "after_run": "current", "loop": map[string]any{"max_rounds": 11}},
	} {
		if s, _ := e.post("/tasks/2/assists", bad).error(); s != 422 {
			t.Fatalf("%v: %d", bad, s)
		}
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
	e.ticks(1)
	e.assist("1", map[string]any{"runtime": "herdr", "provider": "codex", "request": "Review it."})
	e.ticks(2)
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
