// Package store is the control plane's PostgreSQL: the connection pool,
// transactions and the schema's migrations.
package store

import (
	"context"
	"database/sql"
	"embed"
	"errors"
	"io/fs"

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

// Open connects to url.
func Open(ctx context.Context, url string) (*pgxpool.Pool, error) {
	config, err := pgxpool.ParseConfig(url)
	if err != nil {
		return nil, err
	}
	return pgxpool.NewWithConfig(ctx, config)
}

// InTx runs fn in a transaction, committed when fn returns nil.
func InTx(ctx context.Context, pool *pgxpool.Pool, fn func(pgx.Tx) error) error {
	return pgx.BeginFunc(ctx, pool, fn)
}

// IsUniqueViolation reports whether err is a unique constraint violation.
func IsUniqueViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23505"
}

//go:embed migrations/*.sql
var migrations embed.FS

//go:embed django.sql
var djangoSchema string

// Migrate applies the migrations not applied yet (goose, under a session
// lock). Migration 1 is the schema as Django left it; a database Django
// migrated already has it.
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
	baseline := goose.NewGoMigration(1, &goose.GoFunc{RunTx: func(ctx context.Context, tx *sql.Tx) error {
		var exists bool
		if err := tx.QueryRowContext(ctx, "SELECT to_regclass('conversation') IS NOT NULL").Scan(&exists); err != nil || exists {
			return err
		}
		_, err := tx.ExecContext(ctx, djangoSchema)
		return err
	}}, nil)
	provider, err := goose.NewProvider(goose.DialectPostgres, db, fsys,
		goose.WithSessionLocker(locker), goose.WithGoMigrations(baseline))
	if err != nil {
		return err
	}
	_, err = provider.Up(ctx)
	return err
}
