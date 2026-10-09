package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"reflect"
	"regexp"
	"slices"
	"strings"
	"sync"
	"testing"

	"github.com/akarachen/axp/apps/control-plane/internal/chat"
	"github.com/akarachen/axp/apps/control-plane/internal/llm"
	"github.com/akarachen/axp/apps/control-plane/internal/tasks"
	"github.com/akarachen/axp/packages/service-go/pg"
	"github.com/danielgtaylor/huma/v2"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func TestEmptySnapshotHasNoSideEffects(t *testing.T) {
	e := newEnv(t)
	r := e.get("/chat")
	expect(t, r.status, 200)
	var snapshot chat.Snapshot
	r.json(t, &snapshot)
	if len(snapshot.Agents) != 0 || len(snapshot.ActiveReplies) != 0 || snapshot.EventCursor == "" {
		t.Fatalf("snapshot %+v", snapshot)
	}
	expect(t, scalar[int](e, "SELECT count(*) FROM conversation"), 0)
}

func TestSnapshotContainsAgentsAndActiveReplies(t *testing.T) {
	e := newEnv(t)
	agent := e.createAgent("开发助手")
	sent := e.send(agent.ID, "检查项目结构")
	r := e.get("/chat")
	var snapshot chat.Snapshot
	r.json(t, &snapshot)
	expect(t, snapshot.Agents[0].ID, agent.ID)
	// The message waits on a runtime that is not there yet.
	expect(t, snapshot.Agents[0].Status, "starting")
	expect(t, len(snapshot.ActiveReplies), 1)
	expect(t, snapshot.ActiveReplies[0].ID, sent.Reply.ID)
	if _, ok := r.m(t)["messages"]; ok {
		t.Fatal("messages in the snapshot")
	}
	assertNoInternalFields(t, r.m(t))
}

func firstText(page chat.MessagePage) string { return page.Items[0].Blocks[0].Text }

func TestHistoryPagesBackwardsInSendOrder(t *testing.T) {
	e := newEnv(t)
	e.nats.MaxQueued = 100
	agent := e.createAgent("开发助手")
	for i := range 30 {
		e.send(agent.ID, fmt.Sprintf("m%d", i)) // 60 messages
	}
	path := "/agents/" + agent.ID + "/messages"
	var latest, page chat.MessagePage
	e.get(path).json(t, &latest)
	expect(t, len(latest.Items), 50)
	expect(t, firstText(latest), "m5")
	expect(t, latest.Items[1].Role, "assistant")
	e.get(path, "before", *latest.NextCursor).json(t, &page)
	expect(t, len(page.Items), 10)
	if page.NextCursor != nil {
		t.Fatal("a cursor after the first message")
	}
	expect(t, firstText(page), "m0")
	assertNoInternalFields(t, latest)

	var small, older chat.MessagePage
	e.get(path, "limit", "4").json(t, &small)
	e.get(path, "limit", "4", "before", *small.NextCursor).json(t, &older)
	expect(t, firstText(small), "m28")
	expect(t, firstText(older), "m26")
	expect(t, e.get(path, "limit", "101").status, 422)
}

func TestHistoryIsOnlyThatAgents(t *testing.T) {
	e := newEnv(t)
	agent := e.createAgent("开发助手")
	other := e.createAgent("其他")
	mine := e.send(agent.ID, "mine")
	e.send(other.ID, "theirs")
	var page chat.MessagePage
	e.get("/agents/"+agent.ID+"/messages").json(t, &page)
	expect(t, len(page.Items), 2)
	expect(t, page.Items[0].ID, mine.Message.ID)
	expect(t, page.Items[1].ID, mine.Reply.ID)
}

func TestHistoryOfUnknownOrDeletedAgentIs404(t *testing.T) {
	e := newEnv(t)
	agent := e.createAgent("开发助手")
	expect(t, e.get("/agents/"+uuid.NewString()+"/messages").status, 404)
	expect(t, e.get("/agents/not-a-uuid/messages").status, 404)
	e.delete("/agents/" + agent.ID)
	expect(t, e.get("/agents/"+agent.ID+"/messages").status, 404)
}

func TestTamperedCursorRejected(t *testing.T) {
	e := newEnv(t)
	agent := e.createAgent("开发助手")
	cursor := chat.Cursors{Secret: e.secret}.History(10) + "x"
	expect(t, e.get("/agents/"+agent.ID+"/messages", "before", cursor).status, 400)
}

func TestCreateAgentReturnsProductFieldsOnly(t *testing.T) {
	e := newEnv(t)
	r := e.post("/agents", map[string]any{"name": "  开发助手  ", "model": testModel})
	got := r.m(t)
	if _, err := uuid.Parse(got["id"].(string)); err != nil {
		t.Fatal(err)
	}
	delete(got, "id")
	want := map[string]any{
		"name": "开发助手", "description": "", "model": "test-model",
		"plugins": []any{"approval", "github", "grok", "memory", "tasks"}, "status": "idle", "revision": float64(1),
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v", got)
	}
}

func TestAgentsShareOneDefaultConversation(t *testing.T) {
	e := newEnv(t)
	e.createAgent("a")
	e.createAgent("b")
	expect(t, scalar[int](e, "SELECT count(*) FROM conversation WHERE is_default"), 1)
	expect(t, scalar[int](e, "SELECT count(*) FROM conversation"), 1)
}

func TestAgentValidation(t *testing.T) {
	e := newEnv(t)
	for _, body := range []map[string]any{
		{"name": "   "},
		{"name": strings.Repeat("x", 101)},
		{"name": "a", "model": ""},
		{"name": "a", "engine": "x"},
		{},
	} {
		if r := e.post("/agents", body); r.status != 422 {
			t.Fatalf("%v: %d %s", body, r.status, r.body)
		}
	}
}

func catalog(e *env) {
	e.models.set(
		llm.Model{ID: "gpt-5.5", DisplayName: "GPT 5.5", ContextWindow: 272000, Available: true},
		llm.Model{ID: "grok-4", DisplayName: "Grok 4", UnavailableMessage: "Grok 账号登录已失效，请重新登录。"},
	)
}

func TestCreateAndChangeModel(t *testing.T) {
	e := newEnv(t)
	catalog(e)
	r := e.post("/agents", map[string]any{"name": "a", "model": "gpt-5.5"})
	expect(t, r.status, 201)
	var agent chat.Agent
	r.json(t, &agent)
	expect(t, *agent.Model, "gpt-5.5")
	before := scalar[int64](e, "SELECT config_version FROM agent WHERE id = $1", agent.ID)
	r = e.patch("/agents/"+agent.ID, map[string]any{"model": "grok-4"})
	expect(t, r.m(t)["model"], any("grok-4"))
	// The runtime restarts with the new model.
	expect(t, scalar[int64](e, "SELECT config_version FROM agent WHERE id = $1", agent.ID), before+1)
}

func TestUnknownModelIsRejected(t *testing.T) {
	e := newEnv(t)
	catalog(e)
	agent := e.createAgent("a", "")
	expectError(t, e.post("/agents", map[string]any{"name": "a", "model": "nope"}), 422, "MODEL_NOT_FOUND")
	expect(t, e.patch("/agents/"+agent.ID, map[string]any{"model": "nope"}).status, 422)
}

func TestChatNeedsAnAvailableModel(t *testing.T) {
	e := newEnv(t)
	catalog(e)
	agent := e.createAgent("a", "")
	body := map[string]any{"agent_id": agent.ID, "text": "hi"}
	expectError(t, e.post("/chat/messages", body), 409, "MODEL_NOT_SET")

	e.patch("/agents/"+agent.ID, map[string]any{"model": "grok-4"})
	r := e.post("/chat/messages", body)
	expectError(t, r, 409, "MODEL_UNAVAILABLE")
	if !strings.Contains(string(r.body), "重新登录") {
		t.Fatalf("message %s", r.body)
	}
	expect(t, scalar[int](e, "SELECT count(*) FROM message"), 0)

	// Reconnecting the account makes the same model usable again.
	e.models.set(llm.Model{ID: "grok-4", DisplayName: "Grok 4", Available: true})
	expect(t, e.post("/chat/messages", body).status, 202)
}

func TestGatewayDownBlocksChat(t *testing.T) {
	e := newEnv(t)
	catalog(e)
	var agent chat.Agent
	e.post("/agents", map[string]any{"name": "a", "model": "gpt-5.5"}).json(t, &agent)
	e.models.down = true
	expectError(t, e.post("/chat/messages", map[string]any{"agent_id": agent.ID, "text": "hi"}), 409, "MODEL_UNAVAILABLE")
}

func TestCreateWithDescription(t *testing.T) {
	e := newEnv(t)
	agent := e.createAgent("旧名字")
	instructions := "你是代码审查员。\n  只指出真实问题。"
	r := e.post("/agents", map[string]any{"name": "审查", "description": instructions})
	expect(t, r.status, 201)
	expect(t, r.m(t)["description"], any(instructions))
	expect(t, agent.Description, "")
	expect(t, e.post("/agents", map[string]any{"name": "x", "description": strings.Repeat("x", 10_001)}).status, 422)
}

func TestUpdateNameOrDescriptionBumpsConfigVersion(t *testing.T) {
	e := newEnv(t)
	agent := e.createAgent("旧名字")
	version := func() int64 { return scalar[int64](e, "SELECT config_version FROM agent WHERE id = $1", agent.ID) }
	before := version()
	got := e.patch("/agents/"+agent.ID, map[string]any{"description": "只用中文回答。"}).m(t)
	expect(t, got["description"], any("只用中文回答。"))
	expect(t, got["name"], any("旧名字"))
	expect(t, version(), before+1)
	// The name is part of the runtime's instructions too.
	e.patch("/agents/"+agent.ID, map[string]any{"name": "新"})
	expect(t, version(), before+2)
}

func TestPluginsAreChosenFromTheCatalog(t *testing.T) {
	e := newEnv(t)
	var plugins []struct{ Name string }
	e.get("/plugins").json(t, &plugins)
	var names []string
	for _, p := range plugins {
		names = append(names, p.Name)
	}
	if !slices.Equal(names, []string{"approval", "github", "grok", "memory", "tasks"}) {
		t.Fatalf("plugins %v", names)
	}
	created := e.post("/agents", map[string]any{"name": "a", "plugins": []string{"tasks", "grok"}})
	// Catalog order, whatever order they were sent in.
	expect(t, fmt.Sprint(created.m(t)["plugins"]), "[grok tasks]")
	expectError(t, e.post("/agents", map[string]any{"name": "a", "plugins": []string{"nope"}}), 422, "PLUGIN_NOT_FOUND")
}

func TestChangingPluginsBumpsConfigVersion(t *testing.T) {
	e := newEnv(t)
	agent := e.createAgent("旧名字")
	before := scalar[int64](e, "SELECT config_version FROM agent WHERE id = $1", agent.ID)
	r := e.patch("/agents/"+agent.ID, map[string]any{"plugins": []string{}})
	expect(t, fmt.Sprint(r.m(t)["plugins"]), "[]")
	expect(t, scalar[int64](e, "SELECT config_version FROM agent WHERE id = $1", agent.ID), before+1)
}

func TestRename(t *testing.T) {
	e := newEnv(t)
	agent := e.createAgent("旧名字")
	r := e.patch("/agents/"+agent.ID, map[string]any{"name": " 新名字 "})
	expect(t, r.status, 200)
	got := r.m(t)
	expect(t, got["name"], any("新名字"))
	expect(t, got["revision"], any(float64(agent.Revision+1)))
	payload := scalar[map[string]any](e, "SELECT payload FROM ui_event ORDER BY seq DESC LIMIT 1")
	expect(t, payload["agent"].(map[string]any)["name"], any("新名字"))
	expect(t, e.patch("/agents/"+agent.ID, map[string]any{"name": ""}).status, 422)
	expect(t, e.patch("/agents/"+uuid.NewString(), map[string]any{"name": "x"}).status, 404)
}

func TestDeleteHidesAgentKeepsHistoryAndStopsWork(t *testing.T) {
	e := newEnv(t)
	agent := e.createAgent("旧名字")
	sent := e.send(agent.ID, "检查项目结构")
	expect(t, e.delete("/agents/"+agent.ID).status, 204)
	var snapshot chat.Snapshot
	e.get("/chat").json(t, &snapshot)
	expect(t, len(snapshot.Agents), 0)
	expect(t, scalar[string](e, "SELECT status FROM message WHERE id = $1", sent.Reply.ID), "stopped")
	expect(t, scalar[int](e, "SELECT count(*) FROM message WHERE id = $1", sent.Message.ID), 1)
	kind := scalar[string](e, "SELECT type FROM ui_event ORDER BY seq DESC LIMIT 1")
	payload := scalar[map[string]any](e, "SELECT payload FROM ui_event ORDER BY seq DESC LIMIT 1")
	expect(t, kind, "agent.deleted")
	expect(t, fmt.Sprint(payload), fmt.Sprint(map[string]any{"agent_id": agent.ID}))
	expect(t, scalar[bool](e, "SELECT deleted_at IS NOT NULL FROM agent"), true)
	// A deleted agent cannot be used, renamed or deleted again.
	expect(t, e.post("/chat/messages", map[string]any{"agent_id": agent.ID, "text": "hi"}).status, 404)
	expect(t, e.patch("/agents/"+agent.ID, map[string]any{"name": "x"}).status, 404)
	expect(t, e.delete("/agents/"+agent.ID).status, 404)
}

func TestSendRetryReturnsSameMessages(t *testing.T) {
	e := newEnv(t)
	agent := e.createAgent("开发助手")
	body := map[string]any{"agent_id": agent.ID, "text": "hi"}
	first := e.post("/chat/messages", body, "send-1")
	second := e.post("/chat/messages", body, "send-1")
	expect(t, string(second.body), string(first.body))
	expect(t, scalar[int](e, "SELECT count(*) FROM agent_command"), 1)
}

func TestSendReturnsMessageAndReplyPlaceholder(t *testing.T) {
	e := newEnv(t)
	agent := e.createAgent("开发助手")
	text := "  def f():\n      return 1"
	sent := e.send(agent.ID, text)
	expect(t, sent.Message.Role, "user")
	expect(t, sent.Message.Status, "completed")
	if sent.Message.ReplyToID != nil {
		t.Fatal("a user message replies to nothing")
	}
	expect(t, sent.Message.Blocks[0].Text, text) // indentation kept
	expect(t, sent.Reply.Role, "assistant")
	expect(t, sent.Reply.Status, "queued")
	expect(t, *sent.Reply.ReplyToID, sent.Message.ID)
	expect(t, len(sent.Reply.Blocks), 0)
	assertNoInternalFields(t, sent)
}

func TestTextValidation(t *testing.T) {
	e := newEnv(t)
	agent := e.createAgent("开发助手")
	for _, text := range []string{"", "   \n\t", strings.Repeat("x", 10_001)} {
		expect(t, e.post("/chat/messages", map[string]any{"agent_id": agent.ID, "text": text}).status, 422)
	}
}

func TestSendToUnknownAgentIs404(t *testing.T) {
	e := newEnv(t)
	for _, id := range []string{uuid.NewString(), "not-a-uuid"} {
		expect(t, e.post("/chat/messages", map[string]any{"agent_id": id, "text": "hi"}).status, 404)
	}
}

func TestQueueFullIs429(t *testing.T) {
	e := newEnv(t)
	e.nats.MaxQueued = 2
	agent := e.createAgent("开发助手")
	e.send(agent.ID, "a")
	e.send(agent.ID, "b")
	expectError(t, e.post("/chat/messages", map[string]any{"agent_id": agent.ID, "text": "hi"}), 429, "QUEUE_FULL")
}

func TestEventsAreWrittenWithProjection(t *testing.T) {
	e := newEnv(t)
	agent := e.createAgent("开发助手")
	sent := e.send(agent.ID, "检查项目结构")
	rows, err := e.db.Query(e.ctx, "SELECT type, payload FROM ui_event ORDER BY seq")
	if err != nil {
		t.Fatal(err)
	}
	type ev struct {
		Type    string
		Payload map[string]any
	}
	events, err := pgx.CollectRows(rows, pgx.RowToStructByPos[ev])
	if err != nil {
		t.Fatal(err)
	}
	var kinds []string
	for _, e := range events {
		kinds = append(kinds, e.Type)
		assertNoInternalFields(t, e.Payload)
	}
	if !slices.Equal(kinds, []string{"agent.updated", "message.updated", "message.updated", "agent.updated"}) {
		t.Fatalf("events %v", kinds)
	}
	reply, _ := json.Marshal(sent.Reply)
	stored, _ := json.Marshal(events[2].Payload["message"])
	var a, b any
	_ = json.Unmarshal(reply, &a)
	_ = json.Unmarshal(stored, &b)
	if !reflect.DeepEqual(a, b) {
		t.Fatalf("stored %s, sent %s", stored, reply)
	}
	expect(t, events[3].Payload["agent"].(map[string]any)["status"], any("starting"))
}

func TestClientChoosesTheMessageID(t *testing.T) {
	e := newEnv(t)
	agent := e.createAgent("开发助手")
	id := "0b8f2a6c-58c4-4d1e-9a8e-2f0c1d3e4b5a"
	body := map[string]any{"id": id, "agent_id": agent.ID, "text": "你好"}
	r := e.post("/chat/messages", body, id)
	expect(t, r.status, 202)
	var sent chat.Sent
	r.json(t, &sent)
	expect(t, sent.Message.ID, id)
	expect(t, sent.Steered, false)
	// Sending it again, as a client does when it cannot tell whether the
	// first try arrived, is the same message.
	again := e.post("/chat/messages", body, id)
	expect(t, again.status, 202)
	var replayed chat.Sent
	again.json(t, &replayed)
	expect(t, replayed.Reply.ID, sent.Reply.ID)
	expect(t, scalar[int](e, "SELECT count(*) FROM message WHERE role = 'user'"), 1)
	expectError(t, e.post("/chat/messages", map[string]any{"id": "nope", "agent_id": agent.ID, "text": "你好"}), 422, "VALIDATION_ERROR")
}

func TestStopQueuedReplyCancels(t *testing.T) {
	e := newEnv(t)
	agent := e.createAgent("开发助手")
	sent := e.send(agent.ID, "检查项目结构")
	r := e.post("/chat/messages/"+sent.Reply.ID+"/stop", nil)
	expect(t, r.status, 200)
	expect(t, r.m(t)["status"], any("stopped"))
	expect(t, scalar[string](e, "SELECT status FROM agent_command"), "cancelled")
	// Repeating is a no-op with a fresh key.
	expect(t, string(e.post("/chat/messages/"+sent.Reply.ID+"/stop", nil).body), string(r.body))
	expect(t, e.agentStatus(), "idle")
}

func TestStopOnlyTargetsAssistantReplies(t *testing.T) {
	e := newEnv(t)
	agent := e.createAgent("开发助手")
	sent := e.send(agent.ID, "检查项目结构")
	expect(t, e.post("/chat/messages/"+sent.Message.ID+"/stop", nil).status, 404)
}

func TestStopTargetsOnlyThatReply(t *testing.T) {
	e := newEnv(t)
	agent := e.createAgent("开发助手")
	sent := e.send(agent.ID, "a")
	second := e.send(agent.ID, "b")
	e.post("/chat/messages/"+sent.Reply.ID+"/stop", nil)
	var page chat.MessagePage
	e.get("/agents/"+agent.ID+"/messages").json(t, &page)
	for _, m := range page.Items {
		if m.ID == second.Reply.ID {
			expect(t, m.Status, "queued")
		}
	}
}

func drain(t *testing.T, e *env, seq int64, opts streamOptions) string {
	t.Helper()
	var out strings.Builder
	if opts.poll == 0 {
		opts.poll = 1
	}
	if opts.heartbeat == 0 {
		opts.heartbeat = heartbeat
	}
	if opts.maxIdlePolls == 0 {
		opts.maxIdlePolls = 1
	}
	if err := streamEvents(context.Background(), &Deps{DB: e.db, Chat: &chat.Service{Cursors: chat.Cursors{Secret: e.secret}}},
		&out, func() {}, seq, opts); err != nil {
		t.Fatal(err)
	}
	return out.String()
}

func TestStreamResumesFromTheInitialCursor(t *testing.T) {
	e := newEnv(t)
	var snapshot chat.Snapshot
	e.get("/chat").json(t, &snapshot)
	agent := e.createAgent("开发助手")
	seq, err := chat.Cursors{Secret: e.secret}.DecodeEvent(snapshot.EventCursor)
	if err != nil {
		t.Fatal(err)
	}
	output := drain(t, e, seq, streamOptions{})
	if !strings.Contains(output, "event: agent.updated") || !strings.Contains(output, agent.ID) {
		t.Fatalf("output %q", output)
	}
}

func TestStreamResumesFromLastEventID(t *testing.T) {
	e := newEnv(t)
	agent := e.createAgent("开发助手")
	e.send(agent.ID, "检查项目结构")
	output := drain(t, e, 0, streamOptions{})
	var ids []string
	for _, line := range strings.Split(output, "\n") {
		if id, ok := strings.CutPrefix(line, "id: "); ok {
			ids = append(ids, id)
		}
	}
	expect(t, len(ids), 4) // the agent, then the send's three
	seq, _ := chat.Cursors{Secret: e.secret}.DecodeEvent(ids[1])
	rest := drain(t, e, seq, streamOptions{})
	expect(t, strings.Count(rest, "event: "), 2)
	if strings.Contains(rest, ": heartbeat") {
		t.Fatal("heartbeat")
	}
}

func TestStreamHeaderTakesPrecedenceAndCursorsAreChecked(t *testing.T) {
	e := newEnv(t)
	e.createAgent("开发助手")
	cursors := chat.Cursors{Secret: e.secret}
	expect(t, e.get("/chat/stream", "cursor", cursors.Event(0)+"x").status, 400)
	expectError(t, e.get("/chat/stream", "cursor", cursors.Event(999)), 410, "CURSOR_EXPIRED")
	expect(t, e.get("/chat/stream").status, 400)
	// A valid Last-Event-ID wins over the expired cursor; the stream starts.
	ctx, cancel := context.WithCancel(context.Background())
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, "/api/v1/chat/stream?cursor="+cursors.Event(999), nil)
	req.Header.Set("Last-Event-ID", cursors.Event(0))
	rec := newStreamRecorder()
	done := make(chan struct{})
	go func() { e.public.ServeHTTP(rec, req); close(done) }()
	<-rec.wrote
	cancel()
	<-done
	expect(t, rec.code, 200)
	expect(t, rec.header.Get("Content-Type"), "text/event-stream")
	expect(t, rec.header.Get("Cache-Control"), "no-cache")
}

func TestHeartbeatHasNoID(t *testing.T) {
	e := newEnv(t)
	output := drain(t, e, 0, streamOptions{heartbeat: 1, maxIdlePolls: 2})
	if !strings.Contains(output, ": heartbeat\n\n") || strings.Contains(output, "id:") {
		t.Fatalf("output %q", output)
	}
}

// streamRecorder records a streaming response, safely across goroutines.
type streamRecorder struct {
	mu     sync.Mutex
	header http.Header
	code   int
	wrote  chan struct{}
	once   sync.Once
}

func newStreamRecorder() *streamRecorder {
	return &streamRecorder{header: http.Header{}, wrote: make(chan struct{})}
}

func (r *streamRecorder) Header() http.Header { return r.header }
func (r *streamRecorder) WriteHeader(code int) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.code == 0 {
		r.code = code
	}
}
func (r *streamRecorder) Write(b []byte) (int, error) {
	r.WriteHeader(200)
	r.once.Do(func() { close(r.wrote) })
	return len(b), nil
}
func (r *streamRecorder) Flush() {}

func TestPublicSchemaHasNoInternalFields(t *testing.T) {
	document := Public(&Deps{Chat: &chat.Service{}, Tasks: &tasks.Service{}}).API
	spec := document.OpenAPI()
	var paths []string
	for path := range spec.Paths {
		if strings.HasPrefix(path, "/api/v1") {
			paths = append(paths, path)
		}
	}
	slices.Sort(paths)
	want := []string{
		"/api/v1/agents", "/api/v1/agents/{agent_id}", "/api/v1/agents/{agent_id}/compact",
		"/api/v1/agents/{agent_id}/messages", "/api/v1/agents/{agent_id}/restart", "/api/v1/chat",
		"/api/v1/chat/interactions", "/api/v1/chat/interactions/{interaction_id}/answer", "/api/v1/chat/messages",
		"/api/v1/chat/messages/{message_id}/stop", "/api/v1/chat/stream", "/api/v1/computers",
		"/api/v1/computers/{computer_id}", "/api/v1/computers/{computer_id}/install",
		"/api/v1/computers/{computer_id}/runtimes/{kind}/approve",
		"/api/v1/computers/{computer_id}/runtimes/{kind}/places", "/api/v1/plugins",
		"/api/v1/tasks", "/api/v1/tasks/{task_id}", "/api/v1/tasks/{task_id}/comments",
		"/api/v1/tasks/{task_id}/runs/{run_id}/confirm",
		"/api/v1/tasks/{task_id}/runs/{run_id}/interrupt", "/api/v1/tasks/{task_id}/runs/{run_id}/log",
	}
	if !slices.Equal(paths, want) {
		t.Fatalf("paths %v", paths)
	}
	// The task board's own vocabulary is not the agents' internals: a
	// remote computer's runtime (Paseo, Herdr), a tool call's command.
	board := regexp.MustCompile(`^(Task|Computer|Assignee|LogEntry|RunLog|Install|Enrollment|Comment|Place)`)
	properties := map[string]any{}
	for schemaName, schema := range spec.Components.Schemas.Map() {
		if board.MatchString(schemaName) {
			continue
		}
		for name := range schema.Properties {
			properties[name] = true
		}
	}
	assertNoInternalFields(t, properties)
}

// Cloudflare, in front of production, replaces an origin's 502 and 504 with
// its own error page: no operation may answer with them.
func TestNoOperationAnswersWithStatusesCloudflareReplaces(t *testing.T) {
	document := Public(&Deps{Chat: &chat.Service{}, Tasks: &tasks.Service{}}).API
	for path, item := range document.OpenAPI().Paths {
		for _, op := range []*huma.Operation{item.Get, item.Post, item.Put, item.Patch, item.Delete} {
			if op == nil {
				continue
			}
			for status := range op.Responses {
				if status == "502" || status == "504" {
					t.Fatalf("%s %s answers %s", op.Method, path, status)
				}
			}
		}
	}
}

func TestConcurrentFirstAgentsShareOneDefaultChat(t *testing.T) {
	e := newEnv(t)
	var wg sync.WaitGroup
	errs := make(chan error, 4)
	for i := range 4 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			errs <- pg.InTx(e.ctx, e.db, func(tx pgx.Tx) error {
				_, err := e.chat.CreateAgent(e.ctx, tx, fmt.Sprintf("agent-%d", i), "", nil, nil)
				return err
			})
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	expect(t, scalar[int](e, "SELECT count(*) FROM conversation"), 1)
	expect(t, scalar[int](e, "SELECT count(*) FROM agent"), 4)
}

func TestMessageAgentMustShareConversation(t *testing.T) {
	e := newEnv(t)
	agent := e.createAgent("开发助手")
	e.send(agent.ID, "hi")
	command := scalar[string](e, "SELECT id FROM agent_command")
	e.exec(`INSERT INTO conversation (id, is_default, title, last_event_seq, last_ui_event_seq, last_message_seq,
		created_at, updated_at) VALUES ($1, false, '', 0, 0, 0, now(), now())`, "00000000-0000-0000-0000-000000000001")
	err := pg.InTx(e.ctx, e.db, func(tx pgx.Tx) error {
		if _, err := tx.Exec(e.ctx, "SET CONSTRAINTS ALL IMMEDIATE"); err != nil {
			return err
		}
		_, err := tx.Exec(e.ctx, `INSERT INTO message (id, conversation_id, agent_id, command_id, seq, role, content,
			status, revision, created_at, updated_at)
			VALUES ($1, '00000000-0000-0000-0000-000000000001', $2, $3, 99, 'user', '[]', 'completed', 1, now(), now())`,
			uuid.NewString(), agent.ID, command)
		return err
	})
	if err == nil {
		t.Fatal("a message in another conversation than its agent's")
	}
}
