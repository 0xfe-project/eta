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

	"github.com/akarachen/axp/packages/service-go/apierr"
	"github.com/akarachen/axp/packages/service-go/jsontime"
	"github.com/akarachen/axp/packages/service-go/pg"
	"github.com/jackc/pgx/v5"
)

// RunHistory is how many runs a routine's page gets.
const RunHistory = 30

// ListRuns is how many runs, in summary, a routine's line in the list gets.
const ListRuns = 14

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
	SeenAt     *time.Time `db:"seen_at"`
}

// title is the report's first heading, or its first line.
func (r *runRow) title() *string { return reportTitle(r.Report) }

func reportTitle(report *string) *string {
	if report == nil {
		return nil
	}
	first, _, _ := strings.Cut(strings.TrimSpace(strings.ReplaceAll(*report, "\r", "\n")), "\n")
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
	ID             string        `json:"id"`
	Text           string        `json:"text"`
	CreatedAt      jsontime.Time `json:"created_at"`
	BriefVersion   *int32        `json:"brief_version" doc:"The brief version it led to; null while the revision runs."`
	RevisionFailed bool          `json:"revision_failed"`
}

type Run struct {
	ID         string         `json:"id"`
	StartedAt  jsontime.Time  `json:"started_at"`
	FinishedAt *jsontime.Time `json:"finished_at" nullable:"true"`
	Status     string         `json:"status" enum:"running,sent,nothing_new,failed"`
	Title      *string        `json:"title" doc:"The report's first heading, if it sent one."`
	Report     *string        `json:"report"`
	Error      *string        `json:"error"`
	Feedback   []Feedback     `json:"feedback"`
}

type Brief struct {
	Version   int32         `json:"version"`
	Text      string        `json:"text"`
	CreatedAt jsontime.Time `json:"created_at"`
	Feedback  *string       `json:"feedback" doc:"The feedback that revised it; null when the user wrote it."`
}

type Handoff struct {
	_         struct{}      `nullable:"true"`
	Text      string        `json:"text"`
	WrittenAt jsontime.Time `json:"written_at"`
}

// ListedRun is a run as the list shows it: no report, no feedback.
type ListedRun struct {
	ID         string         `json:"id"`
	StartedAt  jsontime.Time  `json:"started_at"`
	FinishedAt *jsontime.Time `json:"finished_at" nullable:"true"`
	Status     string         `json:"status" enum:"running,sent,nothing_new,failed"`
	Title      *string        `json:"title" doc:"The report's first heading, if it sent one."`
}

// RoutineSummary is a routine as the list shows it; its page (Get) has the
// briefs, the reports and the feedback.
type RoutineSummary struct {
	ID        string         `json:"id"`
	Name      string         `json:"name"`
	Model     string         `json:"model"`
	Schedule  Schedule       `json:"schedule"`
	Timezone  string         `json:"timezone"`
	Enabled   bool           `json:"enabled"`
	NextRunAt *jsontime.Time `json:"next_run_at" nullable:"true"`
	Runs      []ListedRun    `json:"runs" doc:"The last runs, newest first."`
	Revising  bool           `json:"revising" doc:"Feedback on one of its runs is being made into a new brief."`
	// Finished runs the user has not seen (MarkSeen).
	UnseenReports  int64 `json:"unseen_reports" doc:"Reports the user has not seen yet."`
	UnseenFailures int64 `json:"unseen_failures" doc:"Failed runs the user has not seen yet."`
}

type Routine struct {
	ID        string         `json:"id"`
	Name      string         `json:"name"`
	Model     string         `json:"model"`
	Schedule  Schedule       `json:"schedule"`
	Timezone  string         `json:"timezone"`
	Enabled   bool           `json:"enabled"`
	NextRunAt *jsontime.Time `json:"next_run_at" nullable:"true"`
	Briefs    []Brief        `json:"briefs"`
	Handoff   *Handoff       `json:"handoff"`
	Runs      []Run          `json:"runs"`
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

// Service is the routines as the browser sees and changes them. Reads take
// any DB; writes take the caller's transaction, which commits them.
type Service struct {
	Schedules Schedules
	Models    Catalog
}

func feedbackFor(ctx context.Context, db pg.DB, runIDs []string) (map[string][]Feedback, error) {
	rows, err := pg.All[feedbackRow](ctx, db, `SELECT f.*, b.version AS brief_version
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
		ID: f.ID, Text: f.Text, CreatedAt: jsontime.From(f.CreatedAt),
		BriefVersion: f.BriefVersion, RevisionFailed: f.RevisionFailed,
	}
}

func public(ctx context.Context, db pg.DB, r *routineRow) (*Routine, error) {
	runs, err := pg.All[runRow](ctx, db, `SELECT * FROM routine_run WHERE routine_id = $1
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
	briefs, err := pg.All[briefRow](ctx, db, `SELECT b.version, b.text, b.created_at, f.text AS feedback_text
		FROM routine_brief b LEFT JOIN routine_feedback f ON f.id = b.feedback_id
		WHERE b.routine_id = $1 ORDER BY b.version DESC`, r.ID)
	if err != nil {
		return nil, err
	}
	out := &Routine{
		ID: r.ID, Name: r.Name, Model: r.Model, Schedule: r.Schedule, Timezone: r.Timezone,
		Enabled: r.Enabled, NextRunAt: nextRunAt(r), Briefs: []Brief{}, Runs: []Run{},
	}
	for _, b := range briefs {
		out.Briefs = append(out.Briefs, Brief{Version: b.Version, Text: b.Text, CreatedAt: jsontime.From(b.CreatedAt), Feedback: b.FeedbackText})
	}
	for _, run := range runs {
		if out.Handoff == nil && run.Handoff != nil && *run.Handoff != "" && run.FinishedAt != nil {
			out.Handoff = &Handoff{Text: *run.Handoff, WrittenAt: jsontime.From(*run.FinishedAt)}
		}
		fb := feedback[run.ID]
		if fb == nil {
			fb = []Feedback{}
		}
		out.Runs = append(out.Runs, Run{
			ID: run.ID, StartedAt: jsontime.From(run.StartedAt), FinishedAt: jsontime.Ptr(run.FinishedAt),
			Status: run.Status, Title: run.title(), Report: run.Report, Error: run.Error, Feedback: fb,
		})
	}
	return out, nil
}

func get(ctx context.Context, db pg.DB, id string, lock bool) (*routineRow, error) {
	parsed, ok := pg.ParseID(id)
	if !ok {
		return nil, apierr.NotFound()
	}
	sql := "SELECT * FROM routine WHERE id = $1"
	if lock {
		sql += " FOR UPDATE"
	}
	r, err := pg.One[routineRow](ctx, db, sql, parsed)
	if err != nil {
		return nil, err
	}
	if r == nil {
		return nil, apierr.NotFound()
	}
	return r, nil
}

func (s *Service) Get(ctx context.Context, db pg.DB, id string) (*Routine, error) {
	r, err := get(ctx, db, id, false)
	if err != nil {
		return nil, err
	}
	return public(ctx, db, r)
}

// List is every routine in summary: four queries however many there are.
func (s *Service) List(ctx context.Context, db pg.DB) ([]RoutineSummary, error) {
	rows, err := pg.All[routineRow](ctx, db, "SELECT * FROM routine ORDER BY created_at")
	if err != nil {
		return nil, err
	}
	// Each routine's last runs, by its index; of a report only the first
	// line, which its title comes from.
	runs, err := pg.All[struct {
		RoutineID  string     `db:"routine_id"`
		ID         string     `db:"id"`
		Status     string     `db:"status"`
		StartedAt  time.Time  `db:"started_at"`
		FinishedAt *time.Time `db:"finished_at"`
		FirstLine  *string    `db:"first_line"`
	}](ctx, db, `SELECT rt.id AS routine_id, run.* FROM routine rt CROSS JOIN LATERAL (
			SELECT id, status, started_at, finished_at,
				left(split_part(btrim(replace(report, E'\r', E'\n')), E'\n', 1), 1000) AS first_line
			FROM routine_run WHERE routine_id = rt.id ORDER BY started_at DESC LIMIT $1) run
		ORDER BY run.started_at DESC`, ListRuns)
	if err != nil {
		return nil, err
	}
	revising, err := pg.All[struct {
		RoutineID string `db:"routine_id"`
	}](ctx, db, `SELECT DISTINCT run.routine_id FROM routine_feedback f JOIN routine_run run ON run.id = f.run_id
		WHERE NOT f.revision_failed AND NOT EXISTS (SELECT 1 FROM routine_brief b WHERE b.feedback_id = f.id)`)
	if err != nil {
		return nil, err
	}
	unseen, err := pg.All[struct {
		RoutineID string `db:"routine_id"`
		Reports   int64  `db:"reports"`
		Failures  int64  `db:"failures"`
	}](ctx, db, `SELECT routine_id, count(*) FILTER (WHERE status = 'sent') AS reports,
		count(*) FILTER (WHERE status = 'failed') AS failures
		FROM routine_run WHERE seen_at IS NULL AND finished_at IS NOT NULL GROUP BY routine_id`)
	if err != nil {
		return nil, err
	}
	out := make([]RoutineSummary, len(rows))
	index := map[string]*RoutineSummary{}
	for i, r := range rows {
		out[i] = RoutineSummary{
			ID: r.ID, Name: r.Name, Model: r.Model, Schedule: r.Schedule, Timezone: r.Timezone,
			Enabled: r.Enabled, NextRunAt: nextRunAt(r), Runs: []ListedRun{},
		}
		index[r.ID] = &out[i]
	}
	for _, run := range runs {
		if r := index[run.RoutineID]; r != nil {
			r.Runs = append(r.Runs, ListedRun{
				ID: run.ID, StartedAt: jsontime.From(run.StartedAt), FinishedAt: jsontime.Ptr(run.FinishedAt),
				Status: run.Status, Title: reportTitle(run.FirstLine),
			})
		}
	}
	for _, f := range revising {
		if r := index[f.RoutineID]; r != nil {
			r.Revising = true
		}
	}
	for _, u := range unseen {
		if r := index[u.RoutineID]; r != nil {
			r.UnseenReports, r.UnseenFailures = u.Reports, u.Failures
		}
	}
	return out, nil
}

// MarkSeen records that the user saw the routine's finished runs.
func (s *Service) MarkSeen(ctx context.Context, db pg.DB, id string) error {
	r, err := get(ctx, db, id, false)
	if err != nil {
		return err
	}
	_, err = db.Exec(ctx, `UPDATE routine_run SET seen_at = $2 WHERE routine_id = $1 AND seen_at IS NULL
		AND finished_at IS NOT NULL`, r.ID, pg.Now())
	return err
}

// nextRunAt is when an enabled routine runs next.
func nextRunAt(r *routineRow) *jsontime.Time {
	if !r.Enabled {
		return nil
	}
	next, err := NextRun(r.Schedule, r.Timezone, time.Now())
	if err != nil {
		return nil
	}
	return jsontime.Ptr(&next)
}

// --- writes ------------------------------------------------------------------------

func scheduleUnavailable(ctx context.Context, err error) error {
	slog.ErrorContext(ctx, "Routine schedules unavailable", "error", err)
	return apierr.New(503, "QUEUE_UNAVAILABLE", "消息队列暂时不可用，请稍后再试。")
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
		routineID, text, feedbackID, pg.Now())
	return err
}

type Input struct {
	Name     string
	Brief    string
	Model    string
	Schedule Schedule
	Timezone string
}

func (s *Service) Create(ctx context.Context, tx pgx.Tx, in Input) (*Routine, error) {
	if err := Validate(ctx, s.Models, in.Model); err != nil {
		return nil, err
	}
	if err := CheckSchedule(in.Schedule, in.Timezone); err != nil {
		return nil, err
	}
	t := pg.Now()
	r := &routineRow{
		ID: pg.NewID(), Name: in.Name, Model: in.Model, Schedule: in.Schedule, Timezone: in.Timezone,
		Enabled: true, CreatedAt: t, UpdatedAt: t,
	}
	if _, err := tx.Exec(ctx, `INSERT INTO routine (id, name, model, schedule, timezone, enabled, created_at, updated_at)
			VALUES ($1, $2, $3, $4, $5, true, $6, $6)`, r.ID, r.Name, r.Model, r.Schedule, r.Timezone, t); err != nil {
		return nil, err
	}
	if err := addBrief(ctx, tx, r.ID, in.Brief, nil); err != nil {
		return nil, err
	}
	if err := s.syncSchedule(ctx, r); err != nil {
		return nil, err
	}
	return public(ctx, tx, r)
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

func (s *Service) Update(ctx context.Context, tx pgx.Tx, id string, c Changes) (*Routine, error) {
	if c.Model != nil {
		if err := Validate(ctx, s.Models, *c.Model); err != nil {
			return nil, err
		}
	}
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
			enabled = $6, updated_at = $7 WHERE id = $1`, r.ID, r.Name, r.Model, r.Schedule, r.Timezone, r.Enabled, pg.Now()); err != nil {
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
		if err := s.syncSchedule(ctx, r); err != nil {
			return nil, err
		}
	}
	return public(ctx, tx, r)
}

func (s *Service) Delete(ctx context.Context, tx pgx.Tx, id string) error {
	r, err := get(ctx, tx, id, true)
	if err != nil {
		return err
	}
	running, err := pg.Exists(ctx, tx, "SELECT 1 FROM routine_run WHERE routine_id = $1 AND status = 'running'", r.ID)
	if err != nil {
		return err
	}
	if running {
		return apierr.New(409, "ROUTINE_RUNNING", "这个定时任务正在运行，稍后再删除。")
	}
	if err := s.Schedules.Unschedule(ctx, r.ID); err != nil {
		return scheduleUnavailable(ctx, err)
	}
	_, err = tx.Exec(ctx, "DELETE FROM routine WHERE id = $1", r.ID)
	return err
}

// RunNow fires the routine; the run starts when the fire arrives.
func (s *Service) RunNow(ctx context.Context, db pg.DB, id string) (*Routine, error) {
	r, err := get(ctx, db, id, false)
	if err != nil {
		return nil, err
	}
	running, err := pg.Exists(ctx, db, "SELECT 1 FROM routine_run WHERE routine_id = $1 AND status = 'running'", r.ID)
	if err != nil {
		return nil, err
	}
	if running {
		return nil, apierr.New(409, "ROUTINE_RUNNING", "这个定时任务正在运行。")
	}
	if err := s.Schedules.Fire(ctx, r.ID); err != nil {
		return nil, scheduleUnavailable(ctx, err)
	}
	return public(ctx, db, r)
}

// RestoreBrief makes an old version the current one (as a new version).
func (s *Service) RestoreBrief(ctx context.Context, tx pgx.Tx, id string, version int) (*Routine, error) {
	r, err := get(ctx, tx, id, true)
	if err != nil {
		return nil, err
	}
	var text string
	err = tx.QueryRow(ctx, "SELECT text FROM routine_brief WHERE routine_id = $1 AND version = $2", r.ID, version).Scan(&text)
	if err == pgx.ErrNoRows {
		return nil, apierr.NotFound()
	}
	if err != nil {
		return nil, err
	}
	if err := addBrief(ctx, tx, r.ID, text, nil); err != nil {
		return nil, err
	}
	return public(ctx, tx, r)
}

// AddFeedback records the user's feedback on a run; once it is committed,
// Runner.Revise revises the brief from it.
func (s *Service) AddFeedback(ctx context.Context, tx pgx.Tx, routineID, runID, text string) (*Feedback, error) {
	routine, ok1 := pg.ParseID(routineID)
	run, ok2 := pg.ParseID(runID)
	if !ok1 || !ok2 {
		return nil, apierr.NotFound()
	}
	found, err := pg.Exists(ctx, tx, "SELECT 1 FROM routine_run WHERE id = $1 AND routine_id = $2", run, routine)
	if err != nil {
		return nil, err
	}
	if !found {
		return nil, apierr.NotFound()
	}
	f := &feedbackRow{ID: pg.NewID(), RunID: run, Text: text, CreatedAt: pg.Now()}
	if _, err := tx.Exec(ctx, `INSERT INTO routine_feedback (id, run_id, text, created_at)
		VALUES ($1, $2, $3, $4)`, f.ID, f.RunID, f.Text, f.CreatedAt); err != nil {
		return nil, err
	}
	p := f.public()
	return &p, nil
}
