// Package testenv gives tests a database of their own: a fresh PostgreSQL
// database per test binary on the development server (DATABASE_URL, default
// axp-dev-postgres), migrated once and emptied before every test.
package testenv

import (
	"context"
	"fmt"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/akarachen/axp/apps/control-plane/internal/store"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

var pool *pgxpool.Pool

// Main runs the package's tests against a new database and drops it after.
func Main(m *testing.M) {
	code, err := run(m)
	if err != nil {
		fmt.Fprintln(os.Stderr, "testenv:", err)
		os.Exit(1)
	}
	os.Exit(code)
}

func run(m *testing.M) (int, error) {
	ctx := context.Background()
	base := os.Getenv("DATABASE_URL")
	if base == "" {
		base = "postgres://axp:axp@127.0.0.1:15432/axp"
	}
	admin, err := pgx.Connect(ctx, base)
	if err != nil {
		return 0, err
	}
	defer admin.Close(ctx)
	name := fmt.Sprintf("axp_test_%d_%d", os.Getpid(), time.Now().UnixNano()%1_000_000)
	if _, err := admin.Exec(ctx, "CREATE DATABASE "+name); err != nil {
		return 0, err
	}
	defer admin.Exec(ctx, "DROP DATABASE "+name+" WITH (FORCE)") //nolint:errcheck
	u, err := url.Parse(base)
	if err != nil {
		return 0, err
	}
	u.Path = "/" + name
	if pool, err = store.Open(ctx, u.String()); err != nil {
		return 0, err
	}
	defer pool.Close()
	if err := store.Migrate(ctx, pool); err != nil {
		return 0, err
	}
	return m.Run(), nil
}

// DB is an empty database for this test.
func DB(t testing.TB) *pgxpool.Pool {
	t.Helper()
	ctx := context.Background()
	rows, err := pool.Query(ctx, `SELECT tablename FROM pg_tables
		WHERE schemaname = 'public' AND tablename <> 'schema_migration'`)
	if err != nil {
		t.Fatal(err)
	}
	tables, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, "TRUNCATE "+strings.Join(tables, ", ")+" RESTART IDENTITY CASCADE"); err != nil {
		t.Fatal(err)
	}
	return pool
}
