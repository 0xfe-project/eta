package api

import (
	"errors"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/akarachen/axp/apps/control-plane/internal/auth"
	"github.com/akarachen/axp/apps/control-plane/internal/queue"
	"github.com/akarachen/axp/apps/control-plane/internal/routines"
)

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

func (e *env) createRoutine(body map[string]any) routines.Routine {
	e.t.Helper()
	r := e.post("/routines", body)
	if r.status != 201 {
		e.t.Fatalf("create routine: %d %s", r.status, r.body)
	}
	var routine routines.Routine
	r.json(e.t, &routine)
	return routine
}

// run talks to the internal API the way a routine run does.
type run struct {
	e     *env
	id    string
	token string
}

func (r *run) call(method, path string, body any, token ...string) response {
	tok := r.token
	if len(token) > 0 {
		tok = token[0]
	}
	return do(r.e.t, r.e.internal, method, "/internal/v1/routine-runs/"+r.id+"/"+path, body,
		map[string]string{"Authorization": "Bearer " + tok})
}

func (r *run) finish(report any, handoff string) response {
	return r.call(http.MethodPost, "finish", map[string]any{"report": report, "handoff": handoff})
}

func (r *run) complete(completed bool, message string, runError any) response {
	return r.call(http.MethodPost, "complete", map[string]any{"completed": completed, "message": message, "error": runError})
}

func (e *env) startRun(routine routines.Routine) *run {
	e.t.Helper()
	if s := e.post("/routines/"+routine.ID+"/run", nil).status; s != 202 {
		e.t.Fatalf("run: %d", s)
	}
	e.tick()
	id := scalar[string](e, "SELECT id FROM routine_run WHERE routine_id = $1 AND status = 'running'", routine.ID)
	return &run{e: e, id: id, token: auth.RoutineToken(e.secret, id)}
}

func TestCreateSchedulesIt(t *testing.T) {
	e := newEnv(t)
	routine := e.createRoutine(news())
	expect(t, e.nats.Schedules[routine.ID], [2]string{"0 8 * * *", "Asia/Shanghai"})
	expect(t, routine.Enabled, true)
	if routine.NextRunAt == nil {
		t.Fatal("no next run")
	}
	expect(t, len(routine.Briefs), 1)
	expect(t, routine.Briefs[0].Version, int32(1))
	expect(t, len(routine.Runs), 0)
	if routine.Handoff != nil {
		t.Fatal("a handoff")
	}
}

func TestRejectsBadSchedules(t *testing.T) {
	e := newEnv(t)
	expectError(t, e.post("/routines", with(news(), "timezone", "Mars/Base")), 422, "INVALID_TIMEZONE")
	expectError(t, e.post("/routines", with(news(), "schedule", map[string]any{"kind": "cron", "cron": "nope"})), 422, "INVALID_SCHEDULE")
	expectError(t, e.post("/routines", with(news(), "schedule", map[string]any{"kind": "daily", "time": "25:00"})), 422, "VALIDATION_ERROR")
	expectError(t, e.post("/routines", with(news(), "schedule", map[string]any{"kind": "hourly", "every": 5})), 422, "VALIDATION_ERROR")
	expectError(t, e.post("/routines", with(news(), "schedule", map[string]any{"kind": "weekly", "days": []int{7}, "time": "08:00"})), 422, "VALIDATION_ERROR")
}

func TestScheduleKindsBecomeCron(t *testing.T) {
	e := newEnv(t)
	weekly := e.createRoutine(with(news(), "schedule", map[string]any{"kind": "weekly", "days": []int{3, 1}, "time": "09:30"}))
	expect(t, e.nats.Schedules[weekly.ID][0], "30 9 * * 1,3")
	expect(t, fmt.Sprint(weekly.Schedule.Days), "[3 1]")
	hourly := e.createRoutine(with(news(), "schedule", map[string]any{"kind": "hourly", "every": 6}))
	expect(t, e.nats.Schedules[hourly.ID][0], "0 */6 * * *")
}

func TestEditDisableAndDelete(t *testing.T) {
	e := newEnv(t)
	routine := e.createRoutine(news())
	path := "/routines/" + routine.ID
	var edited routines.Routine
	e.patch(path, map[string]any{"brief": "改过的要求。"}).json(t, &edited)
	expect(t, fmt.Sprint(edited.Briefs[0].Version, edited.Briefs[1].Version), "2 1")
	var disabled routines.Routine
	e.patch(path, map[string]any{"enabled": false}).json(t, &disabled)
	if disabled.NextRunAt != nil {
		t.Fatal("a disabled routine runs next")
	}
	if _, ok := e.nats.Schedules[routine.ID]; ok {
		t.Fatal("still scheduled")
	}
	e.patch(path, map[string]any{"enabled": true})
	if _, ok := e.nats.Schedules[routine.ID]; !ok {
		t.Fatal("not scheduled")
	}
	expect(t, e.delete(path).status, 204)
	if _, ok := e.nats.Schedules[routine.ID]; ok {
		t.Fatal("still scheduled")
	}
	expect(t, scalar[int](e, "SELECT count(*) FROM routine"), 0)
}

func TestRestoreBrief(t *testing.T) {
	e := newEnv(t)
	routine := e.createRoutine(news())
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

func TestRoutineQueueDownKeepsNothing(t *testing.T) {
	e := newEnv(t)
	e.nats.Down = true
	expectError(t, e.post("/routines", news()), 503, "QUEUE_UNAVAILABLE")
	expect(t, scalar[int](e, "SELECT count(*) FROM routine"), 0)
}

func TestFireStartsARuntime(t *testing.T) {
	e := newEnv(t)
	routine := e.createRoutine(news())
	r := e.startRun(routine)
	expect(t, len(e.driver.started), 1)
	spec := e.driver.started[0]
	expect(t, strings.Join(spec.Command, " "), "python -m axp_runtime.routine")
	expect(t, spec.Env["AXP_INSTANCE_ID"], r.id)
	expect(t, spec.Env["AXP_RUNTIME_TOKEN"], r.token)
	settings := (&controlEnv{env: e}).settings(spec)
	expect(t, settings["model"], any(testModel))
	instructions := settings["developer_instructions"].(string)
	if !strings.Contains(instructions, "每天整理科技新闻。") || !strings.Contains(instructions, "这是第一次运行") {
		t.Fatalf("instructions %q", instructions)
	}
	if !strings.HasPrefix(spec.Env["AXP_ROUTINE_PROMPT"], "现在是") {
		t.Fatalf("prompt %q", spec.Env["AXP_ROUTINE_PROMPT"])
	}
	// Running already: asking again is refused.
	expectError(t, e.post("/routines/"+routine.ID+"/run", nil), 409, "ROUTINE_RUNNING")
}

func TestDisabledRoutineSkipsItsSchedule(t *testing.T) {
	e := newEnv(t)
	routine := e.createRoutine(news())
	e.patch("/routines/"+routine.ID, map[string]any{"enabled": false})
	e.nats.Fires = append(e.nats.Fires, queue.Fire{RoutineID: routine.ID})
	e.tick()
	expect(t, len(e.driver.started), 0)
}

func (e *env) shownRoutine() routines.Routine {
	var list RoutineList
	e.get("/routines").json(e.t, &list)
	return list.Routines[0]
}

func TestFinishWithReport(t *testing.T) {
	e := newEnv(t)
	r := e.startRun(e.createRoutine(news()))
	expect(t, r.finish("# 今日要闻\n\n内容", "已发送今日要闻").status, 200)
	// The runtime then exits; its own word does not override.
	r.complete(true, "最后一句", nil)
	shown := e.shownRoutine()
	expect(t, shown.Runs[0].Status, "sent")
	expect(t, *shown.Runs[0].Title, "今日要闻")
	expect(t, *shown.Runs[0].Report, "# 今日要闻\n\n内容")
	expect(t, shown.Handoff.Text, "已发送今日要闻")
}

func TestNothingNew(t *testing.T) {
	e := newEnv(t)
	r := e.startRun(e.createRoutine(news()))
	r.finish(nil, "源没有更新")
	expect(t, scalar[string](e, "SELECT status FROM routine_run"), "nothing_new")
}

func TestWithoutFinishTheLastMessageIsTheReport(t *testing.T) {
	e := newEnv(t)
	routine := e.createRoutine(news())
	r := e.startRun(routine)
	r.complete(true, "# 报告\n正文", nil)
	expect(t, scalar[string](e, "SELECT report FROM routine_run WHERE id = $1", r.id), "# 报告\n正文")
	failed := e.startRun(routine)
	failed.complete(false, "", "Codex 退出")
	expect(t, scalar[string](e, "SELECT error FROM routine_run WHERE id = $1", failed.id), "Codex 退出")
}

func TestNextRunGetsTheHandoff(t *testing.T) {
	e := newEnv(t)
	routine := e.createRoutine(news())
	e.startRun(routine).finish("# 一", "下次看看 RFC 结果")
	e.tick() // removes the finished run's container
	e.startRun(routine)
	last := e.driver.started[len(e.driver.started)-1]
	instructions := (&controlEnv{env: e}).settings(last)["developer_instructions"].(string)
	if !strings.Contains(instructions, "下次看看 RFC 结果") {
		t.Fatalf("instructions %q", instructions)
	}
}

func TestHistoryIsTheRoutinesOwn(t *testing.T) {
	e := newEnv(t)
	routine := e.createRoutine(news())
	first := e.startRun(routine)
	first.finish("# 第一份\n提到了 Rust 2027", "交接一")
	e.tick()
	other := e.createRoutine(with(news(), "name", "别的"))
	e.startRun(other).finish("# 别的报告", "")
	current := e.startRun(routine)
	var listed []routines.RunSummary
	current.call(http.MethodGet, "runs", nil).json(t, &listed)
	expect(t, len(listed), 1)
	expect(t, *listed[0].Title, "第一份")
	var found []routines.RunSummary
	current.call(http.MethodGet, "runs?q=Rust", nil).json(t, &found)
	expect(t, len(found), 1)
	expect(t, found[0].ID, first.id)
	var none []routines.RunSummary
	current.call(http.MethodGet, "runs?q=别的", nil).json(t, &none)
	expect(t, len(none), 0)
	// Paging back from a run's started_at.
	var older []routines.RunSummary
	current.call(http.MethodGet, "runs?before="+strings.ReplaceAll(listed[0].StartedAt, "+", "%2B"), nil).json(t, &older)
	expect(t, len(older), 0)
	var full routines.RunSummary
	current.call(http.MethodGet, "runs/"+first.id, nil).json(t, &full)
	if !strings.HasPrefix(*full.Report, "# 第一份") {
		t.Fatalf("report %q", *full.Report)
	}
	foreign := scalar[string](e, "SELECT id FROM routine_run WHERE routine_id = $1", other.ID)
	expect(t, current.call(http.MethodGet, "runs/"+foreign, nil).status, 404)
}

func TestTokenIsTheRunsOwnAndEndsWithIt(t *testing.T) {
	e := newEnv(t)
	routine := e.createRoutine(news())
	r := e.startRun(routine)
	expect(t, r.call(http.MethodGet, "runs", nil, "x").status, 403)
	key := r.id + "." + r.token
	runtimeAuth := func() response {
		return do(t, e.internal, http.MethodGet, "/internal/v1/runtime-auth", nil, map[string]string{"Authorization": "Bearer " + key})
	}
	expect(t, runtimeAuth().header.Get("X-AXP-Agent-Id"), "routine-"+routine.ID)
	r.finish(nil, "")
	e.tick()
	expect(t, r.call(http.MethodGet, "runs", nil).status, 403)
	expect(t, runtimeAuth().status, 403)
}

func TestWatch(t *testing.T) {
	e := newEnv(t)
	r := e.startRun(e.createRoutine(news()))
	container := scalar[string](e, "SELECT container_id FROM routine_run")
	e.driver.states[container] = "exited"
	e.tick() // within the grace period: it may still report
	expect(t, scalar[string](e, "SELECT status FROM routine_run"), "running")
	e.exec("UPDATE routine_run SET started_at = $1", time.Now().Add(-time.Minute))
	e.tick()
	expect(t, scalar[string](e, "SELECT status FROM routine_run WHERE id = $1", r.id), "failed")
	expect(t, scalar[string](e, "SELECT error FROM routine_run WHERE id = $1", r.id), "运行意外结束。")
	if !e.driver.wasStopped(container) {
		t.Fatal("not stopped")
	}
	expect(t, scalar[*string](e, "SELECT container_id FROM routine_run WHERE id = $1", r.id) == nil, true)
}

func TestTimeLimit(t *testing.T) {
	e := newEnv(t)
	e.startRun(e.createRoutine(news()))
	e.exec("UPDATE routine_run SET started_at = $1", time.Now().Add(-time.Hour))
	e.tick()
	expect(t, scalar[string](e, "SELECT error FROM routine_run"), "运行超过 15 分钟，已停止。")
}

func TestDeleteWaitsForTheRuntime(t *testing.T) {
	e := newEnv(t)
	routine := e.createRoutine(news())
	e.startRun(routine)
	expectError(t, e.delete("/routines/"+routine.ID), 409, "ROUTINE_RUNNING")
}

func reported(t *testing.T) (*env, routines.Routine, *run) {
	e := newEnv(t)
	routine := e.createRoutine(news())
	r := e.startRun(routine)
	r.finish("# 日报\n体育新闻……", "交接")
	return e, routine, r
}

func TestFeedbackRevisesTheBrief(t *testing.T) {
	e, routine, r := reported(t)
	sent := e.post("/routines/"+routine.ID+"/runs/"+r.id+"/feedback", map[string]any{"text": "别放体育新闻"})
	expect(t, sent.status, 201)
	if sent.m(t)["brief_version"] != nil {
		t.Fatal("revised already")
	}
	e.completer.text = "新要求"
	e.tick()
	prompt := e.completer.prompts[0]
	if !strings.Contains(prompt, "别放体育新闻") || !strings.Contains(prompt, "体育新闻……") {
		t.Fatalf("prompt %q", prompt)
	}
	expect(t, scalar[string](e, "SELECT text FROM routine_brief WHERE version = 2"), "新要求")
	expect(t, scalar[string](e, `SELECT f.text FROM routine_brief b JOIN routine_feedback f ON f.id = b.feedback_id
		WHERE b.version = 2`), "别放体育新闻")
	shown := e.shownRoutine()
	expect(t, *shown.Briefs[0].Feedback, "别放体育新闻")
	expect(t, *shown.Runs[0].Feedback[0].BriefVersion, int32(2))
}

func TestFailedRevisionIsMarked(t *testing.T) {
	e, routine, r := reported(t)
	e.post("/routines/"+routine.ID+"/runs/"+r.id+"/feedback", map[string]any{"text": "短一点"})
	e.completer.err = errors.New("down")
	e.tick()
	expect(t, scalar[bool](e, "SELECT revision_failed FROM routine_feedback"), true)
	expect(t, scalar[int](e, "SELECT count(*) FROM routine_brief"), 1)
}
