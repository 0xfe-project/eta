// Package pgtest gives a package's tests a database of their own: a fresh
// PostgreSQL database per test binary on the development server
// (DATABASE_URL, default axp-dev-postgres), migrated once, emptied before
// every test and dropped at the end.
//
//	func TestMain(m *testing.M) { pgtest.Main(m, store.Migrations) }
//
//	func TestSomething(t *testing.T) {
//		db := pgtest.DB(t)
//		...
//	}
package pgtest

import (
	"context"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/akarachen/axp/packages/service-go/pg"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

var pool *pgxpool.Pool

// Main runs the package's tests against a new database with migrations.
func Main(m *testing.M, migrations pg.Migrations) {
	code, err := run(m, migrations)
	if err != nil {
		fmt.Fprintln(os.Stderr, "pgtest:", err)
		os.Exit(1)
	}
	os.Exit(code)
}

func run(m *testing.M, migrations pg.Migrations) (int, error) {
	ctx := context.Background()
	base := os.Getenv("DATABASE_URL")
	if base == "" {
		base = "postgres://axp:axp@127.0.0.1:15432/axp"
	}
	name := fmt.Sprintf("axp_test_%d_%d", os.Getpid(), time.Now().UnixNano()%1_000_000)
	url, err := pg.WithDatabase(base, name)
	if err != nil {
		return 0, err
	}
	if pool, err = pg.Setup(ctx, url, migrations, true); err != nil {
		return 0, err
	}
	defer func() {
		pool.Close()
		admin, err := pg.WithDatabase(base, "postgres")
		if err != nil {
			return
		}
		if conn, err := pgx.Connect(ctx, admin); err == nil {
			_, _ = conn.Exec(ctx, "DROP DATABASE "+name+" WITH (FORCE)")
			conn.Close(ctx)
		}
	}()
	return m.Run(), nil
}

// DB is the test's database, empty: every table but the migrations'
// bookkeeping is truncated.
func DB(t testing.TB) *pgxpool.Pool {
	t.Helper()
	ctx := context.Background()
	rows, err := pool.Query(ctx, `SELECT tablename FROM pg_tables WHERE schemaname = 'public'
		AND tablename NOT IN ('goose_db_version', 'service_framework_version')`)
	if err != nil {
		t.Fatal(err)
	}
	tables, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		t.Fatal(err)
	}
	if len(tables) > 0 {
		if _, err := pool.Exec(ctx, "TRUNCATE "+strings.Join(tables, ", ")+" RESTART IDENTITY CASCADE"); err != nil {
			t.Fatal(err)
		}
	}
	return pool
}
