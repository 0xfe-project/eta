package routines

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/akarachen/axp/apps/routine-service/internal/store"
	plugins "github.com/akarachen/axp/packages/plugins-go"
	pluginsadk "github.com/akarachen/axp/packages/plugins-go/adk"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"google.golang.org/adk/v2/agent"
	"google.golang.org/adk/v2/agent/llmagent"
	"google.golang.org/adk/v2/model"
	"google.golang.org/adk/v2/runner"
	"google.golang.org/adk/v2/tool"
	"google.golang.org/adk/v2/tool/functiontool"
	"google.golang.org/genai"
)

// RunLimit is how long a run may take.
const RunLimit = 15 * time.Minute

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

// Runner runs routines when their schedules fire, and revises briefs from
// feedback. Runs are ADK agents in this process: the routine's own tools,
// and the plugins of the routine target.
type Runner struct {
	DB *pgxpool.Pool
	// Model is the named model for the routine's agent.
	Model func(ctx context.Context, name, routineID string) (model.LLM, error)
	// Plugins every run gets, and how they reach AXP's services.
	Plugins []*plugins.Plugin
	Proxy   *KeyProxy
	// Where runs get their working directories.
	WorkDir string
	Limit   time.Duration
	// Go runs work in the background; tests run it at once.
	Go func(func())

	mu       sync.Mutex
	revising map[string]bool
}

func (r *Runner) background(f func()) {
	if r.Go != nil {
		r.Go(f)
		return
	}
	go f()
}

// Recover cleans up after the service stopped: runs it was running failed,
// and feedback it had not revised the brief from yet is.
func (r *Runner) Recover(ctx context.Context) error {
	if _, err := r.DB.Exec(ctx, `UPDATE routine_run SET status = 'failed', error = '运行被中断（服务重启）。',
		finished_at = $1 WHERE status = 'running'`, now()); err != nil {
		return err
	}
	rows, err := r.DB.Query(ctx, `SELECT f.id FROM routine_feedback f
		WHERE NOT f.revision_failed AND NOT EXISTS (SELECT 1 FROM routine_brief b WHERE b.feedback_id = f.id)
		ORDER BY f.created_at`)
	if err != nil {
		return err
	}
	pending, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		return err
	}
	for _, id := range pending {
		r.Revise(id)
	}
	return nil
}

// --- runs --------------------------------------------------------------------------

// Fire starts a run of the routine, unless it is paused (and was not asked
// to run now) or still running.
func (r *Runner) Fire(ctx context.Context, routineID string, asked bool) error {
	id, ok := parseID(routineID)
	if !ok {
		return nil
	}
	routine, err := store.One[routineRow](ctx, r.DB, "SELECT * FROM routine WHERE id = $1", id)
	if err != nil || routine == nil || !(routine.Enabled || asked) {
		return err
	}
	run := &runRow{ID: newID(), RoutineID: routine.ID, Status: RunRunning, StartedAt: now()}
	tag, err := r.DB.Exec(ctx, `INSERT INTO routine_run (id, routine_id, status, started_at)
		VALUES ($1, $2, 'running', $3) ON CONFLICT (routine_id) WHERE status = 'running' DO NOTHING`,
		run.ID, run.RoutineID, run.StartedAt)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		slog.InfoContext(ctx, "Routine is still running; skipping a run", "routine", routine.ID)
		return nil
	}
	r.background(func() { r.run(routine, run) })
	return nil
}

func (r *Runner) run(routine *routineRow, run *runRow) {
	limit := r.Limit
	if limit == 0 {
		limit = RunLimit
	}
	ctx, cancel := context.WithTimeout(context.Background(), limit)
	defer cancel()
	log := slog.With("routine", routine.ID, "run", run.ID)
	message, err := r.agent(ctx, routine, run)
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		err = fmt.Errorf("运行超过 %d 分钟，已停止。", int(limit.Minutes()))
	} else if err != nil {
		log.Error("Routine run failed", "error", err)
		err = fmt.Errorf("运行失败：%s", truncate(err.Error(), 400))
	}
	// A run that called finish has ended already; this changes nothing then.
	if err := complete(context.Background(), r.DB, run.ID, message, err); err != nil {
		log.Error("Recording how a run ended failed", "error", err)
	}
}

func truncate(s string, n int) string {
	if runes := []rune(s); len(runes) > n {
		return string(runes[:n]) + "…"
	}
	return s
}

// agent runs the routine's agent and returns its last message.
func (r *Runner) agent(ctx context.Context, routine *routineRow, run *runRow) (string, error) {
	text, err := r.instructions(ctx, routine, run)
	if err != nil {
		return "", err
	}
	llm, err := r.Model(ctx, routine.Model, routine.ID)
	if err != nil {
		return "", err
	}
	tools, err := r.tools(run)
	if err != nil {
		return "", err
	}
	config := llmagent.Config{
		Name:  "routine",
		Model: llm,
		// A provider, so that braces in the brief are not state placeholders.
		InstructionProvider: func(agent.ReadonlyContext) (string, error) { return text, nil },
		Tools:               tools,
	}
	if len(r.Plugins) > 0 {
		workspace, err := os.MkdirTemp(r.WorkDir, "run-")
		if err != nil {
			return "", err
		}
		defer os.RemoveAll(workspace)
		key, revoke := r.Proxy.Issue(routine.ID)
		defer revoke()
		loaded, err := pluginsadk.Load(ctx, r.Plugins, map[string]string{
			"AXP_GATEWAY_URL": r.Proxy.URL, "AXP_AGENT_KEY": key, "AXP_WORKSPACE_DIR": workspace,
		})
		if err != nil {
			return "", err
		}
		loaded.Install(&config)
	}
	a, err := llmagent.New(config)
	if err != nil {
		return "", err
	}
	runs, err := runner.NewInMemory("routines", a)
	if err != nil {
		return "", err
	}
	loc, _ := location(routine.Timezone)
	first := genai.NewContentFromText(fmt.Sprintf(prompt, run.StartedAt.In(loc).Format("2006-01-02 15:04 MST")), genai.RoleUser)
	var message string
	for event, err := range runs.Run(ctx, "routine", run.ID, first, agent.RunConfig{}) {
		if err != nil {
			return message, err
		}
		if event.Content == nil || event.Partial {
			continue
		}
		var parts []string
		for _, part := range event.Content.Parts {
			if part.Text != "" && !part.Thought {
				parts = append(parts, part.Text)
			}
		}
		if len(parts) > 0 {
			message = strings.Join(parts, "")
		}
	}
	return message, nil
}

func (r *Runner) instructions(ctx context.Context, routine *routineRow, run *runRow) (string, error) {
	var version int32
	var brief string
	if err := r.DB.QueryRow(ctx, `SELECT version, text FROM routine_brief WHERE routine_id = $1
		ORDER BY version DESC LIMIT 1`, routine.ID).Scan(&version, &brief); err != nil {
		return "", err
	}
	loc, err := location(routine.Timezone)
	if err != nil {
		return "", err
	}
	handoff := "这是第一次运行。"
	last, err := store.One[runRow](ctx, r.DB, `SELECT * FROM routine_run
		WHERE routine_id = $1 AND id <> $2 AND handoff IS NOT NULL ORDER BY started_at DESC LIMIT 1`, routine.ID, run.ID)
	if err != nil {
		return "", err
	}
	if last != nil {
		written := ""
		if last.FinishedAt != nil {
			written = last.FinishedAt.In(loc).Format("01-02 15:04")
		}
		handoff = "（" + written + "）" + *last.Handoff
	}
	return fmt.Sprintf(instructions, routine.Name, Describe(routine.Schedule), routine.Timezone, version, brief, handoff), nil
}

type listIn struct {
	Before string `json:"before,omitempty" jsonschema:"A run's started_at, to page back from it."`
	Limit  int    `json:"limit,omitempty" jsonschema:"How many runs (default 10, at most 50)."`
}

type searchIn struct {
	Query string `json:"query" jsonschema:"A word, name or URL."`
	Limit int    `json:"limit,omitempty" jsonschema:"How many runs (default 10, at most 50)."`
}

type getIn struct {
	RunID string `json:"run_id"`
}

type finishIn struct {
	Report  *string `json:"report" jsonschema:"The report for the user in Markdown, starting with a '# title' line; null when there is nothing new worth sending."`
	Handoff string  `json:"handoff" jsonschema:"A few sentences for the next run: what was sent, what you noticed, what to watch for next time."`
}

type runsOut struct {
	Runs []RunSummary `json:"runs"`
}

type finishOut struct {
	Result string `json:"result"`
}

// tools are the run's view of its routine: its earlier runs, and finish.
func (r *Runner) tools(run *runRow) ([]tool.Tool, error) {
	db := r.DB
	list, err1 := functiontool.New(functiontool.Config{Name: "list_runs",
		Description: "List this routine's earlier runs, newest first: when, the outcome, the report's title and the user's feedback."},
		func(ctx agent.Context, in listIn) (runsOut, error) {
			runs, err := listRuns(ctx, db, run, in.Before, "", in.Limit)
			return runsOut{runs}, err
		})
	search, err2 := functiontool.New(functiontool.Config{Name: "search_runs",
		Description: "Earlier runs whose report mentions the query, newest first. Use it to check whether something was already sent."},
		func(ctx agent.Context, in searchIn) (runsOut, error) {
			runs, err := listRuns(ctx, db, run, "", in.Query, in.Limit)
			return runsOut{runs}, err
		})
	get, err3 := functiontool.New(functiontool.Config{Name: "get_run",
		Description: "One earlier run in full: its report, handoff and the user's feedback."},
		func(ctx agent.Context, in getIn) (*RunSummary, error) {
			return getRun(ctx, db, run, in.RunID)
		})
	end, err4 := functiontool.New(functiontool.Config{Name: "finish",
		Description: "End this run, exactly once, with the report (or null) and a handoff for the next run."},
		func(ctx agent.Context, in finishIn) (finishOut, error) {
			if _, err := finish(ctx, db, run.ID, in.Report, in.Handoff); err != nil {
				return finishOut{}, err
			}
			return finishOut{"已结束本次运行。"}, nil
		})
	return []tool.Tool{list, search, get, end}, errors.Join(err1, err2, err3, err4)
}

// --- feedback ----------------------------------------------------------------------

// Revise revises the brief from the feedback in the background, once.
func (r *Runner) Revise(feedbackID string) {
	r.mu.Lock()
	if r.revising == nil {
		r.revising = map[string]bool{}
	}
	busy := r.revising[feedbackID]
	r.revising[feedbackID] = true
	r.mu.Unlock()
	if busy {
		return
	}
	r.background(func() {
		defer func() {
			r.mu.Lock()
			delete(r.revising, feedbackID)
			r.mu.Unlock()
		}()
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
		defer cancel()
		if err := r.revise(ctx, feedbackID); err != nil {
			slog.Error("Revising the brief from feedback failed", "feedback", feedbackID, "error", err)
			if _, err := r.DB.Exec(ctx, "UPDATE routine_feedback SET revision_failed = true WHERE id = $1", feedbackID); err != nil {
				slog.Error("Recording a failed revision failed", "feedback", feedbackID, "error", err)
			}
		}
	})
}

func (r *Runner) revise(ctx context.Context, feedbackID string) error {
	var text, routineID, modelName, brief string
	var report, runError *string
	if err := r.DB.QueryRow(ctx, `SELECT f.text, rt.id, rt.model, run.report, run.error,
		(SELECT b.text FROM routine_brief b WHERE b.routine_id = rt.id ORDER BY b.version DESC LIMIT 1)
		FROM routine_feedback f JOIN routine_run run ON run.id = f.run_id JOIN routine rt ON rt.id = run.routine_id
		WHERE f.id = $1`, feedbackID).Scan(&text, &routineID, &modelName, &report, &runError, &brief); err != nil {
		return err
	}
	shown := "（没有报告）"
	if report != nil && *report != "" {
		shown = *report
	} else if runError != nil && *runError != "" {
		shown = *runError
	}
	llm, err := r.Model(ctx, modelName, routineID)
	if err != nil {
		return err
	}
	request := &model.LLMRequest{Model: modelName, Contents: []*genai.Content{
		genai.NewContentFromText(fmt.Sprintf(revise, brief, shown, text), genai.RoleUser),
	}}
	var revised strings.Builder
	for response, err := range llm.GenerateContent(ctx, request, false) {
		if err != nil {
			return err
		}
		if response.Content != nil {
			for _, part := range response.Content.Parts {
				if !part.Thought {
					revised.WriteString(part.Text)
				}
			}
		}
	}
	if strings.TrimSpace(revised.String()) == "" {
		return errEmpty
	}
	return store.InTx(ctx, r.DB, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, "SELECT 1 FROM routine WHERE id = $1 FOR UPDATE", routineID); err != nil {
			return err
		}
		return addBrief(ctx, tx, routineID, strings.TrimSpace(revised.String()), &feedbackID)
	})
}
