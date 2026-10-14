package api

import (
	"fmt"
	"net/http"
	"strings"
	"testing"

	"github.com/akarachen/axp/apps/control-plane/internal/tasks"
)

// A computer works on at most its limit of runs at once (3 unless set):
// its assignees' and assisting agents', on every runtime. More wait in the
// queue, oldest first, and start as places free up.

func (e *taskEnv) setLimit(computer string, body any) response {
	return do(e.t, e.public, http.MethodPut, "/api/v1/computers/"+computer+"/limit", body, nil)
}

func (e *taskEnv) computerState(id string) tasks.Computer {
	e.t.Helper()
	var list tasks.Computers
	e.get("/computers").json(e.t, &list)
	for _, c := range list.Computers {
		if c.ID == id {
			return c
		}
	}
	e.t.Fatalf("no computer %s", id)
	return tasks.Computer{}
}

// worktreeDir is where Paseo opens task n's new worktree.
func worktreeDir(n int) string {
	return fmt.Sprintf("/home/u/.paseo/worktrees/x/axp-%d-fix-the-login-page", n)
}

// statuses are the tasks' assignee runs' latest statuses, by number.
func (e *taskEnv) statuses(n int) string {
	e.t.Helper()
	var out []string
	for i := 1; i <= n; i++ {
		out = append(out, *e.task(fmt.Sprint(i)).RunStatus)
	}
	return strings.Join(out, ",")
}

// active is how many runs hold the computer's places.
func (e *taskEnv) active(computer string) int {
	return scalar[int](e.env, "SELECT count(*) FROM task_run WHERE computer_id = $1 AND status IN ('starting', 'running')", computer)
}

func TestAComputersLimitIsThreeUntilSetToAPositiveNumber(t *testing.T) {
	e := newTaskEnv(t)
	laptop, _ := e.computer("laptop", "paseo")
	desktop, _ := e.computer("desktop", "paseo")
	expect(t, e.computerState(laptop).MaxActiveRuns, 3)

	for _, bad := range []any{
		map[string]any{"max_active_runs": 0}, map[string]any{"max_active_runs": -1}, map[string]any{"max_active_runs": 21},
		map[string]any{"max_active_runs": 1.5}, map[string]any{"max_active_runs": "2"}, map[string]any{},
	} {
		if r := e.setLimit(laptop, bad); r.status != 422 && r.status != 400 {
			t.Fatalf("%v: %d %s", bad, r.status, r.body)
		}
	}
	expect(t, e.computerState(laptop).MaxActiveRuns, 3)
	expect(t, e.setLimit("00000000-0000-0000-0000-000000000000", map[string]any{"max_active_runs": 2}).status, 404)

	expect(t, e.setLimit(laptop, map[string]any{"max_active_runs": 5}).status, 204)
	expect(t, e.computerState(laptop).MaxActiveRuns, 5)
	// Each computer has its own.
	expect(t, e.computerState(desktop).MaxActiveRuns, 3)
	// The database refuses what the API would.
	if _, err := e.db.Exec(e.ctx, "UPDATE computer SET max_active_runs = 0"); err == nil {
		t.Fatal("a limit of 0 was stored")
	}
}

// Over the limit, runs wait in the queue (never fail), say why, and start
// oldest first as places free up. Another computer is not held up.
func TestRunsOverAComputersLimitWaitAndStartInOrder(t *testing.T) {
	e := newTaskEnv(t)
	laptop, token := e.computer("laptop", "paseo")
	desktop, _ := e.computer("desktop", "paseo")
	for range 5 {
		e.create(remoteAssignee(laptop, "paseo", newWorktree))
	}
	e.ticks(2)
	expect(t, e.statuses(5), "running,running,running,queued,queued")
	waiting := e.task("4").Runs[0]
	if waiting.QueueReason == nil || !strings.Contains(*waiting.QueueReason, "「laptop」同时执行已满（3/3）") {
		t.Fatalf("queue reason %v", waiting.QueueReason)
	}
	c := e.computerState(laptop)
	expect(t, c.ActiveRuns, int64(3))
	expect(t, c.QueuedRuns, int64(2))

	// The desktop's runs start beside the full laptop.
	e.create(remoteAssignee(desktop, "paseo", map[string]any{"kind": "workspace", "workspace_id": "wks_main"}))
	e.ticks(1)
	expect(t, *e.task("6").RunStatus, "running")
	expect(t, e.task("6").Runs[0].QueueReason == nil, true)

	// Task 2 ends: the oldest waiting run, task 4's, takes its place
	// (at the tick after the one that saw it end).
	e.reply(token, worktreeDir(2), e.task("2").ID, "Done.")
	e.ticks(1)
	expect(t, e.statuses(5), "running,completed,running,queued,queued")
	e.ticks(1)
	expect(t, e.statuses(5), "running,completed,running,running,queued")
	expect(t, e.active(laptop), 3)
}

// Paseo and Herdr share a computer's places, and so do assisting agents
// (reviews included): one task cannot get past the limit by asking for
// help.
func TestRuntimesAndAssistingAgentsShareAComputersPlaces(t *testing.T) {
	e := newTaskEnv(t)
	laptop, token := e.computer("laptop", "paseo", "herdr")
	expect(t, e.setLimit(laptop, map[string]any{"max_active_runs": 2}).status, 204)
	e.create(remoteAssignee(laptop, "paseo", newWorktree))
	e.create(remoteAssignee(laptop, "herdr", map[string]any{"kind": "worktree", "from": "w1", "session": "work", "branch": "feature"}))
	e.ticks(2)
	expect(t, e.statuses(2), "running,running")

	e.deliver(token, worktreeDir(1), e.task("1").ID)
	e.heads[pullURL] = headSHA
	e.assist("1", map[string]any{"runtime": "paseo", "provider": "codex", "request": "Review the PR."})
	e.ticks(1)
	e.create(remoteAssignee(laptop, "paseo", newWorktree))
	e.ticks(1)
	task := e.task("1")
	expect(t, task.Assists[0].State, "started")
	review := runsOf(task, true)[0]
	expect(t, review.Status, "queued")
	if review.QueueReason == nil || !strings.Contains(*review.QueueReason, "（2/2）") {
		t.Fatalf("queue reason %v", review.QueueReason)
	}
	expect(t, *e.task("3").RunStatus, "queued")
	expect(t, e.active(laptop), 2)

	// Claude's run ends: the review, queued first, starts; task 3 waits.
	e.reply(token, worktreeDir(1), task.ID, "PR opened.")
	e.ticks(2)
	expect(t, runsOf(e.task("1"), true)[0].Status, "running")
	expect(t, *e.task("3").RunStatus, "queued")
	expect(t, e.active(laptop), 2)
}

// Lowering the limit stops nothing: the runs go on, and no new one starts
// until fewer are active than the new limit. Raising it starts the queue's
// next runs at once.
func TestChangingTheLimitAppliesToTheNextRuns(t *testing.T) {
	e := newTaskEnv(t)
	laptop, token := e.computer("laptop", "paseo")
	for range 5 {
		e.create(remoteAssignee(laptop, "paseo", newWorktree))
	}
	e.ticks(1)
	expect(t, e.setLimit(laptop, map[string]any{"max_active_runs": 1}).status, 204)
	e.ticks(2)
	expect(t, e.statuses(5), "running,running,running,queued,queued")
	for _, call := range e.relay.calls {
		if call == "paseo.agents.cancel" {
			t.Fatalf("lowering the limit interrupted an agent: %v", e.relay.calls)
		}
	}
	reason := *e.task("4").Runs[0].QueueReason
	if !strings.Contains(reason, "（3/1）") {
		t.Fatalf("queue reason %q", reason)
	}

	e.reply(token, worktreeDir(1), e.task("1").ID, "Done.")
	e.reply(token, worktreeDir(2), e.task("2").ID, "Done.")
	e.ticks(2)
	expect(t, e.statuses(5), "completed,completed,running,queued,queued")

	expect(t, e.setLimit(laptop, map[string]any{"max_active_runs": 3}).status, 204)
	e.ticks(1)
	expect(t, e.statuses(5), "completed,completed,running,running,running")
}

// A run keeps its place while what became of it is not known: through an
// offline spell (it may still be working), and while its place is being
// opened even when it is stopped meanwhile.
func TestAPlaceIsHeldUntilTheRunIsKnownToHaveEnded(t *testing.T) {
	e := newTaskEnv(t)
	laptop, _ := e.computer("laptop", "paseo")
	expect(t, e.setLimit(laptop, map[string]any{"max_active_runs": 1}).status, 204)
	e.create(remoteAssignee(laptop, "paseo", newWorktree))
	e.ticks(1)
	e.create(remoteAssignee(laptop, "paseo", newWorktree))

	// Offline: the running one is not given up or moved, the next waits.
	e.relay.failing = "device_offline"
	e.ticks(3)
	expect(t, e.statuses(2), "running,queued")

	// Stopped: its place is free once the agent was interrupted.
	e.relay.failing = ""
	run := e.task("1").Runs[0]
	expect(t, e.post("/tasks/1/runs/"+run.ID+"/interrupt", nil).status, 200)
	expect(t, e.active(laptop), 1)
	e.ticks(1)
	expect(t, e.statuses(2), "cancelled,queued")

	// Task 2's run is stopped while its place is being opened: it keeps
	// the place until the opening returns, then is cancelled, never sent.
	e.create(remoteAssignee(laptop, "paseo", newWorktree))
	var during string
	e.relay.before = func(method string) {
		if method == "paseo.agents.create" {
			run := e.task("2").Runs[0]
			if r := e.post("/tasks/2/runs/"+run.ID+"/interrupt", nil); r.status != 200 {
				t.Errorf("interrupt: %d %s", r.status, r.body)
			}
			during = fmt.Sprintf("%s %d", e.task("2").Runs[0].Status, e.active(laptop))
		}
	}
	e.ticks(1)
	e.relay.before = nil
	expect(t, during, "starting 1")
	expect(t, e.statuses(3), "cancelled,cancelled,queued")
	e.ticks(1)
	expect(t, e.statuses(3), "cancelled,cancelled,running")
	_, agent := e.relay.agentIn(t, worktreeDir(2))
	expect(t, len(agent.inputs), 0)
}

// After a restart, runs the dead runner left mid-opening hold their place
// until the next tick settles them: failed, or cancelled when they were
// stopped meanwhile; never opened again.
func TestARestartSettlesRunsLeftMidOpening(t *testing.T) {
	e := newTaskEnv(t)
	laptop, _ := e.computer("laptop", "paseo")
	expect(t, e.setLimit(laptop, map[string]any{"max_active_runs": 2}).status, 204)
	for range 3 {
		e.create(remoteAssignee(laptop, "paseo", newWorktree))
	}
	e.exec(`UPDATE task_run SET status = 'starting', opening_at = now() WHERE task_id IN
		(SELECT id FROM task WHERE number IN (1, 2))`)
	run := e.task("2").Runs[0]
	expect(t, e.post("/tasks/2/runs/"+run.ID+"/interrupt", nil).status, 200)
	expect(t, e.statuses(3), "starting,starting,queued")
	expect(t, *e.task("3").Runs[0].QueueReason, "「laptop」同时执行已满（2/2），有运行结束后按排队先后开始。")

	e.ticks(1)
	expect(t, e.statuses(3), "failed,cancelled,queued")
	e.ticks(1)
	expect(t, e.statuses(3), "failed,cancelled,running")
	_, agent := e.relay.only(t)
	expect(t, agent.cwd, worktreeDir(3))
}
