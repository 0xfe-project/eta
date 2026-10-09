package idempotency

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/akarachen/axp/packages/service-go/apierr"
	"github.com/akarachen/axp/packages/service-go/httpapi"
	"github.com/akarachen/axp/packages/service-go/pg"
	"github.com/akarachen/axp/packages/service-go/pg/pgtest"
	"github.com/danielgtaylor/huma/v2"
	"github.com/jackc/pgx/v5"
)

func TestMain(m *testing.M) { pgtest.Main(m, pg.Migrations{}) }

type noteIn struct {
	Text string `json:"text"`
}

type note struct {
	Text string `json:"text"`
	N    int64  `json:"n"`
}

func TestARetryGetsTheFirstResponse(t *testing.T) {
	pool := pgtest.DB(t)
	var runs atomic.Int64
	api := httpapi.New(httpapi.Config{Title: "Test", Version: "1", Prefix: "/api"})
	for _, path := range []string{"/api/notes", "/api/drafts"} {
		huma.Register(api, httpapi.Op("add"+path[5:], http.MethodPost, path, "Add", 201, []int{400, 409}),
			func(ctx context.Context, in *struct {
				Keyed
				Body noteIn
			}) (*Response[note], error) {
				return Do(ctx, pool, in.IdempotencyKey, in.Body, func(context.Context, pgx.Tx) (Result[note], error) {
					n := note{Text: in.Body.Text, N: runs.Add(1)}
					return Created(&n, "note-1"), nil
				})
			})
	}
	postTo := func(path, key, body string) (int, string) {
		req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		if key != "" {
			req.Header.Set("Idempotency-Key", key)
		}
		w := httptest.NewRecorder()
		api.Router.ServeHTTP(w, req)
		return w.Code, strings.TrimSpace(w.Body.String())
	}
	post := func(key, body string) (int, string) { return postTo("/api/notes", key, body) }
	status, first := post("k1", `{"text": "hi"}`)
	if status != 201 || !strings.Contains(first, `"n":1`) {
		t.Fatalf("%d %s", status, first)
	}
	if status, again := post("k1", `{"text":"hi"}`); status != 201 || again != first {
		t.Fatalf("replay %d %s", status, again)
	}
	if status, body := post("k1", `{"text": "other"}`); status != 409 || !strings.Contains(body, "IDEMPOTENCY_KEY_REUSED") {
		t.Fatalf("reuse %d %s", status, body)
	}
	for _, key := range []string{"", "   "} {
		if status, body := post(key, `{"text": "hi"}`); status != 400 || !strings.Contains(body, "IDEMPOTENCY_KEY_REQUIRED") {
			t.Fatalf("key %q: %d %s", key, status, body)
		}
	}
	if runs.Load() != 1 {
		t.Fatalf("ran %d times", runs.Load())
	}
	// A key is per path.
	if status, body := postTo("/api/drafts", "k1", `{"text": "other"}`); status != 201 || !strings.Contains(body, `"n":2`) {
		t.Fatalf("other path %d %s", status, body)
	}
}

func TestAFailureDoesNotUseUpTheKey(t *testing.T) {
	pool := pgtest.DB(t)
	var runs atomic.Int64
	api := httpapi.New(httpapi.Config{Title: "Test", Version: "1", Prefix: "/api"})
	huma.Register(api, httpapi.Op("addNote", http.MethodPost, "/api/notes", "Add", 201, []int{503}),
		func(ctx context.Context, in *struct {
			Keyed
			Body noteIn
		}) (*Response[note], error) {
			return Do(ctx, pool, in.IdempotencyKey, in.Body, func(ctx context.Context, tx pgx.Tx) (Result[note], error) {
				// Written, then rolled back with the failure.
				if _, err := tx.Exec(ctx, "CREATE TABLE written (id int)"); err != nil {
					return Result[note]{}, err
				}
				if runs.Add(1) == 1 {
					return Result[note]{}, apierr.New(503, "DOWN", "down")
				}
				return Created(&note{Text: in.Body.Text, N: runs.Load()}, "note-1"), nil
			})
		})
	post := func() (int, string) {
		req := httptest.NewRequest(http.MethodPost, "/api/notes", strings.NewReader(`{"text": "hi"}`))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Idempotency-Key", "k1")
		w := httptest.NewRecorder()
		api.Router.ServeHTTP(w, req)
		return w.Code, strings.TrimSpace(w.Body.String())
	}
	if status, body := post(); status != 503 {
		t.Fatalf("first %d %s", status, body)
	}
	if status, body := post(); status != 201 || !strings.Contains(body, `"n":2`) {
		t.Fatalf("retry %d %s", status, body)
	}
}

// Two requests with one key at the same time: the second waits for the
// first and gets its response; the operation runs once.
func TestConcurrentRequestsWithOneKeyRunOnce(t *testing.T) {
	pool := pgtest.DB(t)
	var runs atomic.Int64
	started, release := make(chan struct{}), make(chan struct{})
	do := func() (*Response[note], error) {
		return Do(context.Background(), pool, "k1", noteIn{"hi"}, func(context.Context, pgx.Tx) (Result[note], error) {
			n := note{Text: "hi", N: runs.Add(1)}
			if n.N == 1 {
				close(started)
			}
			<-release
			return Created(&n, "note-1"), nil
		})
	}
	type answer struct {
		r   *Response[note]
		err error
	}
	first, second := make(chan answer, 1), make(chan answer, 1)
	go func() { r, err := do(); first <- answer{r, err} }()
	<-started
	go func() { r, err := do(); second <- answer{r, err} }()
	time.Sleep(200 * time.Millisecond)
	if n := runs.Load(); n != 1 {
		t.Fatalf("the second request ran too (%d runs) while the first was running", n)
	}
	close(release)
	a, b := <-first, <-second
	if a.err != nil || b.err != nil {
		t.Fatal(a.err, b.err)
	}
	if runs.Load() != 1 || b.r.Status != 201 || b.r.Body != a.r.Body {
		t.Fatalf("runs %d, %+v then %+v", runs.Load(), a.r, b.r)
	}
}

// The client goes away after the operation did something the database
// cannot undo (a published command): the rest of it still runs and commits.
func TestTheClientLeavingDoesNotRollBack(t *testing.T) {
	pool := pgtest.DB(t)
	request, leave := context.WithCancel(context.Background())
	defer leave()
	_, err := Do(request, pool, "k1", noteIn{"hi"}, func(ctx context.Context, tx pgx.Tx) (Result[note], error) {
		if _, err := tx.Exec(ctx, "CREATE TABLE published (id int)"); err != nil {
			return Result[note]{}, err
		}
		leave()
		if _, err := tx.Exec(ctx, "INSERT INTO published VALUES (1)"); err != nil {
			return Result[note]{}, err
		}
		return Created(&note{Text: "hi", N: 1}, "note-1"), nil
	})
	if err != nil {
		t.Fatal(err)
	}
	var rows, keys int
	if err := pool.QueryRow(context.Background(), "SELECT count(*) FROM published").Scan(&rows); err != nil || rows != 1 {
		t.Fatalf("%d rows %v", rows, err)
	}
	if err := pool.QueryRow(context.Background(), "SELECT count(*) FROM api_idempotency").Scan(&keys); err != nil || keys != 1 {
		t.Fatalf("%d keys %v", keys, err)
	}
	if _, err := pool.Exec(context.Background(), "DROP TABLE published"); err != nil {
		t.Fatal(err)
	}
}
