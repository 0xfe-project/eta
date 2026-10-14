// Package store is the control plane's schema: SQL files in goose's format,
// which pg.Migrate applies.
package store

import (
	"embed"
	"io/fs"

	"github.com/akarachen/axp/packages/service-go/pg"
)

//go:embed migrations/*.sql
var migrations embed.FS

var files, _ = fs.Sub(migrations, "migrations")

var Migrations = pg.Migrations{FS: files}
