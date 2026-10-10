package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"iter"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/akarachen/axp/apps/routine-service/internal/routines"
	"github.com/akarachen/axp/apps/routine-service/migrations"
	"github.com/akarachen/axp/packages/service-go/pg"
	"github.com/akarachen/axp/packages/service-go/pg/pgtest"
	"github.com/jackc/pgx/v5/pgxpool"
	"google.golang.org/adk/v2/model"
	"google.golang.org/genai"
)

// The tests run against development's PostgreSQL, in a database of their
// own, emptied before every test.
func TestMain(m *testing.M) { pgtest.Main(m, migrations.All) }

// --- fakes -------------------------------------------------------------------------

const testModel = "test-model"

type catalog struct{ down bool }

func (c *catalog) Has(_ context.Context, id string) (bool, error) {
	if c.down {
		return false, errors.New("down")
	}
	return id == testModel, nil
}

// schedules is NATS: schedules by routine, and fires waiting to be taken.
type schedules struct {
	schedules map[string][2]string
	fires     []string
	down      bool
}

func (s *schedules) Schedule(_ context.Context, id, cron, timezone string) error {
	if s.down {
		return errors.New("down")
	}
	s.schedules[id] = [2]string{cron, timezone}
	return nil
}

func (s *schedules) Unschedule(_ context.Context, id string) error {
	if s.down {
		return errors.New("down")
	}
	delete(s.schedules, id)
	return nil
}

func (s *schedules) Fire(_ context.Context, id string) error {
	s.fires = append(s.fires, id)
	return nil
}

// llm is the model: each request is answered by the script.
type llm struct {
	mu       sync.Mutex
	requests []*model.LLMRequest
	script   func(req *model.LLMRequest, n int) (*genai.Content, error)
}

func (l *llm) Name() string { return testModel }

func (l *llm) GenerateContent(ctx context.Context, req *model.LLMRequest, _ bool) iter.Seq2[*model.LLMResponse, error] {
	return func(yield func(*model.LLMResponse, error) bool) {
		l.mu.Lock()
		l.requests = append(l.requests, req)
		n := len(l.requests)
		l.mu.Unlock()
		content, err := l.script(req, n)
		if err != nil {
			yield(nil, err)
			return
		}
		yield(&model.LLMResponse{Content: content, TurnComplete: true}, nil)
	}
}

func call(name string, args map[string]any) *genai.Content {
	return genai.NewContentFromFunctionCall(name, args, genai.RoleModel)
}

func text(s string) *genai.Content { return genai.NewContentFromText(s, genai.RoleModel) }

// result is the last tool result the request carries.
func result(req *model.LLMRequest) map[string]any {
	for i := len(req.Contents) - 1; i >= 0; i-- {
		for _, part := range req.Contents[i].Parts {
			if part.FunctionResponse != nil {
				return part.FunctionResponse.Response
			}
		}
	}
	return nil
}

// steps answers the requests in turn: tool calls, then text.
func steps(contents ...*genai.Content) func(*model.LLMRequest, int) (*genai.Content, error) {
	return func(_ *model.LLMRequest, n int) (*genai.Content, error) {
		if n > len(contents) {
			return text("完成。"), nil
		}
		return contents[n-1], nil
	}
}

// --- the environment ------------------------------------------------------------

type env struct {
	t         *testing.T
	server    *httptest.Server
	schedules *schedules
	catalog   *catalog
	llm       *llm
	runner    *routines.Runner
}

var pool *pgxpool.Pool

func newEnv(t *testing.T) *env {
	t.Helper()
	pool = pgtest.DB(t)
	e := &env{t: t, schedules: &schedules{schedules: map[string][2]string{}}, catalog: &catalog{}, llm: &llm{script: steps()}}
	e.runner = &routines.Runner{
		DB:    pool,
		Model: func(context.Context, string, string) (model.LLM, error) { return e.llm, nil },
		Go:    func(f func()) { f() },
	}
	service := &routines.Service{Schedules: e.schedules, Models: e.catalog}
	e.server = httptest.NewServer(New(&Deps{DB: pool, Routines: service, Revise: e.runner.Revise}).Router)
	t.Cleanup(e.server.Close)
	return e
}

type response struct {
	status int
	body   []byte
}

func (r response) json(t *testing.T, into any) {
	t.Helper()
	if err := json.Unmarshal(r.body, into); err != nil {
		t.Fatalf("%d %s: %v", r.status, r.body, err)
	}
}

func (e *env) do(method, path string, body any) response {
	e.t.Helper()
	var reader io.Reader
	if body != nil {
		data, _ := json.Marshal(body)
		reader = bytes.NewReader(data)
	}
	req, _ := http.NewRequest(method, e.server.URL+"/api/routines/v1"+path, reader)
	req.Header.Set("Content-Type", "application/json")
	if method == http.MethodPost {
		req.Header.Set("Idempotency-Key", pg.NewID())
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		e.t.Fatal(err)
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	return response{resp.StatusCode, data}
}

func (e *env) post(path string, body any) response  { return e.do(http.MethodPost, path, body) }
func (e *env) patch(path string, body any) response { return e.do(http.MethodPatch, path, body) }

// tick takes the fires waiting in NATS, running each at once.
func (e *env) tick() {
	e.t.Helper()
	fires := e.schedules.fires
	e.schedules.fires = nil
	for _, id := range fires {
		if err := e.runner.Fire(context.Background(), id, true); err != nil {
			e.t.Fatal(err)
		}
	}
}

func scalar[T any](e *env, sql string, args ...any) T {
	e.t.Helper()
	var v T
	if err := pool.QueryRow(context.Background(), sql, args...).Scan(&v); err != nil {
		e.t.Fatalf("%s: %v", sql, err)
	}
	return v
}

func expect[T comparable](t *testing.T, got, want T) {
	t.Helper()
	if got != want {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func expectError(t *testing.T, r response, status int, code string) {
	t.Helper()
	var body struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	r.json(t, &body)
	if r.status != status || body.Error.Code != code {
		t.Fatalf("got %d %s, want %d %s", r.status, r.body, status, code)
	}
}

func news() map[string]any {
	return map[string]any{
		"name":     "科技日报",
		"brief":    "每天整理科技新闻。",
		"model":    testModel,
		"schedule": map[string]any{"kind": "daily", "time": "08:00"},
		"timezone": "Asia/Shanghai",
	}
}

func with(base map[string]any, kv ...any) map[string]any {
	out := map[string]any{}
	for k, v := range base {
		out[k] = v
	}
	for i := 0; i+1 < len(kv); i += 2 {
		out[kv[i].(string)] = kv[i+1]
	}
	return out
}

func (e *env) create(body map[string]any) routines.Routine {
	e.t.Helper()
	r := e.post("/routines", body)
	if r.status != 201 {
		e.t.Fatalf("create: %d %s", r.status, r.body)
	}
	var routine routines.Routine
	r.json(e.t, &routine)
	return routine
}

// runNow runs the routine with the script and returns its run's id.
func (e *env) runNow(routine routines.Routine, script ...*genai.Content) string {
	e.t.Helper()
	e.llm.script = steps(script...)
	if r := e.post("/routines/"+routine.ID+"/run", nil); r.status != 202 {
		e.t.Fatalf("run: %d %s", r.status, r.body)
	}
	e.tick()
	return scalar[string](e, "SELECT id::text FROM routine_run WHERE routine_id = $1 ORDER BY started_at DESC LIMIT 1", routine.ID)
}

func (e *env) shown() routines.Routine {
	var list RoutineList
	e.do(http.MethodGet, "/routines", nil).json(e.t, &list)
	return list.Routines[0]
}

func finishCall(report any, handoff string) *genai.Content {
	return call("finish", map[string]any{"report": report, "handoff": handoff})
}

// --- the API -----------------------------------------------------------------------

func TestCreateSchedulesIt(t *testing.T) {
	e := newEnv(t)
	routine := e.create(news())
	expect(t, e.schedules.schedules[routine.ID], [2]string{"0 8 * * *", "Asia/Shanghai"})
	expect(t, routine.Enabled, true)
	if routine.NextRunAt == nil || routine.Handoff != nil {
		t.Fatalf("routine %+v", routine)
	}
	expect(t, len(routine.Briefs), 1)
	expect(t, routine.Briefs[0].Version, int32(1))
}

func TestRejectsBadInput(t *testing.T) {
	e := newEnv(t)
	expectError(t, e.post("/routines", with(news(), "timezone", "Mars/Base")), 422, "INVALID_TIMEZONE")
	expectError(t, e.post("/routines", with(news(), "schedule", map[string]any{"kind": "cron", "cron": "nope"})), 422, "INVALID_SCHEDULE")
	expectError(t, e.post("/routines", with(news(), "schedule", map[string]any{"kind": "daily", "time": "25:00"})), 422, "VALIDATION_ERROR")
	expectError(t, e.post("/routines", with(news(), "schedule", map[string]any{"kind": "hourly", "every": 5})), 422, "VALIDATION_ERROR")
	expectError(t, e.post("/routines", with(news(), "schedule", map[string]any{"kind": "weekly", "days": []int{7}, "time": "08:00"})), 422, "VALIDATION_ERROR")
	expectError(t, e.post("/routines", with(news(), "model", "gone")), 422, "MODEL_NOT_FOUND")
	e.catalog.down = true
	expectError(t, e.post("/routines", news()), 503, "MODEL_SERVICE_UNAVAILABLE")
}

func TestScheduleKindsBecomeCron(t *testing.T) {
	e := newEnv(t)
	weekly := e.create(with(news(), "schedule", map[string]any{"kind": "weekly", "days": []int{3, 1}, "time": "09:30"}))
	expect(t, e.schedules.schedules[weekly.ID][0], "30 9 * * 1,3")
	expect(t, fmt.Sprint(weekly.Schedule.Days), "[3 1]")
	hourly := e.create(with(news(), "schedule", map[string]any{"kind": "hourly", "every": 6}))
	expect(t, e.schedules.schedules[hourly.ID][0], "0 */6 * * *")
}

func TestEditDisableAndDelete(t *testing.T) {
	e := newEnv(t)
	routine := e.create(news())
	path := "/routines/" + routine.ID
	var edited routines.Routine
	e.patch(path, map[string]any{"brief": "改过的要求。"}).json(t, &edited)
	expect(t, fmt.Sprint(edited.Briefs[0].Version, edited.Briefs[1].Version), "2 1")
	var disabled routines.Routine
	e.patch(path, map[string]any{"enabled": false}).json(t, &disabled)
	if disabled.NextRunAt != nil {
		t.Fatal("a disabled routine runs next")
	}
	if _, ok := e.schedules.schedules[routine.ID]; ok {
		t.Fatal("still scheduled")
	}
	e.patch(path, map[string]any{"enabled": true})
	if _, ok := e.schedules.schedules[routine.ID]; !ok {
		t.Fatal("not scheduled")
	}
	expect(t, e.do(http.MethodDelete, path, nil).status, 204)
	if _, ok := e.schedules.schedules[routine.ID]; ok {
		t.Fatal("still scheduled")
	}
	expect(t, scalar[int](e, "SELECT count(*) FROM routine"), 0)
	expectError(t, e.do(http.MethodDelete, path, nil), 404, "NOT_FOUND")
}

func TestRestoreBrief(t *testing.T) {
	e := newEnv(t)
	routine := e.create(news())
	path := "/routines/" + routine.ID
	e.patch(path, map[string]any{"brief": "第二版"})
	var restored routines.Routine
	e.post(path+"/briefs/1/restore", nil).json(t, &restored)
	var got []string
	for _, b := range restored.Briefs {
		got = append(got, fmt.Sprintf("%d:%s", b.Version, b.Text))
	}
	expect(t, strings.Join(got, ","), "3:每天整理科技新闻。,2:第二版,1:每天整理科技新闻。")
}

func TestScheduleDownKeepsNothing(t *testing.T) {
	e := newEnv(t)
	e.schedules.down = true
	expectError(t, e.post("/routines", news()), 503, "QUEUE_UNAVAILABLE")
	expect(t, scalar[int](e, "SELECT count(*) FROM routine"), 0)
}

// --- runs ------------------------------------------------------------------------

func TestRunFinishesWithAReport(t *testing.T) {
	e := newEnv(t)
	routine := e.create(news())
	e.runNow(routine, finishCall("# 今日要闻\n\n内容", "已发送今日要闻"), text("最后一句"))
	shown := e.shown()
	expect(t, shown.Runs[0].Status, "sent")
	expect(t, *shown.Runs[0].Title, "今日要闻")
	expect(t, *shown.Runs[0].Report, "# 今日要闻\n\n内容")
	expect(t, shown.Handoff.Text, "已发送今日要闻")
	// The run saw its brief, a first run's handoff and the time.
	first := e.llm.requests[0]
	instructions := first.Config.SystemInstruction.Parts[0].Text
	if !strings.Contains(instructions, "每天整理科技新闻。") || !strings.Contains(instructions, "这是第一次运行") {
		t.Fatalf("instructions %q", instructions)
	}
	if !strings.HasPrefix(first.Contents[0].Parts[0].Text, "现在是") {
		t.Fatalf("prompt %q", first.Contents[0].Parts[0].Text)
	}
}

func TestNothingNew(t *testing.T) {
	e := newEnv(t)
	e.runNow(e.create(news()), finishCall(nil, "源没有更新"))
	expect(t, scalar[string](e, "SELECT status FROM routine_run"), "nothing_new")
}

func TestFinishingTwiceIsRefused(t *testing.T) {
	e := newEnv(t)
	e.runNow(e.create(news()), finishCall("# 一", ""), finishCall("# 二", ""))
	expect(t, scalar[string](e, "SELECT report FROM routine_run"), "# 一")
	if !strings.Contains(fmt.Sprint(result(e.llm.requests[2])), "已经结束") {
		t.Fatalf("result %v", result(e.llm.requests[2]))
	}
}

func TestWithoutFinishTheLastMessageIsTheReport(t *testing.T) {
	e := newEnv(t)
	routine := e.create(news())
	id := e.runNow(routine, text("# 报告\n正文"))
	expect(t, scalar[string](e, "SELECT report FROM routine_run WHERE id = $1", id), "# 报告\n正文")
	expect(t, scalar[string](e, "SELECT status FROM routine_run WHERE id = $1", id), "sent")
	e.llm.script = func(*model.LLMRequest, int) (*genai.Content, error) { return nil, errors.New("gateway down") }
	e.post("/routines/"+routine.ID+"/run", nil)
	e.tick()
	failed := scalar[string](e, "SELECT error FROM routine_run WHERE status = 'failed'")
	if !strings.Contains(failed, "gateway down") {
		t.Fatalf("error %q", failed)
	}
}

func TestNextRunGetsTheHandoff(t *testing.T) {
	e := newEnv(t)
	routine := e.create(news())
	e.runNow(routine, finishCall("# 一", "下次看看 RFC 结果"))
	e.llm.requests = nil
	e.runNow(routine)
	if !strings.Contains(e.llm.requests[0].Config.SystemInstruction.Parts[0].Text, "下次看看 RFC 结果") {
		t.Fatal("no handoff")
	}
}

func TestHistoryIsTheRoutinesOwn(t *testing.T) {
	e := newEnv(t)
	routine := e.create(news())
	first := e.runNow(routine, finishCall("# 第一份\n提到了 Rust 2027", "交接一"))
	other := e.create(with(news(), "name", "别的"))
	foreign := e.runNow(other, finishCall("# 别的报告", ""))
	e.llm.requests = nil
	e.runNow(routine,
		call("list_runs", map[string]any{}),
		call("search_runs", map[string]any{"query": "Rust"}),
		call("search_runs", map[string]any{"query": "别的"}),
		call("get_run", map[string]any{"run_id": first}),
		call("get_run", map[string]any{"run_id": foreign}),
	)
	listed := fmt.Sprint(result(e.llm.requests[1]))
	if !strings.Contains(listed, "第一份") || strings.Contains(listed, "别的报告") {
		t.Fatalf("list_runs %s", listed)
	}
	if !strings.Contains(fmt.Sprint(result(e.llm.requests[2])), first) {
		t.Fatalf("search %v", result(e.llm.requests[2]))
	}
	if strings.Contains(fmt.Sprint(result(e.llm.requests[3])), foreign) {
		t.Fatal("found another routine's run")
	}
	if !strings.Contains(fmt.Sprint(result(e.llm.requests[4])), "Rust 2027") {
		t.Fatalf("get_run %v", result(e.llm.requests[4]))
	}
	if !strings.Contains(fmt.Sprint(result(e.llm.requests[5])), "没有这次运行") {
		t.Fatalf("got another routine's run: %v", result(e.llm.requests[5]))
	}
}

func TestPausedRoutineSkipsItsSchedule(t *testing.T) {
	e := newEnv(t)
	routine := e.create(news())
	e.patch("/routines/"+routine.ID, map[string]any{"enabled": false})
	if err := e.runner.Fire(context.Background(), routine.ID, false); err != nil {
		t.Fatal(err)
	}
	expect(t, scalar[int](e, "SELECT count(*) FROM routine_run"), 0)
	// Asked to run now, it runs.
	e.runNow(routine, finishCall(nil, ""))
	expect(t, scalar[int](e, "SELECT count(*) FROM routine_run"), 1)
}

func TestARoutineRunsOnceAtATime(t *testing.T) {
	e := newEnv(t)
	routine := e.create(news())
	ctx := context.Background()
	if _, err := pool.Exec(ctx, `INSERT INTO routine_run (id, routine_id, status, started_at)
		VALUES (gen_random_uuid(), $1, 'running', now())`, routine.ID); err != nil {
		t.Fatal(err)
	}
	expectError(t, e.post("/routines/"+routine.ID+"/run", nil), 409, "ROUTINE_RUNNING")
	expectError(t, e.do(http.MethodDelete, "/routines/"+routine.ID, nil), 409, "ROUTINE_RUNNING")
	if err := e.runner.Fire(ctx, routine.ID, true); err != nil {
		t.Fatal(err)
	}
	expect(t, scalar[int](e, "SELECT count(*) FROM routine_run"), 1)
	// The service stopped while it ran.
	if err := e.runner.Recover(ctx); err != nil {
		t.Fatal(err)
	}
	expect(t, scalar[string](e, "SELECT status FROM routine_run"), "failed")
}

func TestTimeLimit(t *testing.T) {
	e := newEnv(t)
	e.runner.Limit = 50 * time.Millisecond
	routine := e.create(news())
	e.llm.script = func(req *model.LLMRequest, _ int) (*genai.Content, error) {
		time.Sleep(200 * time.Millisecond)
		return nil, context.DeadlineExceeded
	}
	e.post("/routines/"+routine.ID+"/run", nil)
	e.tick()
	expect(t, scalar[string](e, "SELECT error FROM routine_run"), "运行超过 0 分钟，已停止。")
}

// --- feedback --------------------------------------------------------------------

func reported(t *testing.T) (*env, routines.Routine, string) {
	e := newEnv(t)
	routine := e.create(news())
	return e, routine, e.runNow(routine, finishCall("# 日报\n体育新闻……", "交接"))
}

func TestFeedbackRevisesTheBrief(t *testing.T) {
	e, routine, run := reported(t)
	e.llm.requests, e.llm.script = nil, steps(text("新要求"))
	sent := e.post("/routines/"+routine.ID+"/runs/"+run+"/feedback", map[string]any{"text": "别放体育新闻"})
	expect(t, sent.status, 201)
	prompt := e.llm.requests[0].Contents[0].Parts[0].Text
	if !strings.Contains(prompt, "别放体育新闻") || !strings.Contains(prompt, "体育新闻……") {
		t.Fatalf("prompt %q", prompt)
	}
	expect(t, scalar[string](e, "SELECT text FROM routine_brief WHERE version = 2"), "新要求")
	shown := e.shown()
	expect(t, *shown.Briefs[0].Feedback, "别放体育新闻")
	expect(t, *shown.Runs[0].Feedback[0].BriefVersion, int32(2))
}

func TestFailedRevisionIsMarked(t *testing.T) {
	e, routine, run := reported(t)
	e.llm.script = func(*model.LLMRequest, int) (*genai.Content, error) { return nil, errors.New("down") }
	e.post("/routines/"+routine.ID+"/runs/"+run+"/feedback", map[string]any{"text": "短一点"})
	expect(t, scalar[bool](e, "SELECT revision_failed FROM routine_feedback"), true)
	expect(t, scalar[int](e, "SELECT count(*) FROM routine_brief"), 1)
}

// The brief is edited while a revision waits for the model: the revision is
// redone from the edited brief instead of replacing it.
func TestARevisionDoesNotOverwriteANewerBrief(t *testing.T) {
	e, routine, run := reported(t)
	e.llm.requests = nil
	e.llm.script = func(_ *model.LLMRequest, n int) (*genai.Content, error) {
		if n == 1 {
			expect(t, e.patch("/routines/"+routine.ID, map[string]any{"brief": "手动改过的要求"}).status, 200)
			return text("基于旧要求的修订"), nil
		}
		return text("基于新要求的修订"), nil
	}
	expect(t, e.post("/routines/"+routine.ID+"/runs/"+run+"/feedback", map[string]any{"text": "别放体育新闻"}).status, 201)
	expect(t, len(e.llm.requests), 2)
	if prompt := e.llm.requests[1].Contents[0].Parts[0].Text; !strings.Contains(prompt, "手动改过的要求") {
		t.Fatalf("redone from %q", prompt)
	}
	expect(t, scalar[string](e, "SELECT text FROM routine_brief ORDER BY version DESC LIMIT 1"), "基于新要求的修订")
	expect(t, scalar[int](e, "SELECT max(version) FROM routine_brief"), 3)
	expect(t, scalar[bool](e, "SELECT revision_failed FROM routine_feedback"), false)
}

func TestARevisionThatRunsOutOfTimeIsMarkedFailed(t *testing.T) {
	e, routine, run := reported(t)
	e.runner.ReviseLimit = 50 * time.Millisecond
	e.llm.script = func(*model.LLMRequest, int) (*genai.Content, error) {
		time.Sleep(100 * time.Millisecond)
		return nil, context.DeadlineExceeded
	}
	e.post("/routines/"+routine.ID+"/runs/"+run+"/feedback", map[string]any{"text": "短一点"})
	expect(t, scalar[bool](e, "SELECT revision_failed FROM routine_feedback"), true)
}

func TestRecoverRevisesPendingFeedback(t *testing.T) {
	e, _, run := reported(t)
	if _, err := pool.Exec(context.Background(), `INSERT INTO routine_feedback (id, run_id, text, created_at)
		VALUES (gen_random_uuid(), $1, '加上来源', now())`, run); err != nil {
		t.Fatal(err)
	}
	e.llm.requests, e.llm.script = nil, steps(text("带来源的要求"))
	if err := e.runner.Recover(context.Background()); err != nil {
		t.Fatal(err)
	}
	expect(t, scalar[string](e, "SELECT text FROM routine_brief WHERE version = 2"), "带来源的要求")
}
