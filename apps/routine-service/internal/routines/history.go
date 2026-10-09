package routines

import (
	"context"
	"strconv"
	"strings"
	"time"

	"github.com/akarachen/axp/packages/service-go/apierr"
	"github.com/akarachen/axp/packages/service-go/pg"
)

// What a run sees of its routine through its tools: its earlier runs, and
// how it ends. Nothing here lets it see another routine.

const maxRunPage = 50

// RunSummary is an earlier run as the run's tools show it.
type RunSummary struct {
	ID        string   `json:"id"`
	StartedAt string   `json:"started_at"`
	Status    string   `json:"status"`
	Title     *string  `json:"title"`
	Feedback  []string `json:"feedback"`
	// In full only.
	Report  *string `json:"report,omitempty"`
	Handoff *string `json:"handoff,omitempty"`
	Error   *string `json:"error,omitempty"`
}

func summaries(ctx context.Context, db pg.DB, runs []*runRow) ([]RunSummary, error) {
	ids := make([]string, len(runs))
	for i, run := range runs {
		ids[i] = run.ID
	}
	feedback, err := feedbackFor(ctx, db, ids)
	if err != nil {
		return nil, err
	}
	out := []RunSummary{}
	for _, run := range runs {
		texts := []string{}
		for _, f := range feedback[run.ID] {
			texts = append(texts, f.Text)
		}
		out = append(out, RunSummary{
			ID: run.ID, StartedAt: run.StartedAt.Format(time.RFC3339Nano), Status: run.Status,
			Title: run.title(), Feedback: texts,
		})
	}
	return out, nil
}

// likePattern matches s anywhere, literally.
func likePattern(s string) string {
	return "%" + strings.NewReplacer(`\`, `\\`, "%", `\%`, "_", `\_`).Replace(s) + "%"
}

// listRuns is the routine's other finished runs, newest first: before a
// run's started_at, and mentioning q, when given.
func listRuns(ctx context.Context, db pg.DB, run *runRow, before, q string, limit int) ([]RunSummary, error) {
	if limit == 0 {
		limit = 10
	}
	limit = max(1, min(limit, maxRunPage))
	sql := `SELECT * FROM routine_run WHERE routine_id = $1 AND id <> $2 AND status <> 'running'`
	args := []any{run.RoutineID, run.ID}
	if before != "" {
		t, err := time.Parse(time.RFC3339Nano, before)
		if err != nil {
			return nil, apierr.New(422, "VALIDATION_ERROR", "before 应是某次运行的 started_at。")
		}
		args = append(args, t)
		sql += " AND started_at < $" + strconv.Itoa(len(args))
	}
	if q != "" {
		args = append(args, likePattern(q))
		n := strconv.Itoa(len(args))
		sql += " AND (report ILIKE $" + n + " OR handoff ILIKE $" + n + ")"
	}
	args = append(args, limit)
	runs, err := pg.All[runRow](ctx, db, sql+" ORDER BY started_at DESC LIMIT $"+strconv.Itoa(len(args)), args...)
	if err != nil {
		return nil, err
	}
	return summaries(ctx, db, runs)
}

// getRun is one of the routine's runs in full.
func getRun(ctx context.Context, db pg.DB, run *runRow, otherID string) (*RunSummary, error) {
	var other *runRow
	if id, ok := pg.ParseID(otherID); ok {
		var err error
		if other, err = pg.One[runRow](ctx, db, "SELECT * FROM routine_run WHERE id = $1 AND routine_id = $2", id, run.RoutineID); err != nil {
			return nil, err
		}
	}
	if other == nil {
		return nil, apierr.New(404, "NOT_FOUND", "没有这次运行。")
	}
	out, err := summaries(ctx, db, []*runRow{other})
	if err != nil {
		return nil, err
	}
	full := out[0]
	full.Report, full.Handoff, full.Error = other.Report, other.Handoff, other.Error
	return &full, nil
}

func trimmed(s *string) *string {
	if s == nil {
		return nil
	}
	t := strings.TrimSpace(*s)
	if t == "" {
		return nil
	}
	return &t
}

// finish ends the run with its report (nil: nothing new) and handoff.
func finish(ctx context.Context, db pg.DB, runID string, report *string, handoff string) (string, error) {
	report = trimmed(report)
	status := RunNothingNew
	if report != nil {
		status = RunSent
	}
	tag, err := db.Exec(ctx, `UPDATE routine_run SET status = $2, report = $3, handoff = $4, finished_at = $5
		WHERE id = $1 AND status = 'running'`, runID, status, report, trimmed(&handoff), pg.Now())
	if err != nil {
		return "", err
	}
	if tag.RowsAffected() == 0 {
		return "", apierr.New(409, "RUN_FINISHED", "这次运行已经结束。")
	}
	return status, nil
}

// complete records how a run that never called finish ended: its last
// message is the report, or it failed.
func complete(ctx context.Context, db pg.DB, runID, message string, runError error) error {
	report, status := trimmed(&message), RunSent
	var errorText *string
	if runError != nil || report == nil {
		report, status = nil, RunFailed
		text := "运行没有完成。"
		if runError != nil {
			text = runError.Error()
		}
		errorText = &text
	}
	_, err := db.Exec(ctx, `UPDATE routine_run SET status = $2, report = $3, error = $4, finished_at = $5
		WHERE id = $1 AND status = 'running'`, runID, status, report, errorText, pg.Now())
	return err
}
