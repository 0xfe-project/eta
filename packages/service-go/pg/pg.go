// Package pg is a service's PostgreSQL: its connection pool, its schema's
// migrations, transactions and the helpers queries are written with.
//
// Each service owns its database. Domain code takes a DB (the pool or a
// transaction) and writes SQL directly; rows map onto structs by their `db`
// tags.
package pg

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io/fs"
	"net/url"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"
	"github.com/pressly/goose/v3/database"
	"github.com/pressly/goose/v3/lock"
)

// DB is what queries run on: the pool or a transaction.
type DB interface {
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

// Open connects to the database at rawURL.
func Open(ctx context.Context, rawURL string) (*pgxpool.Pool, error) {
	config, err := pgxpool.ParseConfig(rawURL)
	if err != nil {
		return nil, err
	}
	return pgxpool.NewWithConfig(ctx, config)
}

// Create creates the database rawURL names, unless the server has it. It
// connects to the server's postgres database to do so.
func Create(ctx context.Context, rawURL string) error {
	u, err := url.Parse(rawURL)
	if err != nil {
		return err
	}
	name := strings.TrimPrefix(u.Path, "/")
	if name == "" {
		return errors.New("the database URL names no database")
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

// WithDatabase is rawURL naming database name instead, on the same server.
func WithDatabase(rawURL, name string) (string, error) {
	u, err := url.Parse(rawURL)
	if err != nil {
		return "", err
	}
	u.Path = "/" + name
	return u.String(), nil
}

// Migrations is a service's schema: SQL files in goose's format.
type Migrations struct {
	FS fs.FS
}

// Migrate applies the service's migrations, then the framework's (its own
// tables, such as idempotency keys), each under a PostgreSQL session lock so
// that concurrent starts take turns. Each keeps its own version table.
func Migrate(ctx context.Context, pool *pgxpool.Pool, service Migrations) error {
	db := stdlib.OpenDBFromPool(pool)
	defer db.Close()
	if service.FS != nil {
		if err := up(ctx, db, service.FS, goose.DefaultTablename); err != nil {
			return err
		}
	}
	if err := up(ctx, db, framework, "service_framework_version"); err != nil {
		return fmt.Errorf("framework migrations: %w", err)
	}
	return nil
}

func up(ctx context.Context, db *sql.DB, fsys fs.FS, table string) error {
	locker, err := lock.NewPostgresSessionLocker()
	if err != nil {
		return err
	}
	store, err := database.NewStore(goose.DialectPostgres, table)
	if err != nil {
		return err
	}
	provider, err := goose.NewProvider("", db, fsys, goose.WithStore(store), goose.WithSessionLocker(locker))
	if err != nil {
		return err
	}
	_, err = provider.Up(ctx)
	return err
}

// Setup opens the database at url, migrated: what a service that owns its
// schema does when it starts. create creates the database first when the
// server has none by that name.
func Setup(ctx context.Context, url string, migrations Migrations, create bool) (*pgxpool.Pool, error) {
	if create {
		if err := Create(ctx, url); err != nil {
			return nil, err
		}
	}
	pool, err := Open(ctx, url)
	if err != nil {
		return nil, err
	}
	if err := Migrate(ctx, pool, migrations); err != nil {
		pool.Close()
		return nil, fmt.Errorf("migrate: %w", err)
	}
	return pool, nil
}

// InTx runs fn in a transaction, committed when fn returns nil.
func InTx(ctx context.Context, pool *pgxpool.Pool, fn func(pgx.Tx) error) error {
	return pgx.BeginFunc(ctx, pool, fn)
}

// InTxValue runs fn in a transaction and returns its result.
func InTxValue[T any](ctx context.Context, pool *pgxpool.Pool, fn func(pgx.Tx) (T, error)) (T, error) {
	var out T
	err := pgx.BeginFunc(ctx, pool, func(tx pgx.Tx) error {
		var err error
		out, err = fn(tx)
		return err
	})
	return out, err
}

// One is the row sql selects as T, or nil when there is none.
func One[T any](ctx context.Context, db DB, sql string, args ...any) (*T, error) {
	rows, err := db.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	row, err := pgx.CollectOneRow(rows, pgx.RowToAddrOfStructByName[T])
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	return row, err
}

// All is the rows sql selects, as T.
func All[T any](ctx context.Context, db DB, sql string, args ...any) ([]*T, error) {
	rows, err := db.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowToAddrOfStructByName[T])
}

// Exists reports whether sql selects a row.
func Exists(ctx context.Context, db DB, sql string, args ...any) (bool, error) {
	var exists bool
	err := db.QueryRow(ctx, "SELECT EXISTS ("+sql+")", args...).Scan(&exists)
	return exists, err
}

// NewID is a new row id (a UUID).
func NewID() string { return uuid.NewString() }

// ParseID is id as a canonical UUID, or false: ids from requests go through
// it before they reach SQL.
func ParseID(id string) (string, bool) {
	parsed, err := uuid.Parse(id)
	if err != nil {
		return "", false
	}
	return parsed.String(), true
}

// Now is the current time, at the database's precision.
func Now() time.Time { return time.Now().UTC().Truncate(time.Microsecond) }
