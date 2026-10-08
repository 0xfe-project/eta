package tasks

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/akarachen/axp/apps/control-plane/internal/chat"
	"github.com/akarachen/axp/apps/control-plane/internal/relay"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// The runner moves runs along, in the controller process, on its own loop:
// relay calls take seconds and must not hold up the agents' runtimes.
//
//	queued     waits for the task's previous run and the computer's capacity
//	preparing  the daemon creates the workspace (it is told in its heartbeat)
//	starting   the native agent is opened (once per session) and sent the prompt
//	running    watched until its turn ends; then completed, reminded once to
//	           comment, or failed
//
// Writes to remote agents are never repeated: the time a prompt is handed to
// the relay is recorded first, and a lost confirmation is settled from the
// native state.

const (
	// A workspace the daemon has not prepared by then fails the run.
	prepareTimeout = 10 * time.Minute
	// An agent that shows no sign of the prompt by then never got it.
	deliveryTimeout = 2 * time.Minute
	// Without a native turn-end time (Herdr), idle this long after a send
	// counts as the end of the turn.
	settleAfter = 15 * time.Second
	callTimeout = 30 * time.Second
)

type Runner struct {
	DB      *pgxpool.Pool
	Service *Service
	// Runs seen working since their last send (for runtimes without a native
	// turn-end time).
	working map[string]bool
}

// Loop runs the steps every interval until ctx ends.
func (r *Runner) Loop(ctx context.Context, interval time.Duration) {
	for ctx.Err() == nil {
		r.Tick(ctx)
		select {
		case <-ctx.Done():
		case <-time.After(interval):
		}
	}
}

func (r *Runner) Tick(ctx context.Context) {
	if r.working == nil {
		r.working = map[string]bool{}
	}
	steps := []struct {
		name string
		run  func(context.Context) error
	}{
		{"dispatch_runs", r.dispatch},
		{"expire_preparing", r.expirePreparing},
		{"start_runs", r.start},
		{"watch_runs", r.watch},
	}
	for _, step := range steps {
		if err := step.run(ctx); err != nil {
			slog.ErrorContext(ctx, "Task runner step failed", "step", step.name, "error", err)
		}
	}
}

func (r *Runner) agents() (agents, bool) {
	if r.Service.Relay == nil {
		return agents{}, false
	}
	return agents{r.Service.Relay}, true
}

func (r *Runner) inTx(ctx context.Context, fn func(pgx.Tx) error) error {
	return pgx.BeginFunc(ctx, r.DB, fn)
}

func (r *Runner) fail(ctx context.Context, runID, message string) error {
	return r.inTx(ctx, func(tx pgx.Tx) error {
		run, err := chat.One[runRow](ctx, tx, "SELECT * FROM task_run WHERE id = $1 FOR UPDATE", runID)
		if err != nil || run == nil || run.FinishedAt != nil {
			return err
		}
		delete(r.working, runID)
		return finishRun(ctx, tx, run, RunFailed, &message)
	})
}

// dispatch moves the oldest queued run of each idle task on: straight to
// starting when its session already has a workspace, else to preparing.
func (r *Runner) dispatch(ctx context.Context) error {
	if r.Service.Relay == nil {
		return nil
	}
	queued, err := chat.All[runRow](ctx, r.DB, `SELECT DISTINCT ON (q.task_id) q.* FROM task_run q
		WHERE q.status = 'queued' AND NOT EXISTS (SELECT 1 FROM task_run a WHERE a.task_id = q.task_id
			AND a.status IN ('preparing', 'starting', 'running'))
		ORDER BY q.task_id, q.created_at`)
	if err != nil {
		return err
	}
	for _, q := range queued {
		err := r.inTx(ctx, func(tx pgx.Tx) error {
			run, err := chat.One[runRow](ctx, tx, "SELECT * FROM task_run WHERE id = $1 AND status = 'queued' FOR UPDATE", q.ID)
			if err != nil || run == nil || run.ComputerID == nil {
				return err
			}
			var active int
			if err := tx.QueryRow(ctx, `SELECT count(*) FROM task_run WHERE computer_id = $1
				AND status IN ('preparing', 'starting', 'running')`, *run.ComputerID).Scan(&active); err != nil {
				return err
			}
			if active >= MaxActiveRuns {
				return nil
			}
			session, err := openSession(ctx, tx, run)
			if err != nil {
				return err
			}
			if session != nil {
				_, err = tx.Exec(ctx, `UPDATE task_run SET status = 'starting', session_id = $2, workspace = $3 WHERE id = $1`,
					run.ID, session.ID, session.Workspace)
				return err
			}
			_, err = tx.Exec(ctx, "UPDATE task_run SET status = 'preparing' WHERE id = $1", run.ID)
			return err
		})
		if err != nil {
			return err
		}
	}
	return nil
}

func openSession(ctx context.Context, db interface {
	Query(context.Context, string, ...any) (pgx.Rows, error)
}, run *runRow) (*sessionRow, error) {
	rows, err := db.Query(ctx, `SELECT * FROM task_session WHERE task_id = $1 AND computer_id = $2 AND runtime = $3
		AND provider = $4 AND closed_at IS NULL`, run.TaskID, *run.ComputerID, run.Runtime, run.Provider)
	if err != nil {
		return nil, err
	}
	s, err := pgx.CollectOneRow(rows, pgx.RowToAddrOfStructByName[sessionRow])
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	return s, err
}

func (r *Runner) expirePreparing(ctx context.Context) error {
	runs, err := chat.All[runRow](ctx, r.DB, `SELECT * FROM task_run WHERE status = 'preparing' AND created_at < $1`,
		time.Now().Add(-prepareTimeout))
	if err != nil {
		return err
	}
	for _, run := range runs {
		if err := r.fail(ctx, run.ID, "电脑没有准备好任务的工作区（可能离线）。"); err != nil {
			return err
		}
	}
	return nil
}

// start opens the run's native agent when its session has none, then sends
// the prompt.
func (r *Runner) start(ctx context.Context) error {
	a, ok := r.agents()
	if !ok {
		return nil
	}
	runs, err := chat.All[runRow](ctx, r.DB, "SELECT * FROM task_run WHERE status = 'starting' ORDER BY created_at")
	if err != nil {
		return err
	}
	for _, run := range runs {
		if err := r.startOne(ctx, a, run); err != nil {
			slog.WarnContext(ctx, "Task run did not start", "run", run.ID, "error", err)
		}
	}
	return nil
}

func (r *Runner) startOne(ctx context.Context, a agents, run *runRow) error {
	ctx, cancel := context.WithTimeout(ctx, callTimeout*3)
	defer cancel()
	session, err := r.session(ctx, a, run)
	if err != nil || session == nil {
		return err
	}
	// Recorded before the call: if its confirmation is lost, watch settles
	// it from the native state.
	sentAt := chat.Now()
	if _, err := r.DB.Exec(ctx, `UPDATE task_run SET status = 'running', sent_at = $2 WHERE id = $1 AND status = 'starting'`,
		run.ID, sentAt); err != nil {
		return err
	}
	delete(r.working, run.ID)
	err = a.send(ctx, session, session.native(), r.withCLI(ctx, run, run.Prompt))
	if err != nil && !errors.Is(err, errUnknown) && !isTransport(err) {
		return r.fail(ctx, run.ID, "远程智能体没有接受指令："+err.Error())
	}
	return r.inTx(ctx, func(tx pgx.Tx) error {
		if err := record(ctx, tx, run.TaskID, &run.ID, "run_started", System, nil, map[string]any{
			"workspace": session.Workspace, "runtime": run.Runtime, "provider": run.Provider,
		}); err != nil {
			return err
		}
		task, err := find(ctx, tx, run.TaskID, true)
		if err != nil || task.Status != StatusTodo {
			return err
		}
		return setStatus(ctx, tx, task, StatusInProgress, System, &run.ID)
	})
}

// isTransport is a failure to reach the relay, after which the send may or
// may not have happened.
func isTransport(err error) bool {
	var fault *relay.Fault
	return !errors.As(err, &fault)
}

// session is the run's open session, created (with its native agent) when
// there is none. A run without a workspace or device fails.
func (r *Runner) session(ctx context.Context, a agents, run *runRow) (*sessionRow, error) {
	if run.SessionID != nil {
		return chat.One[sessionRow](ctx, r.DB, "SELECT * FROM task_session WHERE id = $1", *run.SessionID)
	}
	if run.Workspace == nil || run.ComputerID == nil {
		return nil, r.fail(ctx, run.ID, "没有工作区。")
	}
	var deviceID *string
	if err := r.DB.QueryRow(ctx, "SELECT device_id FROM computer_runtime WHERE computer_id = $1 AND kind = $2",
		*run.ComputerID, run.Runtime).Scan(&deviceID); err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return nil, err
	}
	if deviceID == nil {
		return nil, r.fail(ctx, run.ID, "这台电脑的 "+run.Runtime+" 还没有配对。")
	}
	var number int64
	var title string
	if err := r.DB.QueryRow(ctx, "SELECT number, title FROM task WHERE id = $1", run.TaskID).Scan(&number, &title); err != nil {
		return nil, err
	}
	s := &sessionRow{
		ID: chat.NewID(), TaskID: run.TaskID, ComputerID: *run.ComputerID, Runtime: run.Runtime, Provider: run.Provider,
		DeviceID: *deviceID, InstanceID: instanceFor(run.Runtime), Workspace: *run.Workspace, CreatedAt: chat.Now(),
	}
	n, err := a.create(ctx, s, fmt.Sprintf("AXP #%d %s", number, title))
	if err != nil {
		// Creating has no idempotency the relay exposes: whatever happened,
		// the run fails rather than possibly opening a second agent.
		return nil, r.fail(ctx, run.ID, "无法在远程电脑上打开智能体："+err.Error())
	}
	s.Native, _ = json.Marshal(n)
	err = r.inTx(ctx, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `INSERT INTO task_session (id, task_id, computer_id, runtime, provider, device_id, instance_id,
			workspace, native, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
			s.ID, s.TaskID, s.ComputerID, s.Runtime, s.Provider, s.DeviceID, s.InstanceID, s.Workspace, s.Native, s.CreatedAt); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, "UPDATE task_run SET session_id = $2 WHERE id = $1", run.ID, s.ID)
		return err
	})
	if err != nil {
		return nil, err
	}
	return s, nil
}

// watch looks at every running run's agent.
func (r *Runner) watch(ctx context.Context) error {
	a, ok := r.agents()
	if !ok {
		return nil
	}
	runs, err := chat.All[runRow](ctx, r.DB, "SELECT * FROM task_run WHERE status = 'running' AND session_id IS NOT NULL")
	if err != nil {
		return err
	}
	for _, run := range runs {
		if err := r.watchOne(ctx, a, run); err != nil {
			slog.WarnContext(ctx, "Cannot look at a remote agent", "run", run.ID, "error", err)
		}
	}
	return nil
}

func (r *Runner) watchOne(ctx context.Context, a agents, run *runRow) error {
	ctx, cancel := context.WithTimeout(ctx, callTimeout)
	defer cancel()
	session, err := chat.One[sessionRow](ctx, r.DB, "SELECT * FROM task_session WHERE id = $1", *run.SessionID)
	if err != nil || session == nil {
		return err
	}
	n := session.native()
	if run.InterruptRequestedAt != nil {
		if err := a.interrupt(ctx, session, n); err != nil && !errors.Is(err, errUnknown) {
			return err
		}
		return r.inTx(ctx, func(tx pgx.Tx) error {
			reason := "已停止。"
			delete(r.working, run.ID)
			return finishRun(ctx, tx, run, RunCancelled, &reason)
		})
	}
	state, err := a.state(ctx, session, n)
	if err != nil {
		// An offline computer may still be working: wait, never move the
		// task elsewhere.
		return err
	}
	sent := *run.SentAt
	switch state.Activity {
	case "gone":
		return r.fail(ctx, run.ID, "远程智能体已经不在了（被关闭或归档）。")
	case "error":
		return r.fail(ctx, run.ID, "远程智能体出错："+state.Error)
	case "working", "blocked":
		r.working[run.ID] = true
		return nil
	}
	// Idle. Did this turn happen?
	if !state.LastInput.IsZero() && state.LastInput.Before(sent.Add(-5*time.Second)) {
		if time.Since(sent) > deliveryTimeout {
			return r.fail(ctx, run.ID, "指令没有送达远程智能体。")
		}
		return nil
	}
	// A native turn-end time after the send settles it. Paseo does not
	// always raise a new one (attention already pending from an earlier
	// turn), so idle after having been seen working, or idle for long
	// enough, ends the turn too.
	ended := !state.FinishedAt.IsZero() && !state.FinishedAt.Before(sent)
	if !ended {
		ended = (r.working[run.ID] || time.Since(sent) > settleAfter*4) && time.Since(sent) > settleAfter
	}
	if !ended {
		return nil
	}
	delete(r.working, run.ID)
	commented, err := chat.Exists(ctx, r.DB, `SELECT 1 FROM task_activity WHERE task_id = $1 AND kind = 'comment'
		AND actor = 'remote' AND created_at >= $2`, run.TaskID, sent)
	if err != nil {
		return err
	}
	if commented {
		return r.inTx(ctx, func(tx pgx.Tx) error { return finishRun(ctx, tx, run, RunCompleted, nil) })
	}
	if run.NudgedAt != nil {
		return r.fail(ctx, run.ID, "远程智能体结束了这一轮，但没有用 axp task comment 回复。")
	}
	now := chat.Now()
	if _, err := r.DB.Exec(ctx, "UPDATE task_run SET nudged_at = $2, sent_at = $2 WHERE id = $1", run.ID, now); err != nil {
		return err
	}
	if err := r.inTx(ctx, func(tx pgx.Tx) error {
		return record(ctx, tx, run.TaskID, &run.ID, "run_nudged", System, nil, nil)
	}); err != nil {
		return err
	}
	err = a.send(ctx, session, n, r.withCLI(ctx, run, nudgePrompt))
	if err != nil && !errors.Is(err, errUnknown) && !isTransport(err) {
		return r.fail(ctx, run.ID, "无法提醒远程智能体回复："+err.Error())
	}
	return nil
}

// withCLI tells the agent where `axp` is: agents run in their runtime's
// environment, whose PATH may not have it.
func (r *Runner) withCLI(ctx context.Context, run *runRow, prompt string) string {
	var path *string
	if run.ComputerID == nil || r.DB.QueryRow(ctx, "SELECT cli_path FROM computer WHERE id = $1", *run.ComputerID).Scan(&path) != nil || path == nil {
		return prompt
	}
	return fmt.Sprintf("（这台电脑上的 `axp` 命令是 `%s`；PATH 里找不到 `axp` 时用这个完整路径。）\n\n%s", *path, prompt)
}
