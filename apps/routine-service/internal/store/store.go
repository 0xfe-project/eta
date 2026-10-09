// Package store is the routine service's PostgreSQL database: its own,
// created when it is missing, with the schema's migrations.
package store

import (
	"context"
	"embed"
	"errors"
	"fmt"
	"io/fs"
	"net/url"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"
	"github.com/pressly/goose/v3/lock"
)

// DB is what queries run on: the pool or a transaction.
type DB interface {
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

// Open connects to the database at rawURL, creating it first when the
// server has none by that name.
func Open(ctx context.Context, rawURL string) (*pgxpool.Pool, error) {
	if err := create(ctx, rawURL); err != nil {
		return nil, err
	}
	return pgxpool.New(ctx, rawURL)
}

func create(ctx context.Context, rawURL string) error {
	u, err := url.Parse(rawURL)
	if err != nil {
		return err
	}
	name := strings.TrimPrefix(u.Path, "/")
	if name == "" {
		return fmt.Errorf("the database URL names no database")
	}
	u.Path = "/postgres"
	admin, err := pgx.Connect(ctx, u.String())
	if err != nil {
		return err
	}
	defer admin.Close(ctx)
	var exists bool
	if err := admin.QueryRow(ctx, "SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = $1)", name).Scan(&exists); err != nil || exists {
		return err
	}
	_, err = admin.Exec(ctx, "CREATE DATABASE "+pgx.Identifier{name}.Sanitize())
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "42P04" { // created meanwhile
		return nil
	}
	return err
}

//go:embed migrations/*.sql
var migrations embed.FS

// Migrate applies the migrations not applied yet (goose, under a session
// lock).
func Migrate(ctx context.Context, pool *pgxpool.Pool) error {
	db := stdlib.OpenDBFromPool(pool)
	defer db.Close()
	locker, err := lock.NewPostgresSessionLocker()
	if err != nil {
		return err
	}
	fsys, err := fs.Sub(migrations, "migrations")
	if err != nil {
		return err
	}
	provider, err := goose.NewProvider(goose.DialectPostgres, db, fsys, goose.WithSessionLocker(locker))
	if err != nil {
		return err
	}
	_, err = provider.Up(ctx)
	return err
}

// InTx runs fn in a transaction, committed when fn returns nil.
func InTx(ctx context.Context, pool *pgxpool.Pool, fn func(pgx.Tx) error) error {
	return pgx.BeginFunc(ctx, pool, fn)
}

// One is the first row as T, or nil.
func One[T any](ctx context.Context, db DB, sql string, args ...any) (*T, error) {
	rows, err := db.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	row, err := pgx.CollectOneRow(rows, pgx.RowToAddrOfStructByNameLax[T])
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	return row, err
}

// All is every row as T.
func All[T any](ctx context.Context, db DB, sql string, args ...any) ([]*T, error) {
	rows, err := db.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowToAddrOfStructByNameLax[T])
}

// Exists reports whether the query returns a row.
func Exists(ctx context.Context, db DB, sql string, args ...any) (bool, error) {
	var exists bool
	err := db.QueryRow(ctx, "SELECT EXISTS ("+sql+")", args...).Scan(&exists)
	return exists, err
}
