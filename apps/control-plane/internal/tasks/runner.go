package tasks

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/akarachen/axp/apps/control-plane/internal/relay"
	"github.com/akarachen/axp/packages/service-go/pg"
	"github.com/akarachen/axp/packages/telemetry-go"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// The runner moves runs along, in the controller process, on its own loop:
// relay calls take seconds and must not hold up the agents' runtimes.
//
//	queued     waits for the task's previous run (in its lane: the assignee's,
//	           or assisting agents') and the computer's capacity
//	starting   the place is opened and the native agent started (once per
//	           session), then sent the prompt
//	running    watched until its turn ends; then completed, reminded once to
//	           comment, or failed
//
// When a task is done, what AXP opened for it is archived or removed.
//
// Each computer works on at most its max_active_runs runs at once, of every
// runtime and lane: a run takes one of its places when it starts (queued
// takes none) and keeps it while starting or running, so through the
// opening of its place, an unconfirmed send, the agent's whole turn (and
// whatever keeps the run running, such as its subagents) and an offline
// spell, until it is known to have ended: completed, failed, or cancelled
// once its agent was interrupted. A stop asked for while a place is being
// opened waits for the opening to return; a run whose opening a dead runner
// left behind fails (or is cancelled, if asked to stop) at the next tick.
//
// Writes to remote agents are never repeated: the time a prompt is handed to
// the relay is recorded first, and a lost confirmation is settled from the
// native state. So is the time a place starts being opened: a run whose
// opening was interrupted fails instead of opening a second place. A start
// in progress finishes even when the runner is told to stop, so that a
// deploy does not leave one half done.

const (
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
	// Failures of steps, runs and sessions: a computer that stays offline is
	// logged when it changes and now and then, not every tick.
	failures telemetry.Repeats
}

// Loop runs the steps every interval until ctx ends; a tick in progress
// stops at the next step or run, except for a start under way.
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
		{"settle_loops", r.settleLoops},
		{"release_assists", r.releaseAssists},
		{"dispatch_runs", r.dispatch},
		{"start_runs", r.start},
		{"watch_runs", r.watch},
		{"clean_up", r.cleanup},
	}
	for _, step := range steps {
		if ctx.Err() != nil {
			return
		}
		r.failures.Log(ctx, slog.LevelError, "step:"+step.name, step.run(ctx), "Task runner step failed", "step", step.name)
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

// cancelStopped cancels a starting run asked to stop once nothing is
// under way for it any more; its computer's place is free then.
func (r *Runner) cancelStopped(ctx context.Context, tx pgx.Tx, runID string) error {
	run, err := pg.One[runRow](ctx, tx, `SELECT * FROM task_run WHERE id = $1 AND status = 'starting'
		AND interrupt_requested_at IS NOT NULL FOR UPDATE`, runID)
	if err != nil || run == nil {
		return err
	}
	reason := "已停止。"
	return finishRun(ctx, tx, run, RunCancelled, &reason)
}

func (r *Runner) fail(ctx context.Context, runID, message string) error {
	return r.inTx(ctx, func(tx pgx.Tx) error {
		run, err := pg.One[runRow](ctx, tx, "SELECT * FROM task_run WHERE id = $1 FOR UPDATE", runID)
		if err != nil || run == nil || run.FinishedAt != nil {
			return err
		}
		delete(r.working, runID)
		return finishRun(ctx, tx, run, RunFailed, &message)
	})
}

// releaseAssists starts waiting requests for assistance whose dependencies
// are met, oldest first, and records why the others wait or are blocked.
// What they depend on is read anew every tick, so nothing is missed across
// a restart or a run that ended before the request was made.
func (r *Runner) releaseAssists(ctx context.Context) error {
	waiting, err := pg.All[assistRow](ctx, r.DB, "SELECT * FROM task_assist WHERE state = 'waiting' ORDER BY created_at, id")
	if err != nil {
		return err
	}
	for _, a := range waiting {
		if ctx.Err() != nil {
			return nil
		}
		// Reading the pull request's head is a call to GitHub: outside the
		// transaction, which checks again what it relied on.
		callCtx, cancel := context.WithTimeout(ctx, callTimeout)
		ready, err := r.Service.ready(callCtx, r.DB, a)
		cancel()
		if err != nil {
			return err
		}
		if err := r.inTx(ctx, func(tx pgx.Tx) error {
			if ready.start {
				return r.Service.start(ctx, tx, a.ID, ready)
			}
			return hold(ctx, tx, a, ready)
		}); err != nil {
			return err
		}
	}
	return nil
}

// settleLoops blocks active review loops whose current review ended
// without a verdict.
func (r *Runner) settleLoops(ctx context.Context) error {
	loops, err := pg.All[loopRow](ctx, r.DB, "SELECT * FROM task_review_loop WHERE state = 'active'")
	if err != nil {
		return err
	}
	for _, l := range loops {
		if err := r.inTx(ctx, func(tx pgx.Tx) error { return settleLoop(ctx, tx, l) }); err != nil {
			return err
		}
	}
	return nil
}

// dispatch starts the oldest queued run of each idle lane of a task (its
// assignee's, its assisting agents'), within its computer's limit:
// computers fill their places oldest run first, each on its own, so one
// that is full or offline holds up only its own queue.
//
// A place is taken by moving the run to starting, in a transaction holding
// the computer's row: two dispatchers (or a start racing a change of the
// limit) count one after the other, never both under the limit. (NO KEY:
// queuing a run, whose foreign key only shares the row, is not held up.) It is held
// until the run is known to have ended (see Runner): a queued run takes
// none.
func (r *Runner) dispatch(ctx context.Context) error {
	if r.Service.Relay == nil {
		return nil
	}
	queued, err := pg.All[runRow](ctx, r.DB, `SELECT * FROM (SELECT DISTINCT ON (q.task_id, q.assist) q.* FROM task_run q
			WHERE q.status = 'queued' AND NOT EXISTS (SELECT 1 FROM task_run a WHERE a.task_id = q.task_id
				AND a.assist = q.assist AND a.status IN ('starting', 'running'))
			ORDER BY q.task_id, q.assist, q.created_at, q.id) oldest
		ORDER BY created_at, id`)
	if err != nil {
		return err
	}
	full := map[string]bool{}
	for _, q := range queued {
		if q.ComputerID == nil || full[*q.ComputerID] {
			continue
		}
		err := r.inTx(ctx, func(tx pgx.Tx) error {
			var limit int
			if err := tx.QueryRow(ctx, "SELECT max_active_runs FROM computer WHERE id = $1 FOR NO KEY UPDATE",
				*q.ComputerID).Scan(&limit); err != nil {
				if errors.Is(err, pgx.ErrNoRows) {
					return nil
				}
				return err
			}
			run, err := pg.One[runRow](ctx, tx, "SELECT * FROM task_run WHERE id = $1 AND status = 'queued' FOR UPDATE", q.ID)
			if err != nil || run == nil || run.ComputerID == nil || *run.ComputerID != *q.ComputerID {
				return err
			}
			active, err := activeRuns(ctx, tx, *run.ComputerID)
			if err != nil {
				return err
			}
			if active >= limit {
				// Later runs on it wait too: the oldest goes first.
				full[*run.ComputerID] = true
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
			_, err = tx.Exec(ctx, "UPDATE task_run SET status = 'starting' WHERE id = $1", run.ID)
			return err
		})
		if err != nil {
			return err
		}
	}
	return nil
}

// activeRuns is how many of the computer's places are taken.
func activeRuns(ctx context.Context, db pg.DB, computerID string) (int, error) {
	var n int
	err := db.QueryRow(ctx, `SELECT count(*) FROM task_run WHERE computer_id = $1
		AND status IN ('starting', 'running')`, computerID).Scan(&n)
	return n, err
}

func openSession(ctx context.Context, db interface {
	Query(context.Context, string, ...any) (pgx.Rows, error)
}, run *runRow) (*sessionRow, error) {
	rows, err := db.Query(ctx, `SELECT * FROM task_session WHERE task_id = $1 AND computer_id = $2 AND runtime = $3
		AND provider = $4 AND assist = $5 AND closed_at IS NULL`, run.TaskID, *run.ComputerID, run.Runtime, run.Provider, run.Assist)
	if err != nil {
		return nil, err
	}
	s, err := pgx.CollectOneRow(rows, pgx.RowToAddrOfStructByName[sessionRow])
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	return s, err
}

// start opens the run's native agent when its session has none, then sends
// the prompt.
func (r *Runner) start(ctx context.Context) error {
	a, ok := r.agents()
	if !ok {
		return nil
	}
	runs, err := pg.All[runRow](ctx, r.DB, "SELECT * FROM task_run WHERE status = 'starting' ORDER BY created_at")
	if err != nil {
		return err
	}
	for _, run := range runs {
		if ctx.Err() != nil {
			return nil
		}
		r.failures.Log(ctx, slog.LevelWarn, "start:"+run.ID, r.startOne(ctx, a, run), "Task run did not start", "run", run.ID)
	}
	return nil
}

func (r *Runner) startOne(ctx context.Context, a agents, run *runRow) error {
	// Finished even when the runner is stopped: a start cut short is a
	// place opened and never recorded.
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), callTimeout*3)
	defer cancel()
	opened := run.SessionID == nil
	session, err := r.session(ctx, a, run)
	if err != nil || session == nil {
		return err
	}
	// Recorded before the call: if its confirmation is lost, watch settles
	// it from the native state. Only a run still starting, and not asked to
	// stop, is sent anything: stopping, reassigning or finishing the task
	// cancels one, or asks one whose place was being opened to stop.
	sentAt := pg.Now()
	started, err := r.DB.Exec(ctx, `UPDATE task_run SET status = 'running', sent_at = $2 WHERE id = $1 AND status = 'starting'
		AND interrupt_requested_at IS NULL`, run.ID, sentAt)
	if err != nil {
		return err
	}
	if started.RowsAffected() == 0 {
		return r.inTx(ctx, func(tx pgx.Tx) error {
			if opened {
				// Stopped while its place was being opened: what was opened
				// for it is closed and cleaned up, never reused.
				if _, err := tx.Exec(ctx, `UPDATE task_session SET closed_at = COALESCE(closed_at, $2), cleanup_pending = true
					WHERE id = $1`, session.ID, pg.Now()); err != nil {
					return err
				}
			}
			return r.cancelStopped(ctx, tx, run.ID)
		})
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
		if run.Assist {
			// Assisting is not working on the task.
			return nil
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

// session is the run's open session, opened (its place and native agent)
// when there is none.
func (r *Runner) session(ctx context.Context, a agents, run *runRow) (*sessionRow, error) {
	if run.SessionID != nil {
		return pg.One[sessionRow](ctx, r.DB, "SELECT * FROM task_session WHERE id = $1", *run.SessionID)
	}
	if run.ComputerID == nil {
		return nil, r.fail(ctx, run.ID, "这次运行没有电脑。")
	}
	// Being opened by a runner that died (a stopped one finishes its
	// start): what it opened is not known. A run asked to stop meanwhile is
	// cancelled; others fail.
	if run.OpeningAt != nil {
		if run.InterruptRequestedAt != nil {
			return nil, r.inTx(ctx, func(tx pgx.Tx) error { return r.cancelStopped(ctx, tx, run.ID) })
		}
		return nil, r.fail(ctx, run.ID, "上次打开工作位置时被中断（例如部署），可能已经打开了一个；为了不重复打开，这次运行失败，请重新运行。")
	}
	var deviceID *string
	if err := r.DB.QueryRow(ctx, "SELECT device_id FROM computer_runtime WHERE computer_id = $1 AND kind = $2",
		*run.ComputerID, run.Runtime).Scan(&deviceID); err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return nil, err
	}
	if deviceID == nil {
		return nil, r.fail(ctx, run.ID, "这台电脑的 "+run.Runtime+" 还没有配对。")
	}
	task, err := find(ctx, r.DB, run.TaskID, false)
	if err != nil {
		return nil, err
	}
	if task.Place == nil {
		return nil, r.fail(ctx, run.ID, "任务没有工作位置。")
	}
	place := *task.Place
	if run.Assist {
		// Read only, before anything is opened.
		if place, err = a.assistPlace(ctx, target{*deviceID, run.Runtime}, place, task.Number, run.ID); err != nil {
			if isTransport(err) && !errors.Is(err, errAssigneePlaceGone) {
				// The computer may be offline: try again later.
				return nil, err
			}
			return nil, r.fail(ctx, run.ID, "找不到主执行者工作位置所在的仓库，无法为协助开 worktree："+err.Error())
		}
	}
	marked, err := r.DB.Exec(ctx, "UPDATE task_run SET opening_at = $2 WHERE id = $1 AND status = 'starting' AND opening_at IS NULL",
		run.ID, pg.Now())
	if err != nil || marked.RowsAffected() == 0 {
		// Cancelled meanwhile, or another runner got there first.
		return nil, err
	}
	s := &sessionRow{
		ID: pg.NewID(), TaskID: run.TaskID, ComputerID: *run.ComputerID, Runtime: run.Runtime, Provider: run.Provider,
		DeviceID: *deviceID, InstanceID: instanceFor(run.Runtime), CreatedAt: pg.Now(), Assist: run.Assist,
	}
	n, dir, openErr := a.open(ctx, s, opening{TaskID: task.ID, Number: task.Number, Title: task.Title, Place: place, Assist: run.Assist})
	if openErr != nil {
		// The run fails without logging; this keeps the runtime's own
		// answer, which the task's message only summarizes.
		slog.WarnContext(ctx, "Cannot open a remote place", "run", run.ID, "task", task.ID, "runtime", run.Runtime,
			"computer", *run.ComputerID, "unknown", errors.Is(openErr, errUnknown), "native", unknownNative(openErr), "error", openErr)
	}
	if n.WorkspaceID == "" && openErr != nil {
		// Opening has no idempotency the relay exposes: whatever happened,
		// the run fails rather than possibly opening a second place.
		return nil, r.fail(ctx, run.ID, "无法在远程电脑上打开工作位置："+openErr.Error())
	}
	// What was opened is kept with the session, so a done task cleans it up
	// even when the agent did not start.
	s.Workspace = dir
	s.Native, _ = json.Marshal(n)
	err = r.inTx(ctx, func(tx pgx.Tx) error {
		closed := any(nil)
		if openErr != nil {
			closed = pg.Now()
		}
		if _, err := tx.Exec(ctx, `INSERT INTO task_session (id, task_id, computer_id, runtime, provider, device_id, instance_id,
			workspace, native, created_at, closed_at, cleanup_pending, assist) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
			s.ID, s.TaskID, s.ComputerID, s.Runtime, s.Provider, s.DeviceID, s.InstanceID, s.Workspace, s.Native, s.CreatedAt,
			closed, openErr != nil, s.Assist); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, "UPDATE task_run SET session_id = $2, workspace = $3 WHERE id = $1", run.ID, s.ID, s.Workspace)
		return err
	})
	if err != nil {
		return nil, err
	}
	if openErr != nil {
		return nil, r.fail(ctx, run.ID, "智能体没有在远程电脑上启动："+openErr.Error())
	}
	return s, nil
}

// watch looks at every running run's agent.
func (r *Runner) watch(ctx context.Context) error {
	a, ok := r.agents()
	if !ok {
		return nil
	}
	runs, err := pg.All[runRow](ctx, r.DB, "SELECT * FROM task_run WHERE status = 'running' AND session_id IS NOT NULL")
	if err != nil {
		return err
	}
	for _, run := range runs {
		r.failures.Log(ctx, slog.LevelWarn, "watch:"+run.ID, r.watchOne(ctx, a, run), "Cannot look at a remote agent", "run", run.ID)
	}
	return nil
}

func (r *Runner) watchOne(ctx context.Context, a agents, run *runRow) error {
	ctx, cancel := context.WithTimeout(ctx, callTimeout)
	defer cancel()
	session, err := pg.One[sessionRow](ctx, r.DB, "SELECT * FROM task_session WHERE id = $1", *run.SessionID)
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
	// Its own agent's: an assisting agent's reply is not the assignee's.
	commented, err := pg.Exists(ctx, r.DB, `SELECT 1 FROM task_activity WHERE run_id = $1 AND kind IN ('comment', 'review')
		AND actor = 'remote' AND created_at >= $2`, run.ID, sent)
	if err != nil {
		return err
	}
	if commented {
		return r.inTx(ctx, func(tx pgx.Tx) error { return finishRun(ctx, tx, run, RunCompleted, nil) })
	}
	if run.NudgedAt != nil {
		return r.fail(ctx, run.ID, "远程智能体结束了这一轮，但没有用 axp task comment 回复。")
	}
	now := pg.Now()
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

// cleanup archives or removes what AXP opened for sessions whose task is
// done (or whose agent never started), once their runs have stopped.
func (r *Runner) cleanup(ctx context.Context) error {
	a, ok := r.agents()
	if !ok {
		return nil
	}
	sessions, err := pg.All[sessionRow](ctx, r.DB, `SELECT s.* FROM task_session s
		WHERE s.cleanup_pending AND NOT EXISTS (SELECT 1 FROM task_run r WHERE r.session_id = s.id AND r.status IN ('starting', 'running'))`)
	if err != nil {
		return err
	}
	for _, s := range sessions {
		callCtx, cancel := context.WithTimeout(ctx, callTimeout)
		note, err := a.cleanup(callCtx, s, s.native())
		cancel()
		// The computer may be offline: try again later.
		r.failures.Log(ctx, slog.LevelWarn, "cleanup:"+s.ID, err, "Cannot clean up a remote session",
			"session", s.ID, "task", s.TaskID, "runtime", s.Runtime, "computer", s.ComputerID)
		if err != nil {
			continue
		}
		if err := r.inTx(ctx, func(tx pgx.Tx) error {
			if _, err := tx.Exec(ctx, "UPDATE task_session SET cleanup_pending = false WHERE id = $1", s.ID); err != nil {
				return err
			}
			return record(ctx, tx, s.TaskID, nil, "cleanup", System, &note, map[string]any{"runtime": s.Runtime})
		}); err != nil {
			return err
		}
	}
	return nil
}
