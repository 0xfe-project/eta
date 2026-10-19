package gateway

import (
	"context"
	"errors"
	"net/http"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy"
	coreauth "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
)

// The tests drive CPA's real auth manager with request results, the way
// CPA's conductor does after each upstream request, and read what the
// gateway reports from it.

type fakeRegistry struct {
	cliproxy.ModelRegistry
	models map[string][]string // auth id → model ids
}

func (r fakeRegistry) GetModelsForClient(id string) []*cliproxy.ModelInfo {
	var out []*cliproxy.ModelInfo
	for _, m := range r.models[id] {
		out = append(out, &cliproxy.ModelInfo{ID: m})
	}
	return out
}

// fakeConnector reports usage through read, counting calls.
type fakeConnector struct {
	id, provider string
	calls        atomic.Int32
	read         func(ctx context.Context) error
}

func (f *fakeConnector) Info() ConnectorInfo {
	return ConnectorInfo{ID: f.id, DisplayName: f.id, Provider: f.provider}
}
func (f *fakeConnector) StartLogin(context.Context, LoginInput) (*LoginSession, error) {
	return nil, ErrUnsupported
}
func (f *fakeConnector) PollLogin(context.Context, string) (*LoginSession, error) {
	return nil, ErrUnsupported
}
func (f *fakeConnector) SubmitLogin(context.Context, string, LoginInput) error { return ErrUnsupported }
func (f *fakeConnector) CancelLogin(context.Context, string) error             { return ErrUnsupported }
func (f *fakeConnector) Usage(ctx context.Context, _ map[string]any) (Usage, error) {
	f.calls.Add(1)
	if f.read == nil {
		return Usage{}, nil
	}
	return Usage{}, f.read(ctx)
}

type fixture struct {
	s      *Service
	auths  *coreauth.Manager
	codex  *fakeConnector
	xai    *fakeConnector
	offset time.Duration // how far the gateway's clock is ahead
}

// newFixture connects codex accounts "a" (gpt-1, gpt-2) and "b" (gpt-1)
// and an xAI account "x" (grok).
func newFixture(t *testing.T) *fixture {
	t.Helper()
	f := &fixture{
		auths: coreauth.NewManager(nil, nil, nil),
		codex: &fakeConnector{id: "codex", provider: "codex"},
		xai:   &fakeConnector{id: "xai", provider: "xai"},
	}
	for id, provider := range map[string]string{"a": "codex", "b": "codex", "x": "xai"} {
		if _, err := f.auths.Register(context.Background(), &coreauth.Auth{ID: id, Provider: provider, Status: coreauth.StatusActive}); err != nil {
			t.Fatal(err)
		}
	}
	f.s = NewService(Config{
		Connectors:  []Connector{f.codex, f.xai},
		Auths:       f.auths,
		Registry:    fakeRegistry{models: map[string][]string{"a": {"gpt-1", "gpt-2"}, "b": {"gpt-1"}, "x": {"grok"}}},
		CatalogPath: t.TempDir() + "/models.json",
	})
	f.s.now = func() time.Time { return time.Now().Add(f.offset) }
	return f
}

func (f *fixture) result(auth, model string, status int) {
	r := coreauth.Result{AuthID: auth, Provider: "codex", Model: model, Success: status == 0}
	if status != 0 {
		r.Error = &coreauth.Error{HTTPStatus: status, Message: http.StatusText(status)}
	}
	f.auths.MarkResult(context.Background(), r)
}

func (f *fixture) remove(t *testing.T, id string) {
	t.Helper()
	f.auths.Remove(context.Background(), id)
}

func (f *fixture) model(t *testing.T, id string) Model {
	t.Helper()
	for _, m := range f.s.Models() {
		if m.ID == id {
			return m
		}
	}
	t.Fatalf("no model %s", id)
	return Model{}
}

func (f *fixture) conn(t *testing.T, id string) Connection {
	t.Helper()
	for _, c := range f.s.Connections() {
		if c.ID == id {
			return c
		}
	}
	t.Fatalf("no connection %s", id)
	return Connection{}
}

func wantModel(t *testing.T, m Model, status, code string) {
	t.Helper()
	got := ""
	if m.Reason != nil {
		got = m.Reason.Code
	}
	if m.Status != status || got != code || m.Available != (status != ModelUnavailable) {
		t.Fatalf("%s: status=%s available=%v reason=%s, want %s %s", m.ID, m.Status, m.Available, got, status, code)
	}
}

func TestOne502StaysOnItsModelAndEnds(t *testing.T) {
	f := newFixture(t)
	f.remove(t, "b") // a single account, as in production
	f.result("a", "gpt-1", http.StatusBadGateway)

	if c := f.conn(t, "a"); c.State != StateActive {
		t.Fatalf("account after one 502: %s", c.State)
	}
	m := f.model(t, "gpt-1")
	wantModel(t, m, ModelDegraded, CodeUpstreamUnstable)
	if m.RetryAt == nil || m.RetryAt.After(time.Now().Add(2*time.Minute)) {
		t.Fatalf("retry_at = %v, want CPA's short transient cooldown", m.RetryAt)
	}
	wantModel(t, f.model(t, "gpt-2"), ModelAvailable, "")
	wantModel(t, f.model(t, "grok"), ModelAvailable, "")

	// No request succeeds in between: the cooldown ending is enough,
	// though CPA keeps the account in StatusError.
	f.offset = 2 * time.Minute
	if a, _ := f.auths.GetByID("a"); a.Status != coreauth.StatusError {
		t.Fatalf("CPA status = %s; the test no longer covers the sticky error", a.Status)
	}
	wantModel(t, f.model(t, "gpt-1"), ModelAvailable, "")
	if c := f.conn(t, "a"); c.State != StateActive {
		t.Fatalf("account after the cooldown: %s", c.State)
	}
}

func TestPersistent5xxNeverLocksTheModel(t *testing.T) {
	f := newFixture(t)
	f.remove(t, "b")
	for range 20 {
		f.result("a", "gpt-1", http.StatusServiceUnavailable)
		f.result("a", "gpt-2", http.StatusGatewayTimeout)
	}
	// Every model the account has tried is cooling down: still not a
	// locked account, and no cooldown grows past CPA's transient one.
	for _, id := range []string{"gpt-1", "gpt-2"} {
		m := f.model(t, id)
		wantModel(t, m, ModelDegraded, CodeUpstreamUnstable)
		if m.RetryAt == nil || m.RetryAt.After(time.Now().Add(2*time.Minute)) {
			t.Fatalf("%s retry_at = %v", id, m.RetryAt)
		}
	}
	f.offset = 2 * time.Minute
	wantModel(t, f.model(t, "gpt-1"), ModelAvailable, "")
}

func TestASuccessClearsTheModel(t *testing.T) {
	f := newFixture(t)
	f.result("a", "gpt-1", http.StatusBadGateway)
	f.result("a", "gpt-1", 0)
	f.remove(t, "b")
	wantModel(t, f.model(t, "gpt-1"), ModelAvailable, "")
}

func TestDefinitiveErrorsKeepTheirReasonAndScope(t *testing.T) {
	f := newFixture(t)
	f.remove(t, "b")
	f.result("a", "gpt-2", http.StatusNotFound)
	wantModel(t, f.model(t, "gpt-2"), ModelUnavailable, CodeModelNotFound)
	wantModel(t, f.model(t, "gpt-1"), ModelAvailable, "")

	f.result("a", "gpt-1", http.StatusUnauthorized)
	if c := f.conn(t, "a"); c.State != StateNeedsLogin {
		t.Fatalf("account after a 401: %s", c.State)
	}
	wantModel(t, f.model(t, "gpt-1"), ModelUnavailable, CodeLoginExpired)
	// Another provider is not affected.
	wantModel(t, f.model(t, "grok"), ModelAvailable, "")
	if c := f.conn(t, "x"); c.State != StateActive {
		t.Fatalf("xAI account: %s", c.State)
	}
}

func TestAnotherAccountKeepsTheModel(t *testing.T) {
	f := newFixture(t)
	f.result("a", "gpt-1", http.StatusUnauthorized)
	wantModel(t, f.model(t, "gpt-1"), ModelAvailable, "")
	// gpt-2 is only on a.
	wantModel(t, f.model(t, "gpt-2"), ModelUnavailable, CodeLoginExpired)
}

func TestRefreshChecksEachAccountOnceForConcurrentCalls(t *testing.T) {
	f := newFixture(t)
	release := make(chan struct{})
	f.codex.read = func(context.Context) error { <-release; return nil }

	var wg sync.WaitGroup
	results := make([]Status, 5)
	for i := range results {
		wg.Add(1)
		go func() {
			defer wg.Done()
			s, err := f.s.Refresh(context.Background())
			if err != nil {
				t.Error(err)
			}
			results[i] = s
		}()
	}
	// Let every caller join before the round finishes.
	waitUntil(t, func() bool { return f.codex.calls.Load() == 2 })
	time.Sleep(20 * time.Millisecond)
	close(release)
	wg.Wait()
	if n := f.codex.calls.Load(); n != 2 {
		t.Fatalf("codex usage read %d times for 2 accounts", n)
	}
	for _, s := range results {
		if len(s.Connections) != 3 || len(s.Models) != 3 || len(s.Usage) != 3 {
			t.Fatalf("status = %+v", s)
		}
		for _, c := range s.Connections {
			if c.CheckedAt == nil || c.CheckError != nil {
				t.Fatalf("%s not checked: %+v", c.ID, c)
			}
		}
	}

	// A caller that gives up does not cancel the round for the others.
	ctx, cancel := context.WithCancel(context.Background())
	f.codex.read = func(ctx context.Context) error { time.Sleep(30 * time.Millisecond); return ctx.Err() }
	go func() { time.Sleep(5 * time.Millisecond); cancel() }()
	if _, err := f.s.Refresh(ctx); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled refresh: %v", err)
	}
	s, _ := f.s.Refresh(context.Background())
	for _, c := range s.Connections {
		if c.CheckError != nil {
			t.Fatalf("%s: %+v", c.ID, c.CheckError)
		}
	}
}

func TestFailedCheckDoesNotTakeModelsDown(t *testing.T) {
	f := newFixture(t)
	f.codex.read = func(context.Context) error {
		return &UserError{Code: CodeUsageUnavailable, Message: "x", Cause: errors.New("status 502")}
	}
	s, err := f.s.Refresh(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range s.Connections {
		if c.State != StateActive {
			t.Fatalf("%s: %s after a failed check", c.ID, c.State)
		}
		if c.Connector == "codex" && (c.CheckError == nil || c.CheckError.Code != CodeCheckFailed) {
			t.Fatalf("%s check error = %+v", c.ID, c.CheckError)
		}
	}
	for _, m := range s.Models {
		wantModel(t, m, ModelAvailable, "")
	}
}

func TestRejectedLoginCheck(t *testing.T) {
	f := newFixture(t)
	f.remove(t, "b")
	f.codex.read = func(context.Context) error { return &UserError{Code: CodeLoginExpired, Message: "x"} }
	if _, err := f.s.Refresh(context.Background()); err != nil {
		t.Fatal(err)
	}
	// Refreshing the token (no executor here) failed too.
	if n := f.codex.calls.Load(); n != 1 {
		t.Fatalf("usage read %d times", n)
	}
	if c := f.conn(t, "a"); c.State != StateNeedsLogin {
		t.Fatalf("account after a rejected check: %s", c.State)
	}
	wantModel(t, f.model(t, "gpt-1"), ModelUnavailable, CodeLoginExpired)

	// A request that succeeds afterwards is newer news than the check.
	time.Sleep(5 * time.Millisecond)
	f.result("a", "gpt-1", 0)
	if c := f.conn(t, "a"); c.State != StateActive {
		t.Fatalf("account after a later success: %s", c.State)
	}
}

func TestLateCheckDoesNotOverwriteNewerOne(t *testing.T) {
	f := newFixture(t)
	now := time.Now()
	f.s.record("a", check{started: now, done: now.Add(time.Second)})
	f.s.record("a", check{started: now.Add(-time.Second), done: now.Add(2 * time.Second), err: &Problem{Code: CodeLoginExpired}})
	if c := f.conn(t, "a"); c.State != StateActive || c.CheckError != nil {
		t.Fatalf("older check won: %+v", c)
	}
}

func waitUntil(t *testing.T, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatal("condition not met in time")
		}
		time.Sleep(time.Millisecond)
	}
}
