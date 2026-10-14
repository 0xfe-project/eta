package tasks

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/akarachen/axp/apps/control-plane/internal/relay"
	"github.com/akarachen/axp/apps/control-plane/internal/store"
	"github.com/akarachen/axp/packages/service-go/pg"
	"github.com/akarachen/axp/packages/service-go/pg/pgtest"
)

func TestMain(m *testing.M) { pgtest.Main(m, store.Migrations) }

// configured is a relay dispatch never calls.
type configured struct{ relay.Relay }

// Many dispatchers at once (a tick racing another controller's, say) take
// no more of a computer's places than its limit, oldest runs first, each
// computer on its own.
func TestConcurrentDispatchersKeepToEachComputersLimit(t *testing.T) {
	db := pgtest.DB(t)
	ctx := context.Background()
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := db.Exec(ctx, sql, args...); err != nil {
			t.Fatalf("%s: %v", sql, err)
		}
	}
	start := time.Now().Add(-time.Hour)
	queue := func(computer string, n int) []string {
		var runs []string
		for range n {
			task, run := pg.NewID(), pg.NewID()
			start = start.Add(time.Second)
			exec(`INSERT INTO task (id, title, status, assignee, computer_id, runtime, provider, place, created_at, updated_at)
				VALUES ($1, 'Fix it', 'todo', 'remote', $2, 'paseo', 'claude', '{"kind": "worktree", "from": "prj"}', $3, $3)`,
				task, computer, start)
			exec(`INSERT INTO task_run (id, task_id, computer_id, runtime, provider, status, prompt, created_at)
				VALUES ($1, $2, $3, 'paseo', 'claude', 'queued', 'Go.', $4)`, run, task, computer, start)
			runs = append(runs, run)
		}
		return runs
	}
	laptop, desktop := pg.NewID(), pg.NewID()
	exec("INSERT INTO computer (id, name, created_at) VALUES ($1, 'laptop', now())", laptop)
	exec("INSERT INTO computer (id, name, created_at, max_active_runs) VALUES ($1, 'desktop', now(), 1)", desktop)
	laptopRuns := queue(laptop, 6)
	desktopRuns := queue(desktop, 3)

	var wg sync.WaitGroup
	errs := make(chan error, 100)
	for range 10 {
		r := &Runner{DB: db, Service: &Service{Relay: configured{}}}
		wg.Go(func() {
			for range 5 {
				if err := r.dispatch(ctx); err != nil {
					errs <- err
				}
			}
		})
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Fatal(err)
	}
	starting := func(runs []string) string {
		var out []string
		for _, id := range runs {
			var status string
			if err := db.QueryRow(ctx, "SELECT status FROM task_run WHERE id = $1", id).Scan(&status); err != nil {
				t.Fatal(err)
			}
			out = append(out, status)
		}
		return strings.Join(out, ",")
	}
	if got := starting(laptopRuns); got != "starting,starting,starting,queued,queued,queued" {
		t.Fatalf("laptop (limit 3): %s", got)
	}
	if got := starting(desktopRuns); got != "starting,queued,queued" {
		t.Fatalf("desktop (limit 1): %s", got)
	}
	// Each dispatcher's view is the database's: none starts more later.
	r := &Runner{DB: db, Service: &Service{Relay: configured{}}}
	if err := r.dispatch(ctx); err != nil {
		t.Fatal(err)
	}
	if got := starting(laptopRuns); got != "starting,starting,starting,queued,queued,queued" {
		t.Fatal(fmt.Sprint("after another dispatch: ", got))
	}
}

// A dispatch waits for another's claim on the same computer in progress,
// then counts it: never both under the limit on what each saw.
func TestADispatchWaitsForAnotherClaimOnTheComputer(t *testing.T) {
	db := pgtest.DB(t)
	ctx := context.Background()
	computer, task, other := pg.NewID(), pg.NewID(), pg.NewID()
	for _, step := range []struct {
		sql  string
		args []any
	}{
		{"INSERT INTO computer (id, name, created_at, max_active_runs) VALUES ($1, 'laptop', now(), 1)", []any{computer}},
		{`INSERT INTO task (id, title, status, assignee, computer_id, runtime, provider, place, created_at, updated_at)
			VALUES ($1, 'Fix it', 'todo', 'remote', $2, 'paseo', 'claude', '{"kind": "worktree", "from": "prj"}', now(), now()),
			($3, 'Other', 'todo', 'remote', $2, 'paseo', 'claude', '{"kind": "worktree", "from": "prj"}', now(), now())`,
			[]any{task, computer, other}},
		{`INSERT INTO task_run (id, task_id, computer_id, runtime, provider, status, prompt, created_at)
			VALUES (gen_random_uuid(), $1, $2, 'paseo', 'claude', 'queued', 'Go.', now())`, []any{task, computer}},
	} {
		if _, err := db.Exec(ctx, step.sql, step.args...); err != nil {
			t.Fatalf("%s: %v", step.sql, err)
		}
	}
	// Another dispatcher, mid-claim: it holds the computer and has started
	// a run that the database has not committed yet.
	claim, err := db.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer claim.Rollback(ctx)
	if _, err := claim.Exec(ctx, "SELECT 1 FROM computer WHERE id = $1 FOR NO KEY UPDATE", computer); err != nil {
		t.Fatal(err)
	}
	if _, err := claim.Exec(ctx, `INSERT INTO task_run (id, task_id, computer_id, runtime, provider, status, prompt, created_at)
		VALUES (gen_random_uuid(), $2, $1, 'paseo', 'claude', 'starting', 'Go.', now())`, computer, other); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- (&Runner{DB: db, Service: &Service{Relay: configured{}}}).dispatch(ctx) }()
	select {
	case err := <-done:
		t.Fatalf("dispatched past another's claim in progress (%v)", err)
	case <-time.After(300 * time.Millisecond):
	}
	if err := claim.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	var active int
	if err := db.QueryRow(ctx, "SELECT count(*) FROM task_run WHERE status IN ('starting', 'running')").Scan(&active); err != nil {
		t.Fatal(err)
	}
	if active != 1 {
		t.Fatalf("%d runs active on a computer with a limit of 1", active)
	}
}
