package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/akarachen/axp/apps/control-plane/internal/auth"
	"github.com/akarachen/axp/apps/control-plane/internal/chat"
	"github.com/akarachen/axp/apps/control-plane/internal/container"
	"github.com/akarachen/axp/apps/control-plane/internal/control"
	"github.com/akarachen/axp/apps/control-plane/internal/llm"
	"github.com/akarachen/axp/apps/control-plane/internal/plugins"
	"github.com/akarachen/axp/apps/control-plane/internal/queue/queuetest"
	"github.com/akarachen/axp/apps/control-plane/internal/store"
	"github.com/akarachen/axp/packages/service-go/pg/pgtest"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestMain(m *testing.M) { pgtest.Main(m, store.Migrations) }

// testModel is the model the fake LLM gateway offers.
const testModel = "test-model"

// --- fakes -------------------------------------------------------------------------

type fakeCatalog struct {
	mu     sync.Mutex
	models map[string]llm.Model
	down   bool
}

func (f *fakeCatalog) Models(context.Context, bool) (map[string]llm.Model, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.down {
		return nil, llm.ErrUnavailable
	}
	out := map[string]llm.Model{}
	for k, v := range f.models {
		out[k] = v
	}
	return out, nil
}

func (f *fakeCatalog) set(models ...llm.Model) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.models = map[string]llm.Model{}
	for _, m := range models {
		f.models[m.ID] = m
	}
}

type fakeDriver struct {
	started   []container.Spec
	stopped   []string
	states    map[string]string
	failStart bool
}

func (f *fakeDriver) Name(suffix string) string { return "axp-" + suffix }

func (f *fakeDriver) Start(_ context.Context, spec container.Spec) (container.Started, error) {
	if f.failStart {
		return container.Started{}, fmt.Errorf("docker down")
	}
	f.started = append(f.started, spec)
	id := strings.ReplaceAll(uuid.NewString(), "-", "")
	f.states[id] = container.Running
	return container.Started{ContainerID: id, ImageDigest: "sha"}, nil
}

func (f *fakeDriver) State(_ context.Context, id string) (string, error) {
	if s, ok := f.states[id]; ok {
		return s, nil
	}
	return container.Missing, nil
}

func (f *fakeDriver) Stop(_ context.Context, instanceID string) error {
	f.stopped = append(f.stopped, instanceID)
	return nil
}

func (f *fakeDriver) wasStopped(instanceID string) bool {
	return slices.Contains(f.stopped, instanceID)
}

// fakeS3 is agent snapshots, by agent id, behind presigned-looking URLs.
type fakeS3 struct{ snapshots map[string]bool }

func (f *fakeS3) Exists(_ context.Context, agentID string) (bool, error) {
	return f.snapshots[agentID], nil
}
func (f *fakeS3) UploadURL(_ context.Context, agentID string) (string, error) {
	return "http://s3.test/put/" + agentID, nil
}
func (f *fakeS3) DownloadURL(_ context.Context, agentID string) (string, error) {
	return "http://s3.test/get/" + agentID, nil
}

// --- the environment ---------------------------------------------------------------

type env struct {
	t          *testing.T
	ctx        context.Context
	db         *pgxpool.Pool
	nats       *queuetest.Fake
	models     *fakeCatalog
	driver     *fakeDriver
	s3         *fakeS3
	secret     []byte
	chat       *chat.Service
	public     http.Handler
	internal   http.Handler
	controller *control.Controller
}

func newEnv(t *testing.T) *env {
	t.Helper()
	e := &env{
		t:      t,
		ctx:    context.Background(),
		db:     pgtest.DB(t),
		nats:   queuetest.New(),
		models: &fakeCatalog{},
		driver: &fakeDriver{states: map[string]string{}},
		s3:     &fakeS3{snapshots: map[string]bool{}},
		secret: []byte("test-secret"),
	}
	e.models.set(llm.Model{ID: testModel, DisplayName: "Test Model", Available: true})
	chatService := &chat.Service{
		Queue: e.nats, Models: e.models, Plugins: &plugins.Catalog{Dir: "../../../agent-runtime/plugins"},
		Cursors: chat.Cursors{Secret: e.secret},
	}
	e.chat = chatService
	deps := &Deps{
		DB:       e.db,
		Chat:     chatService,
		Protocol: &control.Protocol{DB: e.db, Chat: chatService, Snapshots: e.s3, Secret: e.secret},
	}
	e.public = Public(deps).Router
	e.internal = Internal(deps).Router
	e.controller = &control.Controller{
		DB: e.db, Chat: chatService, Queue: e.nats, Driver: e.driver, Snapshots: e.s3, Models: e.models,
		Secret: e.secret, RuntimeGatewayURL: "http://runtime-gateway:8090",
		NATSURL: "nats://nats:4222", ID: "controller-test", HostID: "test",
	}
	return e
}

func (e *env) tick() { e.controller.Tick(e.ctx) }

// --- HTTP ----------------------------------------------------------------------------

type response struct {
	status int
	header http.Header
	body   []byte
}

func (r response) json(t *testing.T, v any) {
	t.Helper()
	if err := json.Unmarshal(r.body, v); err != nil {
		t.Fatalf("decode %s: %v", r.body, err)
	}
}

// m is the body as a generic value.
func (r response) m(t *testing.T) map[string]any {
	t.Helper()
	var v map[string]any
	r.json(t, &v)
	return v
}

func (r response) error() (int, string) {
	var body struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	_ = json.Unmarshal(r.body, &body)
	return r.status, body.Error.Code
}

func do(t *testing.T, handler http.Handler, method, path string, body any, headers map[string]string) response {
	t.Helper()
	var reader io.Reader
	switch b := body.(type) {
	case nil:
	case string:
		reader = strings.NewReader(b)
	default:
		data, err := json.Marshal(b)
		if err != nil {
			t.Fatal(err)
		}
		reader = bytes.NewReader(data)
	}
	req := httptest.NewRequest(method, path, reader)
	if reader != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	return response{rec.Code, rec.Header(), rec.Body.Bytes()}
}

func (e *env) get(path string, query ...string) response {
	if len(query) > 0 {
		values := url.Values{}
		for i := 0; i+1 < len(query); i += 2 {
			values.Set(query[i], query[i+1])
		}
		path += "?" + values.Encode()
	}
	return do(e.t, e.public, http.MethodGet, "/api/v1"+path, nil, nil)
}

// post sends with a fresh Idempotency-Key unless key is given ("-" for none).
func (e *env) post(path string, body any, key ...string) response {
	k := uuid.NewString()
	if len(key) > 0 {
		k = key[0]
	}
	headers := map[string]string{}
	if k != "-" {
		headers["Idempotency-Key"] = k
	}
	return do(e.t, e.public, http.MethodPost, "/api/v1"+path, body, headers)
}

func (e *env) patch(path string, body any) response {
	return do(e.t, e.public, http.MethodPatch, "/api/v1"+path, body, nil)
}

func (e *env) delete(path string) response {
	return do(e.t, e.public, http.MethodDelete, "/api/v1"+path, nil, nil)
}

func (e *env) createAgent(name string, model ...string) chat.Agent {
	e.t.Helper()
	body := map[string]any{"name": name}
	if len(model) == 0 {
		body["model"] = testModel
	} else if model[0] != "" {
		body["model"] = model[0]
	}
	r := e.post("/agents", body)
	if r.status != 201 {
		e.t.Fatalf("create agent: %d %s", r.status, r.body)
	}
	var agent chat.Agent
	r.json(e.t, &agent)
	return agent
}

func (e *env) send(agentID, text string) chat.Sent {
	e.t.Helper()
	r := e.post("/chat/messages", map[string]any{"agent_id": agentID, "text": text})
	if r.status != 202 {
		e.t.Fatalf("send: %d %s", r.status, r.body)
	}
	var sent chat.Sent
	r.json(e.t, &sent)
	return sent
}

func (e *env) agentStatus() string {
	var snapshot chat.Snapshot
	e.get("/chat").json(e.t, &snapshot)
	return snapshot.Agents[0].Status
}

// scalar reads one value.
func scalar[T any](e *env, sql string, args ...any) T {
	e.t.Helper()
	var v T
	if err := e.db.QueryRow(e.ctx, sql, args...).Scan(&v); err != nil {
		e.t.Fatalf("%s: %v", sql, err)
	}
	return v
}

func (e *env) exec(sql string, args ...any) {
	e.t.Helper()
	if _, err := e.db.Exec(e.ctx, sql, args...); err != nil {
		e.t.Fatalf("%s: %v", sql, err)
	}
}

// Fields that must never reach the browser.
var internalMarkers = []string{
	"command", "thread", "runtime", "generation", "lease", "claim", "container",
	"conversation", "agent_sequence", "seq", "product_status", "deleted_at",
}

func collectKeys(v any, keys map[string]bool) {
	switch v := v.(type) {
	case map[string]any:
		for k, item := range v {
			keys[k] = true
			collectKeys(item, keys)
		}
	case []any:
		for _, item := range v {
			collectKeys(item, keys)
		}
	}
}

func assertNoInternalFields(t *testing.T, payload any) {
	t.Helper()
	data, _ := json.Marshal(payload)
	var generic any
	_ = json.Unmarshal(data, &generic)
	keys := map[string]bool{}
	collectKeys(generic, keys)
	for k := range keys {
		for _, m := range internalMarkers {
			if strings.Contains(k, m) {
				t.Fatalf("internal field leaked: %s", k)
			}
		}
	}
}

func expect[T comparable](t *testing.T, got, want T) {
	t.Helper()
	if got != want {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func expectError(t *testing.T, r response, status int, code string) {
	t.Helper()
	gotStatus, gotCode := r.error()
	if gotStatus != status || gotCode != code {
		t.Fatalf("got %d %s, want %d %s (%s)", gotStatus, gotCode, status, code, r.body)
	}
}

// --- the runtime side --------------------------------------------------------------

// runtimeHarness talks to the internal API the way a runtime does.
type runtimeHarness struct {
	e          *env
	instanceID string
	token      string
	seq        int64
}

func (e *env) liveInstance(agentID string) (id string, generation int64) {
	e.t.Helper()
	if err := e.db.QueryRow(e.ctx, `SELECT id, generation FROM runtime_instance
		WHERE agent_id = $1 AND ended_at IS NULL`, agentID).Scan(&id, &generation); err != nil {
		e.t.Fatalf("live instance: %v", err)
	}
	return id, generation
}

func (e *env) runtime(agentID string) *runtimeHarness {
	id, generation := e.liveInstance(agentID)
	return &runtimeHarness{e: e, instanceID: id, token: auth.RuntimeToken(e.secret, id, generation)}
}

func (r *runtimeHarness) call(method, path string, body any, token ...string) response {
	tok := r.token
	if len(token) > 0 {
		tok = token[0]
	}
	if body == nil {
		body = map[string]any{}
	}
	return do(r.e.t, r.e.internal, method, "/internal/v1/runtime-instances/"+r.instanceID+"/"+path, body,
		map[string]string{"Authorization": "Bearer " + tok})
}

func (r *runtimeHarness) heartbeat(status string, extra ...any) response {
	body := map[string]any{"status": status}
	for i := 0; i+1 < len(extra); i += 2 {
		body[extra[i].(string)] = extra[i+1]
	}
	return r.call(http.MethodPost, "heartbeat", body)
}

func (r *runtimeHarness) session(threadID string) response {
	return r.call(http.MethodPut, "session", map[string]any{"thread_id": threadID})
}

type event struct {
	kind    string
	payload map[string]any
}

func (r *runtimeHarness) events(events ...event) response {
	return r.eventsFrom(0, events...)
}

// eventsFrom numbers the batch from start (0: after the last one).
func (r *runtimeHarness) eventsFrom(start int64, events ...event) response {
	batch := []map[string]any{}
	for _, ev := range events {
		if start > 0 {
			r.seq, start = start, 0
		} else {
			r.seq++
		}
		batch = append(batch, map[string]any{
			"source_seq":      r.seq,
			"source_event_id": fmt.Sprintf("%s-%d", r.instanceID, r.seq),
			"type":            ev.kind,
			"payload":         ev.payload,
		})
	}
	return r.call(http.MethodPost, "events", map[string]any{"events": batch})
}

func (r *runtimeHarness) turnStarted(commandID, turnID string) response {
	return r.events(event{"turn.started", map[string]any{"command_id": commandID, "turn_id": turnID}})
}

// turnCompleted ends the turn as the runtime does: reported finished, then
// the snapshot it left saved.
func (r *runtimeHarness) turnCompleted(commandID, status string) response {
	return r.events(event{"turn.completed", map[string]any{"command_id": commandID, "status": status}},
		event{"snapshot.saved", map[string]any{"size": 1}})
}

// turnCompletedUploading ends the turn with its snapshot still uploading.
func (r *runtimeHarness) turnCompletedUploading(commandID, status string) response {
	return r.events(event{"turn.completed", map[string]any{"command_id": commandID, "status": status}})
}

func (r *runtimeHarness) ready(threadID string) {
	r.e.t.Helper()
	if s := r.session(threadID).status; s != 200 {
		r.e.t.Fatalf("session: %d", s)
	}
	if s := r.heartbeat("ready").status; s != 200 {
		r.e.t.Fatalf("heartbeat: %d", s)
	}
}

func item(commandID string, fields ...any) event {
	it := map[string]any{}
	for i := 0; i+1 < len(fields); i += 2 {
		it[fields[i].(string)] = fields[i+1]
	}
	return event{"item.updated", map[string]any{"command_id": commandID, "item": it}}
}

// --- the controller side -------------------------------------------------------------

// control is a controller with fake Docker and NATS, plus one agent.
type controlEnv struct {
	*env
	agent chat.Agent
}

func newControl(t *testing.T) *controlEnv {
	e := newEnv(t)
	return &controlEnv{env: e, agent: e.createAgent("开发助手")}
}

func (c *controlEnv) sendText(text string) chat.Sent { return c.send(c.agent.ID, text) }

func (c *controlEnv) startRuntime(threadID string) *runtimeHarness {
	c.tick()
	r := c.runtime(c.agent.ID)
	r.ready(threadID)
	return r
}

func (c *controlEnv) commandOf(sent chat.Sent) string {
	return scalar[string](c.env, "SELECT command_id FROM message WHERE id = $1", sent.Reply.ID)
}

// take is what the runtime does: take the next command from the queue.
func (c *controlEnv) take(commandID string) map[string]any {
	c.t.Helper()
	body := c.nats.Take(c.agent.ID)
	if body == nil || body["command_id"] != commandID {
		c.t.Fatalf("took %v, want command %s", body, commandID)
	}
	return body
}

func (c *controlEnv) replyStatus(sent chat.Sent) string {
	return scalar[string](c.env, "SELECT status FROM message WHERE id = $1", sent.Reply.ID)
}

func (c *controlEnv) replyFailure(sent chat.Sent) string {
	return scalar[string](c.env, "SELECT failure->>'code' FROM message WHERE id = $1", sent.Reply.ID)
}

func (c *controlEnv) commandStatus(id string) string {
	return scalar[string](c.env, "SELECT status FROM agent_command WHERE id = $1", id)
}

func (c *controlEnv) expireLeases() {
	c.exec("UPDATE runtime_instance SET lease_expires_at = $1 WHERE ended_at IS NULL", time.Now().Add(-time.Second))
}

// running is one message taken by a ready runtime.
func (c *controlEnv) running() (chat.Sent, *runtimeHarness, string) {
	sent := c.sendText("检查项目结构")
	r := c.startRuntime("thread-1")
	command := c.commandOf(sent)
	c.take(command)
	return sent, r, command
}

func (c *controlEnv) settings(spec container.Spec) map[string]any {
	var s map[string]any
	if err := json.Unmarshal([]byte(spec.Env["AXP_CODEX_SETTINGS"]), &s); err != nil {
		c.t.Fatal(err)
	}
	return s
}
