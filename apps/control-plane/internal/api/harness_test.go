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
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/akarachen/axp/apps/control-plane/internal/bundles"
	"github.com/akarachen/axp/apps/control-plane/internal/chat"
	"github.com/akarachen/axp/apps/control-plane/internal/container"
	"github.com/akarachen/axp/apps/control-plane/internal/control"
	"github.com/akarachen/axp/apps/control-plane/internal/llm"
	"github.com/akarachen/axp/apps/control-plane/internal/plugins"
	"github.com/akarachen/axp/apps/control-plane/internal/store"
	"github.com/akarachen/axp/packages/service-go/pg"
	"github.com/akarachen/axp/packages/service-go/pg/pgtest"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
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

// fakeRuntime is the agents' runtimes' control API: it records what the
// controller asks and answers as told.
type fakeRuntime struct {
	mu     sync.Mutex
	server *httptest.Server
	calls  []runtimeCall
	// answer answers a prompt or a steer; accepted when nil.
	answer func(path string) (int, map[string]any)
}

type runtimeCall struct {
	path, agent string
	body        map[string]any
}

func newFakeRuntime(t *testing.T, secret []byte) *fakeRuntime {
	f := &fakeRuntime{}
	f.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		agent := r.Header.Get("X-Test-Agent")
		f.mu.Lock()
		f.calls = append(f.calls, runtimeCall{path: r.URL.Path, agent: agent, body: body})
		answer := f.answer
		f.mu.Unlock()
		status, reply := 200, map[string]any{"accepted": true}
		if r.URL.Path == "/abort" {
			reply = map[string]any{}
		} else if answer != nil {
			status, reply = answer(r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_ = json.NewEncoder(w).Encode(reply)
	}))
	t.Cleanup(f.server.Close)
	return f
}

// called is what the controller asked at path, in order.
func (f *fakeRuntime) called(path string) []map[string]any {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []map[string]any
	for _, c := range f.calls {
		if c.path == path {
			out = append(out, c.body)
		}
	}
	return out
}

func (f *fakeRuntime) answering(fn func(path string) (int, map[string]any)) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.answer = fn
}

// fakeDriver is Docker: images it builds and containers it runs, whose
// control API is the fake runtime (or nothing, while down).
type fakeDriver struct {
	mu         sync.Mutex
	runtime    *fakeRuntime
	base       string
	images     map[string]bool
	built      []string
	contexts   []string
	failBuilds string
	containers map[string]*container.Runtime
	runs       []container.Spec
	removed    []string
	down       bool
}

func (f *fakeDriver) List(context.Context) ([]container.Runtime, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []container.Runtime
	for _, c := range f.containers {
		r := *c
		if r.State == container.Running {
			r.URL = f.runtime.server.URL
			if f.down {
				r.URL = "http://127.0.0.1:1"
			}
		}
		out = append(out, r)
	}
	return out, nil
}

func (f *fakeDriver) Run(_ context.Context, spec container.Spec) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.runs = append(f.runs, spec)
	f.containers[spec.AgentID] = &container.Runtime{
		AgentID: spec.AgentID, Config: spec.Config, State: container.Running,
	}
	return nil
}

func (f *fakeDriver) Remove(_ context.Context, agentID string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	delete(f.containers, agentID)
	f.removed = append(f.removed, agentID)
	return nil
}

func (f *fakeDriver) Base(context.Context) (string, string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.base, "axp-agent-runtime:test", nil
}

func (f *fakeDriver) ImageTag(hash string) string { return "axp-test-agent:" + hash }

func (f *fakeDriver) HasImage(_ context.Context, tag string) (bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.images[tag], nil
}

func (f *fakeDriver) Build(_ context.Context, dir, tag string) (string, error) {
	dockerfile, _ := os.ReadFile(filepath.Join(dir, "Dockerfile"))
	f.mu.Lock()
	defer f.mu.Unlock()
	f.built = append(f.built, tag)
	f.contexts = append(f.contexts, string(dockerfile))
	if f.failBuilds != "" {
		return f.failBuilds, fmt.Errorf("exit status 1")
	}
	f.images[tag] = true
	return "", nil
}

func (f *fakeDriver) Prune(context.Context, []string) error { return nil }

func (f *fakeDriver) runsOf(agentID string) []container.Spec {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []container.Spec
	for _, spec := range f.runs {
		if spec.AgentID == agentID {
			out = append(out, spec)
		}
	}
	return out
}

func (f *fakeDriver) builds() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return slices.Clone(f.built)
}

// --- the environment ---------------------------------------------------------------

type env struct {
	t          *testing.T
	ctx        context.Context
	db         *pgxpool.Pool
	models     *fakeCatalog
	driver     *fakeDriver
	runtimes   *fakeRuntime
	secret     []byte
	chat       *chat.Service
	public     http.Handler
	internal   http.Handler
	controller *control.Controller
}

const (
	repoBundles = "../../../../bundles"
	repoPlugins = "../../../../plugins"
)

func newEnv(t *testing.T) *env {
	t.Helper()
	e := &env{
		t:      t,
		ctx:    context.Background(),
		db:     pgtest.DB(t),
		models: &fakeCatalog{},
		secret: []byte("test-secret"),
	}
	e.runtimes = newFakeRuntime(t, e.secret)
	e.driver = &fakeDriver{
		runtime: e.runtimes, base: "sha256:base", images: map[string]bool{}, containers: map[string]*container.Runtime{},
	}
	e.models.set(llm.Model{ID: testModel, DisplayName: "Test Model", ContextWindow: 200000, Available: true})
	chatService := &chat.Service{
		Models:  e.models,
		Bundles: &bundles.Catalog{Dir: repoBundles, Plugins: &plugins.Catalog{Dir: repoPlugins}},
		Cursors: chat.Cursors{Secret: e.secret},
	}
	e.chat = chatService
	deps := &Deps{DB: e.db, Chat: chatService, Secret: e.secret}
	e.public = Public(deps).Router
	e.internal = Internal(deps).Router
	e.controller = &control.Controller{
		DB: e.db, Chat: chatService, Bundles: chatService.Bundles, Driver: e.driver, Models: e.models,
		Secret: e.secret, PluginsDir: repoPlugins,
		RuntimeGatewayURL: "http://runtime-gateway:8090", NATSURL: "nats://nats:4222",
	}
	return e
}

func (e *env) tick() { e.controller.Tick(e.ctx) }

// settle ticks until every agent has its container (images build in the
// background), or fails the test.
func (e *env) settle() {
	e.t.Helper()
	for range 200 {
		e.tick()
		e.driver.mu.Lock()
		running := len(e.driver.containers)
		e.driver.mu.Unlock()
		if scalar[int](e, `SELECT count(*) FROM agent WHERE deleted_at IS NULL`) == running {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	e.t.Fatal("agents' containers never started")
}

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
	r := e.post("/chat/messages", map[string]any{"group_id": e.direct(agentID), "text": text})
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
	"conversation", "agent_sequence", "product_status", "deleted_at",
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

// runtimeHarness is one boot of an agent's runtime, reporting events the way
// the controller imports them from NATS.
type runtimeHarness struct {
	e       *env
	agentID string
	boot    string
	seq     int64
}

type event struct {
	kind    string
	payload map[string]any
}

// events imports a batch of the boot's events, then lets the controller
// deliver what it now can.
func (r *runtimeHarness) events(events ...event) {
	r.e.t.Helper()
	batch := make([]chat.RuntimeEvent, 0, len(events))
	for _, ev := range events {
		r.seq++
		batch = append(batch, chat.RuntimeEvent{BootID: r.boot, Seq: r.seq, Type: ev.kind, Payload: ev.payload})
	}
	r.resend(batch...)
}

// resend imports events as given (a redelivery).
func (r *runtimeHarness) resend(batch ...chat.RuntimeEvent) {
	r.e.t.Helper()
	if err := pg.InTx(r.e.ctx, r.e.db, func(tx pgx.Tx) error {
		return r.e.chat.ImportEvents(r.e.ctx, tx, r.agentID, batch)
	}); err != nil {
		r.e.t.Fatalf("import: %v", err)
	}
	r.e.controller.Dispatch(r.e.ctx, r.agentID)
}

func (r *runtimeHarness) turnStarted(commandID, turnID string) {
	r.events(event{"turn.started", map[string]any{"command_id": commandID, "turn_id": turnID}})
}

func (r *runtimeHarness) turnCompleted(commandID, status string) {
	r.events(event{"turn.completed", map[string]any{"command_id": commandID, "status": status}})
}

func item(commandID string, fields ...any) event {
	it := map[string]any{}
	for i := 0; i+1 < len(fields); i += 2 {
		it[fields[i].(string)] = fields[i+1]
	}
	return event{"item.updated", map[string]any{"command_id": commandID, "item": it}}
}

// --- the controller side -------------------------------------------------------------

// controlEnv is a controller with fake Docker and runtimes, plus one agent.
type controlEnv struct {
	*env
	agent chat.Agent
}

func newControl(t *testing.T) *controlEnv {
	e := newEnv(t)
	return &controlEnv{env: e, agent: e.createAgent("开发助手")}
}

// sendText sends a message and wakes the controller, as the API's NOTIFY
// does.
func (c *controlEnv) sendText(text string) chat.Sent {
	sent := c.send(c.agent.ID, text)
	c.wake()
	return sent
}

func (c *controlEnv) wake() { c.controller.Dispatch(c.ctx, c.agent.ID) }

// boot is the agent's container started and its runtime reporting itself.
func (c *controlEnv) boot() *runtimeHarness {
	c.t.Helper()
	c.settle()
	r := &runtimeHarness{e: c.env, agentID: c.agent.ID, boot: uuid.NewString()}
	r.events(event{"runtime.started", map[string]any{"thread_id": "thread-1", "resumed": false}})
	return r
}

func (c *controlEnv) commandOf(sent chat.Sent) string {
	return scalar[string](c.env, "SELECT command_id FROM message WHERE id = $1", sent.Replies[0].ID)
}

func (c *controlEnv) replyStatus(sent chat.Sent) string {
	return scalar[string](c.env, "SELECT status FROM message WHERE id = $1", sent.Replies[0].ID)
}

func (c *controlEnv) replyFailure(sent chat.Sent) string {
	return scalar[string](c.env, "SELECT coalesce(failure->>'code', '') FROM message WHERE id = $1", sent.Replies[0].ID)
}

func (c *controlEnv) commandStatus(id string) string {
	return scalar[string](c.env, "SELECT status FROM agent_command WHERE id = $1", id)
}

// prompted is the command ids the runtime was asked to start, in order.
func (c *controlEnv) prompted() []string {
	var out []string
	for _, body := range c.runtimes.called("/prompt") {
		out = append(out, body["command_id"].(string))
	}
	return out
}

// running is one message delivered to a ready runtime, its turn started.
func (c *controlEnv) running() (chat.Sent, *runtimeHarness, string) {
	c.t.Helper()
	sent := c.sendText("检查项目结构")
	r := c.boot()
	command := c.commandOf(sent)
	if got := c.prompted(); len(got) != 1 || got[0] != command {
		c.t.Fatalf("prompted %v, want %s", got, command)
	}
	r.turnStarted(command, "turn-1")
	return sent, r, command
}

func (e *env) direct(agentID string) string {
	return scalar[string](e, "SELECT id::text FROM chat_group WHERE direct_agent_id=$1", agentID)
}
