// Package store is the control plane's schema: migration 1 is the schema as
// Django left it (a database Django migrated already has it), the rest are
// SQL files. pg.Migrate applies them.
package store

import (
	"context"
	"database/sql"
	"embed"
	"io/fs"

	"github.com/akarachen/axp/packages/service-go/pg"
	"github.com/pressly/goose/v3"
)

//go:embed migrations/*.sql
var migrations embed.FS

//go:embed django.sql
var djangoSchema string

var files, _ = fs.Sub(migrations, "migrations")

var Migrations = pg.Migrations{
	FS: files,
	Go: []*goose.Migration{goose.NewGoMigration(1, &goose.GoFunc{RunTx: func(ctx context.Context, tx *sql.Tx) error {
		var exists bool
		if err := tx.QueryRowContext(ctx, "SELECT to_regclass('conversation') IS NOT NULL").Scan(&exists); err != nil || exists {
			return err
		}
		_, err := tx.ExecContext(ctx, djangoSchema)
		return err
	}}, nil)},
}
