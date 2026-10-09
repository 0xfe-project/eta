// Package routines is agents that run on a schedule and leave reports
// (docs/architecture/routines.md).
//
// A routine has a versioned brief, a schedule and a history of runs. Each run
// is an ADK agent in this process, may leave a report, and leaves a handoff
// note for the next run. The user's feedback on a run revises the brief.
//
// A routine's schedule lives in NATS; every write that changes whether or
// when it runs updates it before its transaction commits, so a failure rolls
// the write back.
package routines

import (
	"context"
	"log/slog"
	"strings"
	"time"

	"github.com/akarachen/axp/apps/routine-service/internal/store"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// RunHistory is how many runs the browser gets per routine.
const RunHistory = 30

const (
	RunRunning    = "running"
	RunSent       = "sent"
	RunNothingNew = "nothing_new"
	RunFailed     = "failed"
)

type routineRow struct {
	ID        string    `db:"id"`
	Name      string    `db:"name"`
	Model     string    `db:"model"`
	Schedule  Schedule  `db:"schedule"`
	Timezone  string    `db:"timezone"`
	Enabled   bool      `db:"enabled"`
	CreatedAt time.Time `db:"created_at"`
	UpdatedAt time.Time `db:"updated_at"`
}

type runRow struct {
	ID         string     `db:"id"`
	RoutineID  string     `db:"routine_id"`
	Status     string     `db:"status"`
	StartedAt  time.Time  `db:"started_at"`
	FinishedAt *time.Time `db:"finished_at"`
	Report     *string    `db:"report"`
	Handoff    *string    `db:"handoff"`
	Error      *string    `db:"error"`
}

// title is the report's first heading, or its first line.
func (r *runRow) title() *string {
	if r.Report == nil {
		return nil
	}
	first, _, _ := strings.Cut(strings.TrimSpace(strings.ReplaceAll(*r.Report, "\r", "\n")), "\n")
	title := []rune(strings.TrimSpace(strings.TrimLeft(first, "#")))
	if len(title) > 200 {
		title = title[:200]
	}
	if len(title) == 0 {
		return nil
	}
	s := string(title)
	return &s
}

type feedbackRow struct {
	ID             string    `db:"id"`
	RunID          string    `db:"run_id"`
	Text           string    `db:"text"`
	CreatedAt      time.Time `db:"created_at"`
	RevisionFailed bool      `db:"revision_failed"`
	// The brief version it led to (joined).
	BriefVersion *int32 `db:"brief_version"`
}

type briefRow struct {
	Version   int32     `db:"version"`
	Text      string    `db:"text"`
	CreatedAt time.Time `db:"created_at"`
	// The feedback this version was revised from (joined); none when the
	// user wrote it.
	FeedbackText *string `db:"feedback_text"`
}

// --- public shapes ---------------------------------------------------------------

type Feedback struct {
	ID             string `json:"id"`
	Text           string `json:"text"`
	CreatedAt      Time   `json:"created_at"`
	BriefVersion   *int32 `json:"brief_version" doc:"The brief version it led to; null while the revision runs."`
	RevisionFailed bool   `json:"revision_failed"`
}

type Run struct {
	ID         string     `json:"id"`
	StartedAt  Time       `json:"started_at"`
	FinishedAt *Time      `json:"finished_at" nullable:"true"`
	Status     string     `json:"status" enum:"running,sent,nothing_new,failed"`
	Title      *string    `json:"title" doc:"The report's first heading, if it sent one."`
	Report     *string    `json:"report"`
	Error      *string    `json:"error"`
	Feedback   []Feedback `json:"feedback"`
}

type Brief struct {
	Version   int32   `json:"version"`
	Text      string  `json:"text"`
	CreatedAt Time    `json:"created_at"`
	Feedback  *string `json:"feedback" doc:"The feedback that revised it; null when the user wrote it."`
}

type Handoff struct {
	_         struct{} `nullable:"true"`
	Text      string   `json:"text"`
	WrittenAt Time     `json:"written_at"`
}

type Routine struct {
	ID        string   `json:"id"`
	Name      string   `json:"name"`
	Model     string   `json:"model"`
	Schedule  Schedule `json:"schedule"`
	Timezone  string   `json:"timezone"`
	Enabled   bool     `json:"enabled"`
	NextRunAt *Time    `json:"next_run_at" nullable:"true"`
	Briefs    []Brief  `json:"briefs"`
	Handoff   *Handoff `json:"handoff"`
	Runs      []Run    `json:"runs"`
}

// Schedules is where routines' schedules live (NATS).
type Schedules interface {
	// Schedule fires the routine on a five-field cron in timezone,
	// replacing any earlier schedule.
	Schedule(ctx context.Context, routineID, cron, timezone string) error
	Unschedule(ctx context.Context, routineID string) error
	// Fire runs the routine now, as if its schedule fired.
	Fire(ctx context.Context, routineID string) error
}

// Service is the routines as the browser sees and changes them.
type Service struct {
	DB        *pgxpool.Pool
	Schedules Schedules
	Models    Catalog
	// Revise revises the brief from new feedback, in the background.
	Revise func(feedbackID string)
}

func newID() string { return uuid.NewString() }

// now is the current time, at the database's precision.
func now() time.Time { return time.Now().UTC().Truncate(time.Microsecond) }

func parseID(id string) (string, bool) {
	parsed, err := uuid.Parse(id)
	if err != nil {
		return "", false
	}
	return parsed.String(), true
}

func feedbackFor(ctx context.Context, db store.DB, runIDs []string) (map[string][]Feedback, error) {
	rows, err := store.All[feedbackRow](ctx, db, `SELECT f.*, b.version AS brief_version
		FROM routine_feedback f LEFT JOIN routine_brief b ON b.feedback_id = f.id
		WHERE f.run_id = ANY($1) ORDER BY f.created_at`, runIDs)
	if err != nil {
		return nil, err
	}
	byRun := map[string][]Feedback{}
	for _, f := range rows {
		byRun[f.RunID] = append(byRun[f.RunID], f.public())
	}
	return byRun, nil
}

func (f *feedbackRow) public() Feedback {
	return Feedback{
		ID: f.ID, Text: f.Text, CreatedAt: Time{f.CreatedAt},
		BriefVersion: f.BriefVersion, RevisionFailed: f.RevisionFailed,
	}
}

func public(ctx context.Context, db store.DB, r *routineRow) (*Routine, error) {
	runs, err := store.All[runRow](ctx, db, `SELECT * FROM routine_run WHERE routine_id = $1
		ORDER BY started_at DESC LIMIT $2`, r.ID, RunHistory)
	if err != nil {
		return nil, err
	}
	ids := make([]string, len(runs))
	for i, run := range runs {
		ids[i] = run.ID
	}
	feedback, err := feedbackFor(ctx, db, ids)
	if err != nil {
		return nil, err
	}
	briefs, err := store.All[briefRow](ctx, db, `SELECT b.version, b.text, b.created_at, f.text AS feedback_text
		FROM routine_brief b LEFT JOIN routine_feedback f ON f.id = b.feedback_id
		WHERE b.routine_id = $1 ORDER BY b.version DESC`, r.ID)
	if err != nil {
		return nil, err
	}
	out := &Routine{
		ID: r.ID, Name: r.Name, Model: r.Model, Schedule: r.Schedule, Timezone: r.Timezone,
		Enabled: r.Enabled, Briefs: []Brief{}, Runs: []Run{},
	}
	if r.Enabled {
		if next, err := NextRun(r.Schedule, r.Timezone, time.Now()); err == nil {
			out.NextRunAt = &Time{next}
		}
	}
	for _, b := range briefs {
		out.Briefs = append(out.Briefs, Brief{Version: b.Version, Text: b.Text, CreatedAt: Time{b.CreatedAt}, Feedback: b.FeedbackText})
	}
	for _, run := range runs {
		if out.Handoff == nil && run.Handoff != nil && *run.Handoff != "" && run.FinishedAt != nil {
			out.Handoff = &Handoff{Text: *run.Handoff, WrittenAt: Time{*run.FinishedAt}}
		}
		fb := feedback[run.ID]
		if fb == nil {
			fb = []Feedback{}
		}
		var finished *Time
		if run.FinishedAt != nil {
			finished = &Time{*run.FinishedAt}
		}
		out.Runs = append(out.Runs, Run{
			ID: run.ID, StartedAt: Time{run.StartedAt}, FinishedAt: finished,
			Status: run.Status, Title: run.title(), Report: run.Report, Error: run.Error, Feedback: fb,
		})
	}
	return out, nil
}

func get(ctx context.Context, db store.DB, id string, lock bool) (*routineRow, error) {
	parsed, ok := parseID(id)
	if !ok {
		return nil, NotFound()
	}
	sql := "SELECT * FROM routine WHERE id = $1"
	if lock {
		sql += " FOR UPDATE"
	}
	r, err := store.One[routineRow](ctx, db, sql, parsed)
	if err != nil {
		return nil, err
	}
	if r == nil {
		return nil, NotFound()
	}
	return r, nil
}

func (s *Service) Get(ctx context.Context, id string) (*Routine, error) {
	r, err := get(ctx, s.DB, id, false)
	if err != nil {
		return nil, err
	}
	return public(ctx, s.DB, r)
}

func (s *Service) List(ctx context.Context) ([]Routine, error) {
	rows, err := store.All[routineRow](ctx, s.DB, "SELECT * FROM routine ORDER BY created_at")
	if err != nil {
		return nil, err
	}
	out := []Routine{}
	for _, r := range rows {
		p, err := public(ctx, s.DB, r)
		if err != nil {
			return nil, err
		}
		out = append(out, *p)
	}
	return out, nil
}

// --- writes ------------------------------------------------------------------------

func scheduleUnavailable(ctx context.Context, err error) error {
	slog.ErrorContext(ctx, "Routine schedules unavailable", "error", err)
	return New(503, "QUEUE_UNAVAILABLE", "消息队列暂时不可用，请稍后再试。")
}

func (s *Service) syncSchedule(ctx context.Context, r *routineRow) error {
	var err error
	if r.Enabled {
		err = s.Schedules.Schedule(ctx, r.ID, r.Schedule.Cron5(), r.Timezone)
	} else {
		err = s.Schedules.Unschedule(ctx, r.ID)
	}
	if err != nil {
		return scheduleUnavailable(ctx, err)
	}
	return nil
}

func addBrief(ctx context.Context, tx pgx.Tx, routineID, text string, feedbackID *string) error {
	_, err := tx.Exec(ctx, `INSERT INTO routine_brief (routine_id, version, text, feedback_id, created_at)
		VALUES ($1, COALESCE((SELECT max(version) FROM routine_brief WHERE routine_id = $1), 0) + 1, $2, $3, $4)`,
		routineID, text, feedbackID, now())
	return err
}

func (s *Service) inTx(ctx context.Context, fn func(pgx.Tx) (*routineRow, error)) (*Routine, error) {
	var out *Routine
	err := store.InTx(ctx, s.DB, func(tx pgx.Tx) error {
		r, err := fn(tx)
		if err != nil {
			return err
		}
		out, err = public(ctx, tx, r)
		return err
	})
	return out, err
}

type Input struct {
	Name     string
	Brief    string
	Model    string
	Schedule Schedule
	Timezone string
}

func (s *Service) Create(ctx context.Context, in Input) (*Routine, error) {
	if err := Validate(ctx, s.Models, in.Model); err != nil {
		return nil, err
	}
	if err := CheckSchedule(in.Schedule, in.Timezone); err != nil {
		return nil, err
	}
	return s.inTx(ctx, func(tx pgx.Tx) (*routineRow, error) {
		t := now()
		r := &routineRow{
			ID: newID(), Name: in.Name, Model: in.Model, Schedule: in.Schedule, Timezone: in.Timezone,
			Enabled: true, CreatedAt: t, UpdatedAt: t,
		}
		if _, err := tx.Exec(ctx, `INSERT INTO routine (id, name, model, schedule, timezone, enabled, created_at, updated_at)
			VALUES ($1, $2, $3, $4, $5, true, $6, $6)`, r.ID, r.Name, r.Model, r.Schedule, r.Timezone, t); err != nil {
			return nil, err
		}
		if err := addBrief(ctx, tx, r.ID, in.Brief, nil); err != nil {
			return nil, err
		}
		return r, s.syncSchedule(ctx, r)
	})
}

// Changes are the fields an update sets; nil ones stay.
type Changes struct {
	Name     *string
	Brief    *string
	Model    *string
	Schedule *Schedule
	Timezone *string
	Enabled  *bool
}

func (s *Service) Update(ctx context.Context, id string, c Changes) (*Routine, error) {
	if c.Model != nil {
		if err := Validate(ctx, s.Models, *c.Model); err != nil {
			return nil, err
		}
	}
	return s.inTx(ctx, func(tx pgx.Tx) (*routineRow, error) {
		r, err := get(ctx, tx, id, true)
		if err != nil {
			return nil, err
		}
		if c.Name != nil {
			r.Name = *c.Name
		}
		if c.Model != nil {
			r.Model = *c.Model
		}
		if c.Schedule != nil {
			r.Schedule = *c.Schedule
		}
		if c.Timezone != nil {
			r.Timezone = *c.Timezone
		}
		if c.Enabled != nil {
			r.Enabled = *c.Enabled
		}
		if err := CheckSchedule(r.Schedule, r.Timezone); err != nil {
			return nil, err
		}
		if _, err := tx.Exec(ctx, `UPDATE routine SET name = $2, model = $3, schedule = $4, timezone = $5,
			enabled = $6, updated_at = $7 WHERE id = $1`, r.ID, r.Name, r.Model, r.Schedule, r.Timezone, r.Enabled, now()); err != nil {
			return nil, err
		}
		if c.Brief != nil {
			var latest string
			if err := tx.QueryRow(ctx, `SELECT text FROM routine_brief WHERE routine_id = $1
				ORDER BY version DESC LIMIT 1`, r.ID).Scan(&latest); err != nil {
				return nil, err
			}
			if *c.Brief != latest {
				if err := addBrief(ctx, tx, r.ID, *c.Brief, nil); err != nil {
					return nil, err
				}
			}
		}
		if c.Schedule != nil || c.Timezone != nil || c.Enabled != nil {
			return r, s.syncSchedule(ctx, r)
		}
		return r, nil
	})
}

func (s *Service) Delete(ctx context.Context, id string) error {
	return store.InTx(ctx, s.DB, func(tx pgx.Tx) error {
		r, err := get(ctx, tx, id, true)
		if err != nil {
			return err
		}
		running, err := store.Exists(ctx, tx, "SELECT 1 FROM routine_run WHERE routine_id = $1 AND status = 'running'", r.ID)
		if err != nil {
			return err
		}
		if running {
			return New(409, "ROUTINE_RUNNING", "这个定时任务正在运行，稍后再删除。")
		}
		if err := s.Schedules.Unschedule(ctx, r.ID); err != nil {
			return scheduleUnavailable(ctx, err)
		}
		_, err = tx.Exec(ctx, "DELETE FROM routine WHERE id = $1", r.ID)
		return err
	})
}

// RunNow fires the routine; the run starts when the fire arrives.
func (s *Service) RunNow(ctx context.Context, id string) (*Routine, error) {
	r, err := get(ctx, s.DB, id, false)
	if err != nil {
		return nil, err
	}
	running, err := store.Exists(ctx, s.DB, "SELECT 1 FROM routine_run WHERE routine_id = $1 AND status = 'running'", r.ID)
	if err != nil {
		return nil, err
	}
	if running {
		return nil, New(409, "ROUTINE_RUNNING", "这个定时任务正在运行。")
	}
	if err := s.Schedules.Fire(ctx, r.ID); err != nil {
		return nil, scheduleUnavailable(ctx, err)
	}
	return public(ctx, s.DB, r)
}

// RestoreBrief makes an old version the current one (as a new version).
func (s *Service) RestoreBrief(ctx context.Context, id string, version int) (*Routine, error) {
	return s.inTx(ctx, func(tx pgx.Tx) (*routineRow, error) {
		r, err := get(ctx, tx, id, true)
		if err != nil {
			return nil, err
		}
		var text string
		err = tx.QueryRow(ctx, "SELECT text FROM routine_brief WHERE routine_id = $1 AND version = $2", r.ID, version).Scan(&text)
		if err == pgx.ErrNoRows {
			return nil, NotFound()
		}
		if err != nil {
			return nil, err
		}
		return r, addBrief(ctx, tx, r.ID, text, nil)
	})
}

// AddFeedback records the user's feedback on a run, then revises the brief
// from it in the background.
func (s *Service) AddFeedback(ctx context.Context, routineID, runID, text string) (*Feedback, error) {
	routine, ok1 := parseID(routineID)
	run, ok2 := parseID(runID)
	if !ok1 || !ok2 {
		return nil, NotFound()
	}
	found, err := store.Exists(ctx, s.DB, "SELECT 1 FROM routine_run WHERE id = $1 AND routine_id = $2", run, routine)
	if err != nil {
		return nil, err
	}
	if !found {
		return nil, NotFound()
	}
	f := &feedbackRow{ID: newID(), RunID: run, Text: text, CreatedAt: now()}
	if _, err := s.DB.Exec(ctx, `INSERT INTO routine_feedback (id, run_id, text, created_at)
		VALUES ($1, $2, $3, $4)`, f.ID, f.RunID, f.Text, f.CreatedAt); err != nil {
		return nil, err
	}
	if s.Revise != nil {
		s.Revise(f.ID)
	}
	p := f.public()
	return &p, nil
}
