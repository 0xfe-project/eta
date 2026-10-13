package tasks

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/akarachen/axp/packages/service-go/apierr"
	"github.com/akarachen/axp/packages/service-go/jsontime"
	"github.com/akarachen/axp/packages/service-go/pg"
	"github.com/jackc/pgx/v5"
)

// 请 Agent 协助: another agent on the task's computer does one piece of work
// on the task (a review, a test run) beside its assignee, e.g. Codex
// reviewing what Claude delivered.
//
// A request (task_assist) starts at once, or once the assignee's run it
// depends on has delivered: that run completed, the assignee is not at work,
// and, for a review of the pull request, the task has one whose head GitHub
// answers with. The runner (release) checks waiting requests on every tick,
// from the database alone, so a run that ended before the request was made,
// or while the controller was down, still releases it; and starts them in
// the order they were asked for, each as a run of its own in the task's
// assisting lane: one active at a time, in a session and place of its own
// (a new worktree of the assignee's repository), never the assignee's.
// Assisting changes neither the task's status nor its assignee, and wakes no
// one else: its replies are remote comments, which are never passed on.
// Asking the same agent again continues its session.
//
// A review loop (task_review_loop) is a bounded back-and-forth: the reviewer
// reports pass or changes_requested (`axp task review`); changes go to the
// assignee's session as a run of its own, and the next round's review waits
// for that run. A pass, max_rounds reviews, a failed run or the user stop it.
// Only a review the loop is waiting for moves it, once.

// Review loop budget: what agents may ask for, and what the user may raise it to.
const (
	DefaultRounds = 3
	MaxRounds     = 10
)

// Assist states.
const (
	AssistWaiting   = "waiting"
	AssistBlocked   = "blocked"
	AssistStarted   = "started"
	AssistCancelled = "cancelled"
)

// Loop states.
const (
	LoopActive    = "active"
	LoopPassed    = "passed"
	LoopExhausted = "exhausted"
	LoopBlocked   = "blocked"
	LoopStopped   = "stopped"
)

// Verdicts.
const (
	VerdictPass    = "pass"
	VerdictChanges = "changes_requested"
)

// AssistInput is a request for assistance, the same from the web, the tasks
// tool and the axp CLI.
type AssistInput struct {
	Runtime  string `json:"runtime" enum:"paseo,herdr" jsonschema:"the agent's runtime on the task's computer: paseo or herdr (list_assignees)"`
	Provider string `json:"provider" minLength:"1" maxLength:"32" jsonschema:"the agent: codex, claude, ... (list_assignees)"`
	Request  string `json:"request" minLength:"1" maxLength:"20000" doc:"What the agent is to do; it is told this is the confirmed request." jsonschema:"what the agent is to do, in Markdown; it gets this as the user's confirmed request"`
	// Whether it looks at the delivered pull request, pinned at its head.
	ReviewPull *bool      `json:"review_pull,omitempty" doc:"Look at the task's delivered pull request, pinned at its head when it starts. Default: when it waits for a delivery, or the task has a pull request." jsonschema:"look at the task's delivered pull request, pinned at its head commit when it starts; default true when after_run is set or the task already has one"`
	AfterRun   string     `json:"after_run,omitempty" maxLength:"64" doc:"Start once this run of the assignee's has delivered: current (its current or latest run) or a run id. Empty: now." jsonschema:"start once this run of the assignee's has completed and delivered: current (its current or latest run) or a run id; empty to start now"`
	Loop       *LoopInput `json:"loop,omitempty" doc:"Make it a review loop: changes it asks for go to the assignee, whose next run it reviews again." jsonschema:"make it a review loop: the agent reports pass or changes_requested, changes go to the assignee and its next run is reviewed again, up to max_rounds reviews"`
	Key        string     `json:"key,omitempty" maxLength:"200" doc:"The request's idempotency key: sending it again is the same request." jsonschema:"an idempotency key of your choosing; the same key is the same request"`
}

// LoopInput is a review loop's budget.
type LoopInput struct {
	MaxRounds int `json:"max_rounds,omitempty" minimum:"0" maximum:"10" doc:"Reviews at most, 3 by default; agents cannot ask for more than 3." jsonschema:"reviews at most; 3 by default and at most 3 for agents"`
}

// TaskAssist is a request for assistance as it stands.
type TaskAssist struct {
	ID         string         `json:"id"`
	State      string         `json:"state" enum:"waiting,blocked,started,cancelled" doc:"started: its run (run_id) has the rest."`
	Reason     *string        `json:"reason" nullable:"true" doc:"Why it waits, or is blocked or cancelled."`
	Runtime    string         `json:"runtime"`
	Provider   string         `json:"provider"`
	Request    string         `json:"request"`
	ReviewPull bool           `json:"review_pull"`
	AfterRunID *string        `json:"after_run_id" nullable:"true"`
	LoopID     *string        `json:"loop_id" nullable:"true"`
	Round      *int           `json:"round" nullable:"true"`
	RunID      *string        `json:"run_id" nullable:"true"`
	PullURL    *string        `json:"pull_url" nullable:"true"`
	HeadSHA    *string        `json:"head_sha" nullable:"true"`
	Verdict    *string        `json:"verdict" nullable:"true" enum:"pass,changes_requested"`
	Feedback   *string        `json:"feedback" nullable:"true"`
	CreatedAt  jsontime.Time  `json:"created_at"`
	StartedAt  *jsontime.Time `json:"started_at" nullable:"true"`
}

// TaskLoop is a review loop as it stands.
type TaskLoop struct {
	ID        string        `json:"id"`
	Runtime   string        `json:"runtime"`
	Provider  string        `json:"provider"`
	Request   string        `json:"request"`
	MaxRounds int           `json:"max_rounds"`
	Rounds    int           `json:"rounds" doc:"Reviews done."`
	State     string        `json:"state" enum:"active,passed,exhausted,blocked,stopped"`
	Reason    *string       `json:"reason" nullable:"true"`
	CreatedAt jsontime.Time `json:"created_at"`
	UpdatedAt jsontime.Time `json:"updated_at"`
}

type assistRow struct {
	ID         string     `db:"id"`
	TaskID     string     `db:"task_id"`
	Key        *string    `db:"key"`
	Runtime    string     `db:"runtime"`
	Provider   string     `db:"provider"`
	Request    string     `db:"request"`
	ReviewPull bool       `db:"review_pull"`
	AfterRunID *string    `db:"after_run_id"`
	Waits      bool       `db:"waits"`
	LoopID     *string    `db:"loop_id"`
	Round      *int       `db:"round"`
	State      string     `db:"state"`
	Reason     *string    `db:"reason"`
	RunID      *string    `db:"run_id"`
	PullURL    *string    `db:"pull_url"`
	HeadSHA    *string    `db:"head_sha"`
	Verdict    *string    `db:"verdict"`
	Feedback   *string    `db:"feedback"`
	VerdictAt  *time.Time `db:"verdict_at"`
	CreatedAt  time.Time  `db:"created_at"`
	StartedAt  *time.Time `db:"started_at"`
}

type loopRow struct {
	ID        string    `db:"id"`
	TaskID    string    `db:"task_id"`
	Runtime   string    `db:"runtime"`
	Provider  string    `db:"provider"`
	Request   string    `db:"request"`
	MaxRounds int       `db:"max_rounds"`
	Rounds    int       `db:"rounds"`
	State     string    `db:"state"`
	Reason    *string   `db:"reason"`
	CreatedAt time.Time `db:"created_at"`
	UpdatedAt time.Time `db:"updated_at"`
}

func (a *assistRow) public() TaskAssist {
	return TaskAssist{
		ID: a.ID, State: a.State, Reason: a.Reason, Runtime: a.Runtime, Provider: a.Provider, Request: a.Request,
		ReviewPull: a.ReviewPull, AfterRunID: a.AfterRunID, LoopID: a.LoopID, Round: a.Round, RunID: a.RunID,
		PullURL: a.PullURL, HeadSHA: a.HeadSHA, Verdict: a.Verdict, Feedback: a.Feedback,
		CreatedAt: jsontime.From(a.CreatedAt), StartedAt: jsontime.Ptr(a.StartedAt),
	}
}

func (l *loopRow) public() TaskLoop {
	return TaskLoop{
		ID: l.ID, Runtime: l.Runtime, Provider: l.Provider, Request: l.Request, MaxRounds: l.MaxRounds, Rounds: l.Rounds,
		State: l.State, Reason: l.Reason, CreatedAt: jsontime.From(l.CreatedAt), UpdatedAt: jsontime.From(l.UpdatedAt),
	}
}

func assistsOf(ctx context.Context, db pg.DB, taskID string) ([]TaskAssist, []TaskLoop, error) {
	assists, err := pg.All[assistRow](ctx, db, "SELECT * FROM task_assist WHERE task_id = $1 ORDER BY created_at, id", taskID)
	if err != nil {
		return nil, nil, err
	}
	loops, err := pg.All[loopRow](ctx, db, "SELECT * FROM task_review_loop WHERE task_id = $1 ORDER BY created_at, id", taskID)
	if err != nil {
		return nil, nil, err
	}
	outA, outL := make([]TaskAssist, 0, len(assists)), make([]TaskLoop, 0, len(loops))
	for _, a := range assists {
		outA = append(outA, a.public())
	}
	for _, l := range loops {
		outL = append(outL, l.public())
	}
	return outA, outL, nil
}

// latestPull is the task's latest delivered pull request, recorded by until
// (now when zero); empty when there is none.
func latestPull(ctx context.Context, db pg.DB, taskID string, until time.Time) (string, error) {
	if until.IsZero() {
		until = time.Now().Add(time.Hour)
	}
	var url string
	err := db.QueryRow(ctx, `SELECT data->>'url' FROM task_activity WHERE task_id = $1 AND kind = 'deliverable'
		AND data->>'url' LIKE 'https://github.com/%/pull/%' AND created_at <= $2 ORDER BY created_at DESC LIMIT 1`,
		taskID, until).Scan(&url)
	if err == pgx.ErrNoRows {
		return "", nil
	}
	return url, err
}

// Assist records a request for assistance; the runner starts it.
func (s *Service) Assist(ctx context.Context, tx pgx.Tx, ref string, in AssistInput, by Actor) (*TaskDetail, error) {
	r, err := find(ctx, tx, ref, true)
	if err != nil {
		return nil, err
	}
	return s.assist(ctx, tx, r, in, by, nil)
}

// assist is Assist for a task found and locked; data adds to the record
// (who, for a remote agent).
func (s *Service) assist(ctx context.Context, tx pgx.Tx, r *taskRow, in AssistInput, by Actor, data map[string]any) (*TaskDetail, error) {
	key := strings.TrimSpace(in.Key)
	if key != "" {
		known, err := pg.Exists(ctx, tx, "SELECT 1 FROM task_assist WHERE task_id = $1 AND key = $2", r.ID, key)
		if err != nil {
			return nil, err
		}
		if known {
			return detail(ctx, tx, r)
		}
	}
	if r.Assignee != "remote" {
		return nil, apierr.New(409, "TASK_NOT_REMOTE", "任务还没有指派到远程电脑。协助的 Agent 和主执行者在同一台电脑上工作：先在「指派给」里选一台电脑。")
	}
	if r.Status == StatusDone || r.Status == StatusCancelled {
		return nil, apierr.New(409, "TASK_FINISHED", "任务已经结束，它的工作位置已收尾；重新打开任务后再请 Agent 协助。")
	}
	request := strings.TrimSpace(in.Request)
	if request == "" {
		return nil, invalid("需要写下协助要求。")
	}
	available, err := pg.Exists(ctx, tx, `SELECT 1 FROM computer_runtime WHERE computer_id = $1 AND kind = $2
		AND device_id IS NOT NULL AND $3 = ANY(providers)`, *r.ComputerID, in.Runtime, in.Provider)
	if err != nil {
		return nil, err
	}
	if !available {
		return nil, invalid("这台电脑上没有可用的 " + in.Runtime + " / " + in.Provider + "。")
	}
	// What it waits for: a run of the assignee's.
	var afterRun *string
	switch in.AfterRun {
	case "":
	case "current":
		var id string
		err := tx.QueryRow(ctx, `SELECT id FROM task_run WHERE task_id = $1 AND NOT assist ORDER BY created_at DESC LIMIT 1`, r.ID).Scan(&id)
		if err == pgx.ErrNoRows {
			return nil, apierr.New(409, "NO_RUN", "主执行者还没有运行可以等；去掉 after_run 现在就开始，或等它开始工作。")
		}
		if err != nil {
			return nil, err
		}
		afterRun = &id
	default:
		id, ok := pg.ParseID(in.AfterRun)
		mine := false
		if ok {
			if mine, err = pg.Exists(ctx, tx, "SELECT 1 FROM task_run WHERE id = $1 AND task_id = $2 AND NOT assist", id, r.ID); err != nil {
				return nil, err
			}
		}
		if !mine {
			return nil, invalid("after_run 不是这个任务主执行者的运行。")
		}
		afterRun = &id
	}
	pull, err := latestPull(ctx, tx, r.ID, time.Time{})
	if err != nil {
		return nil, err
	}
	reviewPull := afterRun != nil || pull != ""
	if in.ReviewPull != nil {
		reviewPull = *in.ReviewPull
	}
	if reviewPull && afterRun == nil && pull == "" {
		return nil, invalid("任务还没有交付 PR：等开发交付后再审查（after_run: current），或者不审查 PR。")
	}
	var loopID *string
	var round *int
	maxRounds := 0
	if in.Loop != nil {
		maxRounds = in.Loop.MaxRounds
		if maxRounds == 0 {
			maxRounds = DefaultRounds
		}
		if maxRounds > MaxRounds {
			return nil, invalid(fmt.Sprintf("审查循环最多 %d 轮。", MaxRounds))
		}
		if maxRounds > DefaultRounds && by.Kind != ActorUser {
			return nil, apierr.New(403, "ROUNDS_USER_ONLY", fmt.Sprintf("只有用户能把审查循环设到 %d 轮以上。", DefaultRounds))
		}
		if !reviewPull {
			return nil, invalid("审查循环要审查交付的 PR。")
		}
		open, err := pg.Exists(ctx, tx, `SELECT 1 FROM task_review_loop WHERE task_id = $1 AND state IN ('active', 'exhausted', 'blocked')`, r.ID)
		if err != nil {
			return nil, err
		}
		if open {
			return nil, apierr.New(409, "LOOP_OPEN", "这个任务已经有一个没有结束的审查循环；由用户继续或停止它。")
		}
		// Nor may an agent start over a loop the user or the task stopped:
		// starting again is the user's call.
		if by.Kind != ActorUser {
			var last string
			err := tx.QueryRow(ctx, "SELECT state FROM task_review_loop WHERE task_id = $1 ORDER BY created_at DESC LIMIT 1", r.ID).Scan(&last)
			if err != nil && err != pgx.ErrNoRows {
				return nil, err
			}
			if last != "" && last != LoopPassed {
				return nil, apierr.New(409, "LOOP_USER_ONLY", "这个任务上一个审查循环没有通过就结束了；重新开始审查循环要由用户决定。")
			}
		}
		id, now := pg.NewID(), pg.Now()
		if _, err := tx.Exec(ctx, `INSERT INTO task_review_loop (id, task_id, runtime, provider, request, max_rounds, state, created_at, updated_at)
			VALUES ($1, $2, $3, $4, $5, $6, 'active', $7, $7)`, id, r.ID, in.Runtime, in.Provider, request, maxRounds, now); err != nil {
			return nil, err
		}
		one := 1
		loopID, round = &id, &one
	}
	id, err := insertAssist(ctx, tx, assistRow{
		TaskID: r.ID, Key: nonEmpty(key), Runtime: in.Runtime, Provider: in.Provider, Request: request,
		ReviewPull: reviewPull, AfterRunID: afterRun, Waits: afterRun != nil, LoopID: loopID, Round: round,
	})
	if err != nil {
		return nil, err
	}
	if data == nil {
		data = map[string]any{}
	}
	data["assist_id"], data["agent"] = id, map[string]any{"runtime": in.Runtime, "provider": in.Provider}
	data["computer_name"] = r.ComputerName
	if afterRun != nil {
		data["after_run_id"] = *afterRun
	}
	if loopID != nil {
		data["loop_id"], data["max_rounds"], data["round"] = *loopID, maxRounds, 1
	}
	if err := record(ctx, tx, r.ID, nil, "assist", by, &request, data); err != nil {
		return nil, err
	}
	return detail(ctx, tx, r)
}

func nonEmpty(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

func insertAssist(ctx context.Context, tx pgx.Tx, a assistRow) (string, error) {
	id := pg.NewID()
	_, err := tx.Exec(ctx, `INSERT INTO task_assist (id, task_id, key, runtime, provider, request, review_pull, after_run_id, waits,
		loop_id, round, state, reason, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'waiting', $12, $13)`,
		id, a.TaskID, a.Key, a.Runtime, a.Provider, a.Request, a.ReviewPull, a.AfterRunID, a.Waits, a.LoopID, a.Round,
		"排队中。", pg.Now())
	return id, err
}

// CancelAssist cancels a request that has not started, or stops its run;
// a review loop's request stops its loop.
func (s *Service) CancelAssist(ctx context.Context, tx pgx.Tx, ref, assistID string) (*TaskDetail, error) {
	r, err := find(ctx, tx, ref, true)
	if err != nil {
		return nil, err
	}
	id, ok := pg.ParseID(assistID)
	if !ok {
		return nil, apierr.NotFound()
	}
	a, err := pg.One[assistRow](ctx, tx, "SELECT * FROM task_assist WHERE id = $1 AND task_id = $2 FOR UPDATE", id, r.ID)
	if err != nil {
		return nil, err
	}
	if a == nil {
		return nil, apierr.NotFound()
	}
	switch a.State {
	case AssistWaiting, AssistBlocked:
		if _, err := tx.Exec(ctx, "UPDATE task_assist SET state = 'cancelled', reason = '已取消。' WHERE id = $1", a.ID); err != nil {
			return nil, err
		}
	case AssistStarted:
		run, err := pg.One[runRow](ctx, tx, "SELECT * FROM task_run WHERE id = $1 FOR UPDATE", *a.RunID)
		if err != nil {
			return nil, err
		}
		if run != nil {
			if err := stopRun(ctx, tx, run); err != nil {
				return nil, err
			}
		}
	default:
		return nil, apierr.New(409, "ASSIST_CANCELLED", "这个协助已经取消了。")
	}
	if a.LoopID != nil {
		if err := setLoop(ctx, tx, *a.LoopID, LoopStopped, fmt.Sprintf("取消了第 %d 轮审查，循环停止。", deref(a.Round))); err != nil {
			return nil, err
		}
	}
	return detail(ctx, tx, r)
}

// stopRun stops a run: a running one is asked to, others stop now.
func stopRun(ctx context.Context, tx pgx.Tx, run *runRow) error {
	switch run.Status {
	case RunRunning:
		_, err := tx.Exec(ctx, "UPDATE task_run SET interrupt_requested_at = $2 WHERE id = $1 AND interrupt_requested_at IS NULL", run.ID, pg.Now())
		return err
	case RunQueued, RunStarting:
		reason := "已停止。"
		return finishRun(ctx, tx, run, RunCancelled, &reason)
	}
	return nil
}

// setLoop moves an unfinished loop to state, with the reason why.
func setLoop(ctx context.Context, tx pgx.Tx, loopID, state, reason string) error {
	_, err := tx.Exec(ctx, `UPDATE task_review_loop SET state = $2, reason = $3, updated_at = $4
		WHERE id = $1 AND state IN ('active', 'exhausted', 'blocked')`, loopID, state, reason, pg.Now())
	return err
}

// stopAssists cancels the task's requests that have not started and stops
// its loops: the task is done, cancelled or reassigned. Started ones stop
// with their runs.
func stopAssists(ctx context.Context, tx pgx.Tx, taskID, reason string) error {
	if _, err := tx.Exec(ctx, `UPDATE task_assist SET state = 'cancelled', reason = $2
		WHERE task_id = $1 AND state IN ('waiting', 'blocked')`, taskID, reason); err != nil {
		return err
	}
	_, err := tx.Exec(ctx, `UPDATE task_review_loop SET state = 'stopped', reason = $2, updated_at = $3
		WHERE task_id = $1 AND state IN ('active', 'exhausted', 'blocked')`, taskID, reason, pg.Now())
	return err
}

// StopLoop stops a review loop at the user's word; its waiting request is
// cancelled, a review under way finishes without moving it.
func (s *Service) StopLoop(ctx context.Context, tx pgx.Tx, ref, loopID string) (*TaskDetail, error) {
	r, l, err := lockedLoop(ctx, tx, ref, loopID)
	if err != nil {
		return nil, err
	}
	if l.State != LoopActive && l.State != LoopExhausted && l.State != LoopBlocked {
		return nil, apierr.New(409, "LOOP_FINISHED", "这个审查循环已经结束了。")
	}
	if _, err := tx.Exec(ctx, `UPDATE task_assist SET state = 'cancelled', reason = '审查循环已停止。'
		WHERE loop_id = $1 AND state IN ('waiting', 'blocked')`, l.ID); err != nil {
		return nil, err
	}
	if err := setLoop(ctx, tx, l.ID, LoopStopped, "用户停止了审查循环。"); err != nil {
		return nil, err
	}
	return detail(ctx, tx, r)
}

// ResumeLoop carries on a blocked or exhausted loop at the user's word,
// with a budget they may raise: an exhausted one sends the last review's
// changes to the assignee, a blocked one reviews the assignee's latest run.
func (s *Service) ResumeLoop(ctx context.Context, tx pgx.Tx, ref, loopID string, maxRounds int) (*TaskDetail, error) {
	r, l, err := lockedLoop(ctx, tx, ref, loopID)
	if err != nil {
		return nil, err
	}
	if l.State != LoopExhausted && l.State != LoopBlocked {
		return nil, apierr.New(409, "LOOP_NOT_PAUSED", "只有停在受阻或轮数用尽的审查循环可以继续。")
	}
	if maxRounds == 0 {
		maxRounds = l.MaxRounds
	}
	if maxRounds > MaxRounds {
		return nil, invalid(fmt.Sprintf("审查循环最多 %d 轮。", MaxRounds))
	}
	if maxRounds <= l.Rounds {
		return nil, invalid(fmt.Sprintf("已经审查了 %d 轮；要继续，把轮数上限调到 %d 以上。", l.Rounds, l.Rounds))
	}
	if r.Assignee != "remote" || !workable(r.Status) {
		return nil, apierr.New(409, "TASK_NOT_WORKABLE", "任务现在没有远程主执行者在做，审查循环无法继续。")
	}
	if _, err := tx.Exec(ctx, "UPDATE task_review_loop SET max_rounds = $2, state = 'active', reason = NULL, updated_at = $3 WHERE id = $1",
		l.ID, maxRounds, pg.Now()); err != nil {
		return nil, err
	}
	l.MaxRounds, l.State = maxRounds, LoopActive
	last, err := pg.One[assistRow](ctx, tx, "SELECT * FROM task_assist WHERE loop_id = $1 ORDER BY round DESC, created_at DESC LIMIT 1", l.ID)
	if err != nil {
		return nil, err
	}
	if l.Rounds > 0 && last != nil && deref(last.Verdict) == VerdictChanges && deref(last.Round) == l.Rounds {
		if err := s.rework(ctx, tx, r, l, last); err != nil {
			return nil, err
		}
		return detail(ctx, tx, r)
	}
	var runID string
	if err := tx.QueryRow(ctx, `SELECT id FROM task_run WHERE task_id = $1 AND NOT assist ORDER BY created_at DESC LIMIT 1`, r.ID).Scan(&runID); err != nil {
		if err == pgx.ErrNoRows {
			return nil, apierr.New(409, "NO_RUN", "主执行者还没有运行可以审查。")
		}
		return nil, err
	}
	if err := nextRound(ctx, tx, r, l, runID); err != nil {
		return nil, err
	}
	return detail(ctx, tx, r)
}

func lockedLoop(ctx context.Context, tx pgx.Tx, ref, loopID string) (*taskRow, *loopRow, error) {
	r, err := find(ctx, tx, ref, true)
	if err != nil {
		return nil, nil, err
	}
	id, ok := pg.ParseID(loopID)
	if !ok {
		return nil, nil, apierr.NotFound()
	}
	l, err := pg.One[loopRow](ctx, tx, "SELECT * FROM task_review_loop WHERE id = $1 AND task_id = $2 FOR UPDATE", id, r.ID)
	if err != nil {
		return nil, nil, err
	}
	if l == nil {
		return nil, nil, apierr.NotFound()
	}
	return r, l, nil
}

// ReviewInput is an assisting agent's structured result.
type ReviewInput struct {
	Verdict  string `json:"verdict" enum:"pass,changes_requested"`
	Feedback string `json:"feedback,omitempty" maxLength:"20000" doc:"What to change, actionably; required with changes_requested."`
}

// ReportReview records the calling assisting agent's verdict on its
// request, once; the same verdict again changes nothing. In a review loop,
// the round it was waiting for moves it on: a pass ends it; changes go to
// the assignee's session and the next round waits for that run, unless the
// budget is spent.
func (s *Service) ReportReview(ctx context.Context, tx pgx.Tx, c *RemoteComputer, ref string, in ReviewInput) error {
	r, err := remoteTask(ctx, tx, c, ref, true)
	if err != nil {
		return err
	}
	feedback := strings.TrimSpace(in.Feedback)
	switch in.Verdict {
	case VerdictPass:
	case VerdictChanges:
		if feedback == "" {
			return invalid("要求修改时需要写下具体要改什么（--file 或正文）。")
		}
	default:
		return invalid("结论只能是 pass 或 changes_requested。")
	}
	run, err := callerRun(ctx, tx, c, r.ID)
	if err != nil {
		return err
	}
	var a *assistRow
	if run != nil && run.Assist {
		if a, err = pg.One[assistRow](ctx, tx, "SELECT * FROM task_assist WHERE run_id = $1 FOR UPDATE", run.ID); err != nil {
			return err
		}
	}
	if a == nil {
		return apierr.New(403, "NOT_ASSISTING", "只有被请来协助的 Agent 能在自己的 worktree 里给出审查结论。")
	}
	if a.Verdict != nil {
		if *a.Verdict == in.Verdict && deref(a.Feedback) == feedback {
			return nil
		}
		return apierr.New(409, "VERDICT_GIVEN", "这次协助已经给出过结论，不能改；需要再审时由用户或主执行者另请协助。")
	}
	if _, err := tx.Exec(ctx, "UPDATE task_assist SET verdict = $2, feedback = $3, verdict_at = $4 WHERE id = $1",
		a.ID, in.Verdict, nonEmpty(feedback), pg.Now()); err != nil {
		return err
	}
	a.Verdict, a.Feedback = &in.Verdict, nonEmpty(feedback)
	data := remoteData(c, r, run)
	data["verdict"], data["assist_id"], data["head_sha"] = in.Verdict, a.ID, a.HeadSHA
	var l *loopRow
	if a.LoopID != nil {
		if l, err = pg.One[loopRow](ctx, tx, "SELECT * FROM task_review_loop WHERE id = $1 FOR UPDATE", *a.LoopID); err != nil {
			return err
		}
		data["loop_id"], data["round"], data["max_rounds"] = l.ID, a.Round, l.MaxRounds
	}
	body := feedback
	if body == "" {
		body = "审查通过。"
	}
	if err := record(ctx, tx, r.ID, &run.ID, "review", Remote, &body, data); err != nil {
		return err
	}
	// Only the round the loop waits for moves it.
	if l == nil || l.State != LoopActive || deref(a.Round) != l.Rounds+1 {
		return nil
	}
	l.Rounds = *a.Round
	if _, err := tx.Exec(ctx, "UPDATE task_review_loop SET rounds = $2, updated_at = $3 WHERE id = $1", l.ID, l.Rounds, pg.Now()); err != nil {
		return err
	}
	switch {
	case in.Verdict == VerdictPass:
		return setLoop(ctx, tx, l.ID, LoopPassed, fmt.Sprintf("第 %d 轮审查通过。", l.Rounds))
	case l.Rounds >= l.MaxRounds:
		return setLoop(ctx, tx, l.ID, LoopExhausted, fmt.Sprintf("%d 轮审查已用完，最后一轮仍要求修改；等你决定：继续（可调高轮数）或停止。", l.MaxRounds))
	case r.Assignee != "remote" || !workable(r.Status):
		return setLoop(ctx, tx, l.ID, LoopStopped, "任务现在没有远程主执行者在做。")
	}
	return s.rework(ctx, tx, r, l, a)
}

// rework sends a review's changes to the assignee's session as a run of its
// own, and has the next round wait for that run.
func (s *Service) rework(ctx context.Context, tx pgx.Tx, r *taskRow, l *loopRow, review *assistRow) error {
	runID, err := s.enqueueRun(ctx, tx, r, reworkPrompt(r, l, review))
	if err != nil {
		return err
	}
	return nextRound(ctx, tx, r, l, runID)
}

// nextRound has the loop's next review wait for the assignee's run, and
// puts it on the timeline as AXP's request.
func nextRound(ctx context.Context, tx pgx.Tx, r *taskRow, l *loopRow, afterRun string) error {
	next := l.Rounds + 1
	id, err := insertAssist(ctx, tx, assistRow{
		TaskID: r.ID, Runtime: l.Runtime, Provider: l.Provider, Request: l.Request, ReviewPull: true,
		AfterRunID: &afterRun, Waits: true, LoopID: &l.ID, Round: &next,
	})
	if err != nil {
		return err
	}
	return record(ctx, tx, r.ID, nil, "assist", System, &l.Request, map[string]any{
		"assist_id": id, "agent": map[string]any{"runtime": l.Runtime, "provider": l.Provider}, "computer_name": r.ComputerName,
		"after_run_id": afterRun, "loop_id": l.ID, "max_rounds": l.MaxRounds, "round": next,
	})
}

// RemoteAssist is a request for assistance from an agent on the computer.
func (s *Service) RemoteAssist(ctx context.Context, tx pgx.Tx, c *RemoteComputer, ref string, in AssistInput) (*TaskDetail, error) {
	r, err := remoteTask(ctx, tx, c, ref, true)
	if err != nil {
		return nil, err
	}
	run, err := callerRun(ctx, tx, c, r.ID)
	if err != nil {
		return nil, err
	}
	return s.assist(ctx, tx, r, in, Remote, remoteData(c, r, run))
}

// --- starting ----------------------------------------------------------------------------

// PullHead is a pull request's head commit, as GitHub has it now.
type PullHead func(ctx context.Context, url string) (string, error)

// readiness is whether a waiting request can start now: start, or the
// state it stays in (waiting, blocked) and why; pull and head when it can.
type readiness struct {
	start         bool
	state, reason string
	pull, head    string
}

// ready looks at what a waiting request depends on.
func (s *Service) ready(ctx context.Context, db pg.DB, a *assistRow) (readiness, error) {
	r, err := find(ctx, db, a.TaskID, false)
	if err != nil {
		return readiness{}, err
	}
	if r.Assignee != "remote" || !workable(r.Status) {
		return readiness{state: AssistCancelled, reason: "任务现在没有远程主执行者在做。"}, nil
	}
	var until time.Time
	if a.Waits {
		if a.AfterRunID == nil {
			return readiness{state: AssistBlocked, reason: "依赖的开发运行已经不在了。"}, nil
		}
		run, err := pg.One[runRow](ctx, db, "SELECT * FROM task_run WHERE id = $1", *a.AfterRunID)
		if err != nil {
			return readiness{}, err
		}
		switch {
		case run == nil:
			return readiness{state: AssistBlocked, reason: "依赖的开发运行已经不在了。"}, nil
		case run.Status == RunFailed:
			return readiness{state: AssistBlocked, reason: "依赖的开发运行失败了：" + deref(run.Error)}, nil
		case run.Status == RunCancelled:
			return readiness{state: AssistBlocked, reason: "依赖的开发运行被停止了：" + deref(run.Error)}, nil
		case run.Status != RunCompleted:
			return readiness{state: AssistWaiting, reason: "等主执行者这一轮完成并交付。"}, nil
		}
		if run.FinishedAt != nil {
			until = *run.FinishedAt
		}
		// Not while the assignee is at it again: its delivery would move.
		busy, err := pg.Exists(ctx, db, `SELECT 1 FROM task_run WHERE task_id = $1 AND NOT assist
			AND status IN ('queued', 'starting', 'running')`, r.ID)
		if err != nil {
			return readiness{}, err
		}
		if busy {
			return readiness{state: AssistWaiting, reason: "等主执行者手头的运行结束。"}, nil
		}
	}
	if !a.ReviewPull {
		return readiness{start: true}, nil
	}
	pull, err := latestPull(ctx, db, r.ID, until)
	if err != nil {
		return readiness{}, err
	}
	if pull == "" {
		if a.Waits {
			return readiness{state: AssistBlocked, reason: "开发这一轮完成了，但任务没有登记 PR，没有可审查的交付。"}, nil
		}
		return readiness{state: AssistBlocked, reason: "任务没有登记 PR。"}, nil
	}
	if s.PullHead == nil {
		return readiness{state: AssistWaiting, reason: "读不到 PR 的 head：代码托管服务没有配置。"}, nil
	}
	head, err := s.PullHead(ctx, pull)
	if err != nil || !commitSHA(head) {
		why := "GitHub 没有给出提交"
		if err != nil {
			why = err.Error()
		}
		return readiness{state: AssistWaiting, reason: "读不到 PR 的 head：" + why}, nil
	}
	return readiness{start: true, pull: pull, head: head}, nil
}

func commitSHA(s string) bool {
	if len(s) != 40 {
		return false
	}
	for _, c := range s {
		if (c < '0' || c > '9') && (c < 'a' || c > 'f') {
			return false
		}
	}
	return true
}

// start makes a ready request a run of the assisting lane, checking again
// under the task's lock what may have changed since it was looked at.
func (s *Service) start(ctx context.Context, tx pgx.Tx, assistID string, ready readiness) error {
	a, err := pg.One[assistRow](ctx, tx, "SELECT * FROM task_assist WHERE id = $1", assistID)
	if err != nil || a == nil {
		return err
	}
	r, err := find(ctx, tx, a.TaskID, true)
	if err != nil {
		return err
	}
	if a, err = pg.One[assistRow](ctx, tx, "SELECT * FROM task_assist WHERE id = $1 AND state = 'waiting' FOR UPDATE", assistID); err != nil || a == nil {
		return err
	}
	if r.Assignee != "remote" || !workable(r.Status) {
		return nil
	}
	if a.Waits {
		ok, err := pg.Exists(ctx, tx, `SELECT 1 FROM task_run d WHERE d.id = $1 AND d.status = 'completed' AND NOT EXISTS (
			SELECT 1 FROM task_run m WHERE m.task_id = d.task_id AND NOT m.assist AND m.status IN ('queued', 'starting', 'running'))`, a.AfterRunID)
		if err != nil || !ok {
			return err
		}
	}
	var loop *loopRow
	if a.LoopID != nil {
		if loop, err = pg.One[loopRow](ctx, tx, "SELECT * FROM task_review_loop WHERE id = $1", *a.LoopID); err != nil {
			return err
		}
		if loop.State != LoopActive {
			_, err := tx.Exec(ctx, "UPDATE task_assist SET state = 'cancelled', reason = '审查循环已结束。' WHERE id = $1", a.ID)
			return err
		}
	}
	runID := pg.NewID()
	if _, err := tx.Exec(ctx, `INSERT INTO task_run (id, task_id, computer_id, runtime, provider, status, prompt, created_at, assist)
		VALUES ($1, $2, $3, $4, $5, 'queued', $6, $7, true)`,
		runID, r.ID, *r.ComputerID, a.Runtime, a.Provider, assistPrompt(r, a, ready.pull, ready.head, loop), pg.Now()); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `UPDATE task_assist SET state = 'started', reason = NULL, run_id = $2, pull_url = $3, head_sha = $4,
		started_at = $5 WHERE id = $1`, a.ID, runID, nonEmpty(ready.pull), nonEmpty(ready.head), pg.Now()); err != nil {
		return err
	}
	return record(ctx, tx, r.ID, &runID, "run_queued", System, nil, map[string]any{"assist_id": a.ID})
}

// hold leaves a request waiting or blocks or cancels it, with why; a loop
// whose round is blocked is blocked too.
func hold(ctx context.Context, tx pgx.Tx, a *assistRow, ready readiness) error {
	if _, err := tx.Exec(ctx, `UPDATE task_assist SET state = $2, reason = $3 WHERE id = $1 AND state = 'waiting'
		AND (state <> $2 OR reason IS DISTINCT FROM $3)`, a.ID, ready.state, ready.reason); err != nil {
		return err
	}
	if a.LoopID != nil && ready.state != AssistWaiting {
		state := LoopBlocked
		if ready.state == AssistCancelled {
			state = LoopStopped
		}
		return setLoop(ctx, tx, *a.LoopID, state, fmt.Sprintf("第 %d 轮审查没有开始：%s", deref(a.Round), ready.reason))
	}
	return nil
}

// settleLoop blocks an active loop whose current review ended without a
// verdict: failed, stopped, or done without `axp task review`.
func settleLoop(ctx context.Context, tx pgx.Tx, l *loopRow) error {
	a, err := pg.One[assistRow](ctx, tx, `SELECT * FROM task_assist WHERE loop_id = $1 ORDER BY round DESC, created_at DESC LIMIT 1`, l.ID)
	if err != nil || a == nil || a.State != AssistStarted || a.Verdict != nil || a.RunID == nil {
		return err
	}
	run, err := pg.One[runRow](ctx, tx, "SELECT * FROM task_run WHERE id = $1", *a.RunID)
	if err != nil || run == nil {
		return err
	}
	var why string
	switch run.Status {
	case RunFailed:
		why = "失败了：" + deref(run.Error)
	case RunCancelled:
		why = "被停止了。"
	case RunCompleted:
		why = "结束了，但没有用 axp task review 给出结论。"
	default:
		return nil
	}
	return setLoop(ctx, tx, l.ID, LoopBlocked, fmt.Sprintf("第 %d 轮审查%s", deref(a.Round), why))
}

// ForgePullHead reads pull requests' heads from the forge service, with
// the GitHub App's or the authorizing user's token.
func ForgePullHead(forgeURL string) PullHead {
	if forgeURL == "" {
		return nil
	}
	return func(ctx context.Context, pull string) (string, error) {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet,
			strings.TrimRight(forgeURL, "/")+"/api/forge/v1/pulls?url="+url.QueryEscape(pull), nil)
		if err != nil {
			return "", err
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			return "", errors.New("代码托管服务不可用")
		}
		defer resp.Body.Close()
		var out struct {
			HeadSHA string `json:"head_sha"`
			Error   struct {
				Message string `json:"message"`
			} `json:"error"`
		}
		_ = json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&out)
		if resp.StatusCode != http.StatusOK {
			if out.Error.Message == "" {
				out.Error.Message = resp.Status
			}
			return "", errors.New(out.Error.Message)
		}
		return out.HeadSHA, nil
	}
}
