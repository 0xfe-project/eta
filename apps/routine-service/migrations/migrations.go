// Package migrations is the routine service's schema (goose's SQL format),
// applied by pg.Migrate when the service starts.
package migrations

import (
	"embed"
	"io/fs"

	"github.com/akarachen/axp/packages/service-go/pg"
)

//go:embed *.sql
var files embed.FS

var All = pg.Migrations{FS: fs.FS(files)}
