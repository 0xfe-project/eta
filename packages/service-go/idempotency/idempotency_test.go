package idempotency

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

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
	huma.Register(api, httpapi.Op("addNote", http.MethodPost, "/api/notes", "Add", 201, []int{400, 409}),
		func(ctx context.Context, in *struct {
			Keyed
			Body noteIn
		}) (*Response[note], error) {
			return Do(ctx, pool, in.IdempotencyKey, in.Body, func(pgx.Tx) (Result[note], error) {
				n := note{Text: in.Body.Text, N: runs.Add(1)}
				return Created(&n, "note-1"), nil
			})
		})
	post := func(key, body string) (int, string) {
		req := httptest.NewRequest(http.MethodPost, "/api/notes", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		if key != "" {
			req.Header.Set("Idempotency-Key", key)
		}
		w := httptest.NewRecorder()
		api.Router.ServeHTTP(w, req)
		return w.Code, strings.TrimSpace(w.Body.String())
	}
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
	if status, body := post("", `{"text": "hi"}`); status != 400 || !strings.Contains(body, "IDEMPOTENCY_KEY_REQUIRED") {
		t.Fatalf("no key %d %s", status, body)
	}
	if runs.Load() != 1 {
		t.Fatalf("ran %d times", runs.Load())
	}
}
