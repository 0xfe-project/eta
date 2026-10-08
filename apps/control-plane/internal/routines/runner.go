package routines

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/akarachen/axp/apps/control-plane/internal/auth"
	"github.com/akarachen/axp/apps/control-plane/internal/chat"
	"github.com/akarachen/axp/apps/control-plane/internal/container"
	"github.com/akarachen/axp/apps/control-plane/internal/llm"
	"github.com/akarachen/axp/apps/control-plane/internal/queue"
	"github.com/akarachen/axp/apps/control-plane/internal/store"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// The controller's routine steps: start runs when schedules fire, watch them,
// and revise briefs from feedback.
//
// A run is a fresh container from the agent runtime image running
// `python -m axp_runtime.routine`. It reads nothing from earlier runs except
// through its tools; what it needs to start is in its instructions.

const (
	RunLimit = 15 * time.Minute
	// A run whose container is gone gets this long to report how it ended.
	ExitGrace           = 30 * time.Second
	runtimeOTLPEndpoint = "http://otel-collector:4318"
)

const instructions = `你在执行定时任务「%s」。
它按计划自动运行（%s，时区 %s）。
每次运行都在一个全新的环境里，之前运行留下的文件都不在了。
没有用户在线，不要提问，自己做决定。

## 要求（v%d）

%s

## 上一次运行留下的交接说明

%s

## 怎么做

- 需要了解之前做过什么时，用 list_runs、get_run、search_runs 查看过往的报告
  和用户的反馈。
  发送之前确认内容没有和以前的报告重复；没有值得发送的新内容就不发。
- 最后调用一次 finish 结束运行：
  - report 是给用户的报告（Markdown，第一行是 # 标题），没有新内容时传 null；
  - handoff 写给下一次运行：发了什么、观察到什么、下次要注意什么，几句话即可。`

const prompt = "现在是 %s，执行这次运行。"

const revise = `你维护一个定时任务的要求。用户对某次运行的报告提了反馈。
把反馈吸收进要求，输出修订后的完整要求：保留原来的写法和语言，只改需要改的地方，不加解释。

## 当前要求

%s

## 那次运行的报告

%s

## 用户的反馈

%s`

// Completer is one chat completion through the LLM gateway.
type Completer interface {
	Complete(ctx context.Context, agent, model, prompt string) (string, error)
}

// Runner is the routine steps of the controller.
type Runner struct {
	DB        *pgxpool.Pool
	Queue     queue.Queue
	Driver    container.Driver
	Models    llm.Catalog
	Completer Completer
	Secret    []byte
	// Where runtimes reach the internal API and NATS.
	RuntimeGatewayURL string
	NATSURL           string
	CodexLaunch       string
	// Background runs revisions; in a goroutine unless tests replace it.
	Background func(func())

	mu       sync.Mutex
	revising map[string]bool
}

// SyncSchedules gives NATS every enabled routine's schedule (on controller
// start).
func (r *Runner) SyncSchedules(ctx context.Context) error {
	rows, err := chat.All[routineRow](ctx, r.DB, "SELECT * FROM routine WHERE enabled")
	if err != nil {
		return err
	}
	for _, routine := range rows {
		if err := r.Queue.ScheduleRoutine(ctx, routine.ID, routine.Schedule.Cron5(), routine.Timezone); err != nil {
			return err
		}
	}
	return nil
}

// --- runs ------------------------------------------------------------------------

func (r *Runner) StartFired(ctx context.Context) error {
	fires, err := r.Queue.TakeFires(ctx)
	if err != nil {
		return err
	}
	for _, fire := range fires {
		id, ok := chat.ParseID(fire.RoutineID)
		if !ok {
			continue
		}
		routine, err := chat.One[routineRow](ctx, r.DB, "SELECT * FROM routine WHERE id = $1", id)
		if err != nil {
			return err
		}
		if routine == nil || !(routine.Enabled || fire.Now) {
			continue
		}
		run := &RunRecord{ID: chat.NewID(), RoutineID: routine.ID, Status: RunRunning, StartedAt: chat.Now()}
		tag, err := r.DB.Exec(ctx, `INSERT INTO routine_run (id, routine_id, status, started_at)
			VALUES ($1, $2, 'running', $3) ON CONFLICT (routine_id) WHERE status = 'running' DO NOTHING`,
			run.ID, run.RoutineID, run.StartedAt)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			slog.InfoContext(ctx, "Routine is still running; skipping a run", "routine", routine.ID)
			continue
		}
		spec, err := r.spec(ctx, routine, run)
		if err == nil {
			var started container.Started
			if started, err = r.Driver.Start(ctx, spec); err == nil {
				_, err = r.DB.Exec(ctx, "UPDATE routine_run SET container_id = $2 WHERE id = $1", run.ID, started.ContainerID)
				if err != nil {
					return err
				}
				continue
			}
		}
		slog.ErrorContext(ctx, "Failed to start routine run", "run", run.ID, "error", err)
		if err := r.fail(ctx, run.ID, "运行环境无法启动。"); err != nil {
			return err
		}
	}
	return nil
}

func (r *Runner) spec(ctx context.Context, routine *routineRow, run *RunRecord) (container.Spec, error) {
	var version int32
	var brief string
	if err := r.DB.QueryRow(ctx, `SELECT version, text FROM routine_brief WHERE routine_id = $1
		ORDER BY version DESC LIMIT 1`, routine.ID).Scan(&version, &brief); err != nil {
		return container.Spec{}, err
	}
	loc, err := location(routine.Timezone)
	if err != nil {
		return container.Spec{}, err
	}
	handoff := "这是第一次运行。"
	last, err := chat.One[RunRecord](ctx, r.DB, `SELECT * FROM routine_run
		WHERE routine_id = $1 AND id <> $2 AND handoff IS NOT NULL ORDER BY started_at DESC LIMIT 1`, routine.ID, run.ID)
	if err != nil {
		return container.Spec{}, err
	}
	if last != nil {
		written := ""
		if last.FinishedAt != nil {
			written = last.FinishedAt.In(loc).Format("01-02 15:04")
		}
		handoff = "（" + written + "）" + *last.Handoff
	}
	model := routine.Model
	settings, err := json.Marshal(map[string]any{
		"model":                  routine.Model,
		"model_context_window":   llm.ContextWindow(ctx, r.Models, &model),
		"developer_instructions": fmt.Sprintf(instructions, routine.Name, Describe(routine.Schedule), routine.Timezone, version, brief, handoff),
	})
	if err != nil {
		return container.Spec{}, err
	}
	agent := "routine-" + routine.ID
	env := map[string]string{
		"AXP_AGENT_ID":                agent,
		"AXP_INSTANCE_ID":             run.ID,
		"AXP_GENERATION":              "0",
		"AXP_RUNTIME_TOKEN":           auth.RoutineToken(r.Secret, run.ID),
		"AXP_GATEWAY_URL":             r.RuntimeGatewayURL,
		"AXP_NATS_URL":                r.NATSURL,
		"AXP_CODEX_SETTINGS":          string(settings),
		"AXP_ROUTINE_PROMPT":          fmt.Sprintf(prompt, run.StartedAt.In(loc).Format("2006-01-02 15:04 MST")),
		"OTEL_EXPORTER_OTLP_ENDPOINT": runtimeOTLPEndpoint,
		"OTEL_SERVICE_NAME":           "routine-runtime",
		"OTEL_RESOURCE_ATTRIBUTES": ResourceAttributes(
			"axp.routine.id="+routine.ID,
			"axp.routine.run.id="+run.ID,
		),
	}
	if r.CodexLaunch != "" {
		env["AXP_CODEX_LAUNCH"] = r.CodexLaunch
	}
	return container.Spec{
		AgentID:    agent,
		InstanceID: run.ID,
		Generation: 0,
		Name:       r.Driver.Name("routine-" + run.ID),
		Env:        env,
		Command:    []string{"python", "-m", "axp_runtime.routine"},
	}, nil
}

// ResourceAttributes is OTEL_RESOURCE_ATTRIBUTES for a runtime: this
// process's, then attrs.
func ResourceAttributes(attrs ...string) string {
	if own := os.Getenv("OTEL_RESOURCE_ATTRIBUTES"); own != "" {
		attrs = append([]string{own}, attrs...)
	}
	return strings.Join(attrs, ",")
}

func (r *Runner) fail(ctx context.Context, runID, message string) error {
	_, err := r.DB.Exec(ctx, `UPDATE routine_run SET status = 'failed', error = $2, finished_at = $3
		WHERE id = $1 AND status = 'running'`, runID, message, chat.Now())
	return err
}

// WatchRuns stops runs over time, fails runs whose runtime died and removes
// finished runs' containers.
func (r *Runner) WatchRuns(ctx context.Context) error {
	runs, err := chat.All[RunRecord](ctx, r.DB, "SELECT * FROM routine_run WHERE container_id IS NOT NULL")
	if err != nil {
		return err
	}
	now := time.Now()
	for _, run := range runs {
		if run.Status == RunRunning {
			if run.StartedAt.Before(now.Add(-RunLimit)) {
				if err := r.fail(ctx, run.ID, "运行超过 15 分钟，已停止。"); err != nil {
					return err
				}
			} else {
				state, err := r.Driver.State(ctx, *run.ContainerID)
				if err != nil {
					return err
				}
				if state == container.Running || !run.StartedAt.Before(now.Add(-ExitGrace)) {
					continue
				}
				if err := r.fail(ctx, run.ID, "运行意外结束。"); err != nil {
					return err
				}
			}
		}
		if err := r.Driver.Stop(ctx, *run.ContainerID); err != nil {
			return err
		}
		if _, err := r.DB.Exec(ctx, "UPDATE routine_run SET container_id = NULL WHERE id = $1", run.ID); err != nil {
			return err
		}
	}
	return nil
}

// --- feedback ----------------------------------------------------------------------

// ReviseBriefs revises briefs from new feedback, each in the background.
func (r *Runner) ReviseBriefs(ctx context.Context) error {
	rows, err := r.DB.Query(ctx, `SELECT f.id FROM routine_feedback f
		WHERE NOT f.revision_failed AND NOT EXISTS (SELECT 1 FROM routine_brief b WHERE b.feedback_id = f.id)`)
	if err != nil {
		return err
	}
	pending, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		return err
	}
	for _, id := range pending {
		r.mu.Lock()
		if r.revising == nil {
			r.revising = map[string]bool{}
		}
		busy := r.revising[id]
		r.revising[id] = true
		r.mu.Unlock()
		if busy {
			continue
		}
		run := func() {
			defer func() {
				r.mu.Lock()
				delete(r.revising, id)
				r.mu.Unlock()
			}()
			if err := r.revise(context.WithoutCancel(ctx), id); err != nil {
				slog.Error("Revising the brief from feedback failed", "feedback", id, "error", err)
				if _, err := r.DB.Exec(context.WithoutCancel(ctx), "UPDATE routine_feedback SET revision_failed = true WHERE id = $1", id); err != nil {
					slog.Error("Recording a failed revision failed", "feedback", id, "error", err)
				}
			}
		}
		if r.Background != nil {
			r.Background(run)
		} else {
			go run()
		}
	}
	return nil
}

func (r *Runner) revise(ctx context.Context, feedbackID string) error {
	var text, routineID, model, brief string
	var report, runError *string
	if err := r.DB.QueryRow(ctx, `SELECT f.text, rt.id, rt.model, run.report, run.error,
		(SELECT b.text FROM routine_brief b WHERE b.routine_id = rt.id ORDER BY b.version DESC LIMIT 1)
		FROM routine_feedback f JOIN routine_run run ON run.id = f.run_id JOIN routine rt ON rt.id = run.routine_id
		WHERE f.id = $1`, feedbackID).Scan(&text, &routineID, &model, &report, &runError, &brief); err != nil {
		return err
	}
	shown := "（没有报告）"
	if report != nil && *report != "" {
		shown = *report
	} else if runError != nil && *runError != "" {
		shown = *runError
	}
	revised, err := r.Completer.Complete(ctx, "routine-"+routineID, model, fmt.Sprintf(revise, brief, shown, text))
	if err != nil {
		return err
	}
	return store.InTx(ctx, r.DB, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `SELECT 1 FROM routine_brief WHERE routine_id = $1
			ORDER BY version DESC LIMIT 1 FOR UPDATE`, routineID); err != nil {
			return err
		}
		return addBrief(ctx, tx, routineID, revised, &feedbackID)
	})
}
