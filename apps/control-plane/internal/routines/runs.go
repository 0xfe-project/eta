package routines

import (
	"context"
	"strconv"
	"strings"
	"time"

	"github.com/akarachen/axp/apps/control-plane/internal/apierr"
	"github.com/akarachen/axp/apps/control-plane/internal/auth"
	"github.com/akarachen/axp/apps/control-plane/internal/chat"
	"github.com/akarachen/axp/apps/control-plane/internal/store"
)

// What a run sees of its routine, through the internal API: its earlier
// runs, and how it ends. Nothing here lets it see another routine.

const maxRunPage = 50

// RunFor is the running run the token belongs to, or nil.
func RunFor(ctx context.Context, db store.DB, secret []byte, runID, token string) (*RunRecord, error) {
	id, ok := chat.ParseID(runID)
	if !ok || !auth.Matches(token, auth.RoutineToken(secret, id)) {
		return nil, nil
	}
	return chat.One[RunRecord](ctx, db, "SELECT * FROM routine_run WHERE id = $1 AND container_id IS NOT NULL", id)
}

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

func summaries(ctx context.Context, db store.DB, runs []*RunRecord) ([]RunSummary, error) {
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

// ListRuns is the routine's other finished runs, newest first.
func ListRuns(ctx context.Context, db store.DB, run *RunRecord, before *time.Time, q string, limit int) ([]RunSummary, error) {
	limit = max(1, min(limit, maxRunPage))
	sql := `SELECT * FROM routine_run WHERE routine_id = $1 AND id <> $2 AND status <> 'running'`
	args := []any{run.RoutineID, run.ID}
	if before != nil {
		args = append(args, *before)
		sql += " AND started_at < $3"
	}
	if q != "" {
		args = append(args, likePattern(q))
		n := len(args)
		sql += " AND (report ILIKE $" + strconv.Itoa(n) + " OR handoff ILIKE $" + strconv.Itoa(n) + ")"
	}
	args = append(args, limit)
	runs, err := chat.All[RunRecord](ctx, db, sql+" ORDER BY started_at DESC LIMIT $"+strconv.Itoa(len(args)), args...)
	if err != nil {
		return nil, err
	}
	return summaries(ctx, db, runs)
}

// GetRun is one of the routine's runs in full.
func GetRun(ctx context.Context, db store.DB, run *RunRecord, otherID string) (*RunSummary, error) {
	id, ok := chat.ParseID(otherID)
	var other *RunRecord
	var err error
	if ok {
		other, err = chat.One[RunRecord](ctx, db, "SELECT * FROM routine_run WHERE id = $1 AND routine_id = $2", id, run.RoutineID)
		if err != nil {
			return nil, err
		}
	}
	if other == nil {
		return nil, apierr.New(404, "NOT_FOUND", "没有这次运行。")
	}
	out, err := summaries(ctx, db, []*RunRecord{other})
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

// Finish ends the run with its report (nil: nothing new) and handoff.
func Finish(ctx context.Context, db store.DB, run *RunRecord, report *string, handoff string) (string, error) {
	if run.Status != RunRunning {
		return "", apierr.New(409, "RUN_FINISHED", "这次运行已经结束。")
	}
	report = trimmed(report)
	status := RunNothingNew
	if report != nil {
		status = RunSent
	}
	_, err := db.Exec(ctx, `UPDATE routine_run SET status = $2, report = $3, handoff = $4, finished_at = $5
		WHERE id = $1`, run.ID, status, report, trimmed(&handoff), chat.Now())
	return status, err
}

// Complete records that the runtime is done. Without a finish, its last
// message is the report, or the run failed.
func Complete(ctx context.Context, db store.DB, run *RunRecord, completed bool, message string, runError *string) (string, error) {
	if run.Status != RunRunning {
		return run.Status, nil
	}
	report, status := trimmed(&message), RunFailed
	var errorText *string
	if completed && report != nil {
		status = RunSent
	} else {
		report = nil
		text := "运行没有完成。"
		if runError != nil && *runError != "" {
			text = *runError
		}
		errorText = &text
	}
	_, err := db.Exec(ctx, `UPDATE routine_run SET status = $2, report = $3, error = $4, finished_at = $5
		WHERE id = $1`, run.ID, status, report, errorText, chat.Now())
	return status, err
}
