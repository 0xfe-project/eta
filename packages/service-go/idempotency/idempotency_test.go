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
				return Do(ctx, pool, in.IdempotencyKey, in.Body, func(pgx.Tx) (Result[note], error) {
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
			return Do(ctx, pool, in.IdempotencyKey, in.Body, func(tx pgx.Tx) (Result[note], error) {
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

func TestPruneForgetsKeysPastTheirRetention(t *testing.T) {
	pool := pgtest.DB(t)
	ctx := context.Background()
	for key, age := range map[string]string{"old": "8 days", "new": "1 day"} {
		if _, err := pool.Exec(ctx, `INSERT INTO api_idempotency (id, method, canonical_path, key, request_hash,
			response_status, response_body, created_at) VALUES (gen_random_uuid(), 'POST', '/api/notes', $1, '', 201, '{}',
			now() - $2::interval)`, key, age); err != nil {
			t.Fatal(err)
		}
	}
	if err := Prune(ctx, pool, time.Now()); err != nil {
		t.Fatal(err)
	}
	var keys []string
	rows, _ := pool.Query(ctx, "SELECT key FROM api_idempotency")
	keys, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil || len(keys) != 1 || keys[0] != "new" {
		t.Fatalf("%v %v", keys, err)
	}
}
